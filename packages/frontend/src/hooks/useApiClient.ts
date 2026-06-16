import { useCallback, useMemo } from 'react';
import { useAuth } from 'react-oidc-context';
import createClient from 'openapi-fetch';
import { useRuntimeConfig } from './useRuntimeConfig';
import type { paths } from '../generated/api';

export interface StreamEvent {
  type:
    | 'text'
    | 'tool_use'
    | 'tool_result'
    | 'complete'
    | 'stage_start'
    | 'stage_complete'
    | 'error';
  content?: string | ToolResultContent[];
  name?: string;
  tool_use_id?: string;
  input?: string;
  stage?: string;
  result?: string;
}

export interface ToolResultContent {
  type: string;
  text?: string;
  format?: string;
  source?: string;
  s3_url?: string | null;
  image?: {
    format?: string;
    source?: { bytes?: string };
  };
}

export interface ContentSource {
  base64: string;
}

export interface ImageContent {
  format: string;
  source: ContentSource;
}

export interface DocumentContent {
  format: string;
  name: string;
  source: ContentSource;
}

export interface ContentBlock {
  image?: ImageContent;
  document?: DocumentContent;
  text?: string;
}

/** SSE 스트림 파싱 (`data: {json}\n\n`, `: ping` 하트비트 무시) */
async function parseSseStream(
  response: Response,
  onEvent?: (event: StreamEvent) => void,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let result = '';
  let buffer = '';
  // 에이전트는 생성 종료 시 `complete` 이벤트를 보낸다. 이를 명시적 종료
  // 신호로 사용한다 — HTTP 스트림이 곧바로 닫히지 않아도(AgentCore body가
  // 늦게 닫히거나 프록시가 keep-alive 로 연결을 유지하는 경우) 클라이언트가
  // 무한히 "작성중" 상태에 갇히지 않도록 한다.
  let completed = false;

  const handleLine = (line: string) => {
    // SSE 주석(하트비트) 무시
    if (line.startsWith(':')) return;
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    try {
      const event = JSON.parse(payload) as StreamEvent;
      onEvent?.(event);
      if (event.type === 'text' && typeof event.content === 'string') {
        result += event.content;
      }
      if (event.type === 'complete') {
        completed = true;
      }
    } catch {
      // 파싱 실패 시 무시
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE 이벤트는 빈 줄로 구분되지만, 단일 라인 data 프레임도 처리한다.
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIdx).replace(/\r$/, '');
        buffer = buffer.slice(newlineIdx + 1);
        handleLine(line);
      }

      // `complete` 수신 즉시 종료한다. 남은 transport close 를 기다리지 않는다.
      if (completed) break;
    }
  } finally {
    // 조기 종료(complete) 시 미사용 스트림을 정리해 연결을 해제한다.
    reader.cancel().catch(() => undefined);
  }

  if (!completed && buffer) handleLine(buffer.replace(/\r$/, ''));

  return result;
}

export function useApiClient() {
  const { apis, voiceEnabled } = useRuntimeConfig();
  const { user } = useAuth();

  /**
   * 타입 안전한 openapi-fetch 클라이언트. 백엔드 OpenAPI 스펙에서 생성된
   * `paths` 타입을 사용하므로 경로/파라미터/응답이 컴파일 타임에 검증된다.
   * 신규/마이그레이션 훅은 `fetchApi`(수기 타입) 대신 이 클라이언트를 권장한다.
   *
   * 예) const { data } = await api.GET('/projects');
   */
  const api = useMemo(() => {
    const client = createClient<paths>({
      baseUrl: (apis?.Backend as string) ?? '',
    });
    client.use({
      onRequest({ request }) {
        if (user?.access_token) {
          request.headers.set('Authorization', `Bearer ${user.access_token}`);
        }
        return request;
      },
    });
    return client;
  }, [apis, user]);

  /**
   * Backend REST API 호출 (JWT Bearer). 레거시 경로 — 점진적으로 `api`(openapi-fetch)
   * 로 이전한다. 시그니처는 기존 훅 호환을 위해 유지.
   */
  const fetchApi = useCallback(
    async <T>(path: string, options?: RequestInit): Promise<T> => {
      if (!apis?.Backend) throw new Error('Backend API URL not available');
      if (!user?.access_token) throw new Error('User token not available');

      const headers = new Headers(options?.headers);
      headers.set('Authorization', `Bearer ${user.access_token}`);
      if (!headers.has('Content-Type') && options?.body) {
        headers.set('Content-Type', 'application/json');
      }

      const response = await fetch(`${apis.Backend as string}${path}`, {
        ...options,
        headers,
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      return response.json();
    },
    [apis, user],
  );

  /**
   * Backend SSE 채팅 프록시 호출. 백엔드가 Bedrock AgentCore를 대신 호출하고
   * 이벤트를 SSE로 중계한다. invokeAgent와 동일한 시그니처를 유지한다.
   */
  const invokeAgent = useCallback(
    async (
      prompt: ContentBlock[],
      sessionId: string,
      projectId: string,
      onEvent?: (event: StreamEvent) => void,
      agentId?: string,
      runtimeArn?: string,
    ): Promise<string> => {
      const streamBase = (apis?.BackendStream ?? apis?.Backend) as
        | string
        | undefined;
      if (!streamBase) throw new Error('Backend stream URL not available');
      if (!user?.access_token) throw new Error('User token not available');

      const response = await fetch(
        `${streamBase}/chat/projects/${projectId}/invoke`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${user.access_token}`,
            Accept: 'text/event-stream',
          },
          body: JSON.stringify({
            prompt,
            session_id: sessionId,
            agent_id: agentId,
            runtime_arn: runtimeArn,
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Agent error: ${response.status} - ${errorText}`);
      }

      return parseSseStream(response, onEvent);
    },
    [apis, user],
  );

  /**
   * 리소스별 다운로드 URL을 백엔드에서 발급받는다.
   * (기존 client-side S3 presign 대체. 타입 안전한 openapi-fetch 사용 예시.)
   */
  const getArtifactDownloadUrl = useCallback(
    async (artifactId: string): Promise<string> => {
      const { data, error } = await api.GET(
        '/artifacts/{artifact_id}/download-url',
        { params: { path: { artifact_id: artifactId } } },
      );
      if (error || !data)
        throw new Error('Failed to get artifact download URL');
      return data.url;
    },
    [api],
  );

  const getDocumentDownloadUrl = useCallback(
    async (projectId: string, documentId: string): Promise<string> => {
      const { data, error } = await api.GET(
        '/projects/{project_id}/documents/{document_id}/download-url',
        {
          params: {
            path: { project_id: projectId, document_id: documentId },
          },
        },
      );
      if (error || !data)
        throw new Error('Failed to get document download URL');
      return data.url;
    },
    [api],
  );

  /** 음성 세션용 단기 presigned wss URL 발급 */
  const getVoiceConnectionUrl = useCallback(async (): Promise<string> => {
    const { data, error } = await api.POST('/voice/connection');
    if (error || !data) throw new Error('Failed to create voice connection');
    return data.ws_url;
  }, [api]);

  return {
    api,
    fetchApi,
    invokeAgent,
    getArtifactDownloadUrl,
    getDocumentDownloadUrl,
    getVoiceConnectionUrl,
    voiceAvailable: voiceEnabled ?? false,
    userId: user?.profile?.['cognito:username'] as string | undefined,
  };
}
