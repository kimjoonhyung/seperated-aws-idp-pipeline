---
title: 백엔드 API (프론트엔드 독립)
description: 어떤 프론트엔드든 HTTP + JWT만으로 독립 IDP 백엔드를 사용하는 방법
---

백엔드는 독립적인 API-first 서비스입니다. 웹·모바일·데스크톱·CLI 등 **어떤
프론트엔드든 표준 HTTP와 Cognito JWT만으로** 백엔드를 호출할 수 있습니다.
클라이언트에 AWS SDK, SigV4 서명, AWS 서비스 직접 접근이 전혀 필요하지 않습니다.

## 인증

모든 요청은 Cognito **access token**을 Bearer 토큰으로 전달해 인증합니다.

```
Authorization: Bearer <access_token>
```

토큰은 Cognito User Pool에서 발급받습니다(Hosted UI / OAuth code grant, 또는
테스트용 `InitiateAuth`). API Gateway가 JWT authorizer로 토큰을 검증하고,
FastAPI 백엔드가 다시 한 번 독립적으로 검증합니다(issuer, `token_use == "access"`,
`client_id`, 만료). 사용자 신원은 토큰의 `username` claim에서 파생되므로,
클라이언트는 사용자 ID를 직접 보내지 않습니다.

대표 수용 기준 (AWS SDK 미사용):

```bash
TOKEN=$(aws cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH \
  --client-id "$CLIENT_ID" \
  --auth-parameters USERNAME=...,PASSWORD=... \
  --query 'AuthenticationResult.AccessToken' --output text)

curl -H "Authorization: Bearer $TOKEN" "$BACKEND_URL/projects"   # 200 JSON
curl "$BACKEND_URL/projects"                                     # 401
```

## 엔드포인트

두 개의 베이스 URL은 프론트엔드 `runtime-config.json`(`apis.Backend`,
`apis.BackendStream`)과 SSM 파라미터(`/idp-v2/backend/url`,
`/idp-v2/backend/stream-url`)로 제공됩니다.

| 용도 | 메서드 & 경로 | 베이스 |
|---|---|---|
| 프로젝트 / 문서 / 워크플로우 / 에이전트 / 프롬프트 / 아티팩트 / 그래프 / sagemaker | 각 라우터의 REST | `Backend` |
| 문서 업로드 | `POST /projects/{pid}/documents` → presigned S3 `PUT` URL | `Backend` |
| 문서 다운로드 | `GET /projects/{pid}/documents/{did}/download-url` | `Backend` |
| 아티팩트 다운로드 | `GET /artifacts/{aid}/download-url` | `Backend` |
| AI 채팅 (스트리밍) | `POST /chat/projects/{pid}/invoke` → SSE | `BackendStream` |
| 음성 세션 | `POST /voice/connection` → presigned `wss://` URL | `Backend` |
| 워크플로우 알림 | WebSocket `?token=<access_token>` | `websocketUrl` |

전체 계약(contract)은 FastAPI OpenAPI 스펙이며
`dist/packages/backend/openapi/openapi.json`으로 내보내집니다
(`nx run idp_v2.backend:openapi`).

### 타입 클라이언트 (이 저장소의 프론트엔드)

프론트엔드는 스펙에서 TypeScript 타입을 생성하고
[`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/)로 완전히 타입 검증된
호출을 합니다 — 경로·파라미터·응답이 컴파일 타임에 검증됩니다:

```ts
const { api } = useApiClient();
const { data } = await api.GET('/projects');                 // 타입 검증됨
await api.GET('/artifacts/{artifact_id}/download-url', {
  params: { path: { artifact_id } },
});
```

타입은 자동 재생성됩니다: 프론트엔드 `compile` 타깃이 `generate-client`에,
이는 다시 `idp_v2.backend:openapi`에 의존합니다. 수동 실행은
`nx run @idp-v2/frontend:generate-client`. 출력(`src/generated/api.d.ts`)은
git-ignore 되며 매 컴파일 시 재생성됩니다. 리소스 훅들은 레거시
`fetchApi`(수기 타입)에서 이 타입 클라이언트로 점진적으로 이전 중입니다.

### 파일 업로드 흐름

1. `POST /projects/{pid}/documents` (파일 메타데이터) → `{ document_id, upload_url }`.
2. 파일 바이트를 `upload_url`(단기 presigned S3 URL)에 직접 `PUT`.
3. `PUT /projects/{pid}/documents/{document_id}/status`로 업로드 완료 표시.

클라이언트는 AWS 자격증명을 갖지 않으며, 모든 presigned URL은 백엔드가 발급합니다.

### AI 채팅 (Server-Sent Events)

`POST {BackendStream}/chat/projects/{pid}/invoke`에 
`{ prompt, session_id, agent_id? }`를 보내면 `text/event-stream`을 반환합니다.
각 이벤트는 `data: {json}` 라인이며 `: ping` 주석은 하트비트이므로 무시합니다.
백엔드가 Bedrock AgentCore를 대신 호출하므로 브라우저는 Bedrock을 직접 호출하지
않습니다. 긴 생성에서 HTTP API의 30초 타임아웃을 피하기 위해 이 경로는
API Gateway가 아닌 CloudFront → 내부 ALB로 제공됩니다.

### 음성 (양방향 오디오)

`POST /voice/connection`은 Bedrock AgentCore bidi 런타임에 대한 단기(60초)
presigned `wss://` URL을 반환합니다. 브라우저는 지연시간을 위해 직접 연결하지만,
서명은 백엔드가 task role로 수행하므로 클라이언트에서 Cognito Identity Pool
자격증명 흐름이 사라집니다.

### 워크플로우 알림 (WebSocket)

`websocketUrl?token=<access_token>`으로 연결합니다. Lambda request authorizer가
토큰을 검증합니다. 메시지는 `{ action, data, projectId }` 형태이며 `action`별로
구독합니다(`workflow`, `step`, `document`, `sessions`, `artifacts`).

## 로컬 개발

`AUTH_MODE=legacy`로 설정하면 JWT 대신 `x-user-id` 헤더를 허용합니다
(`fastapi dev`와 테스트 스위트에서 사용). 운영 배포는 `AUTH_MODE=jwt`로 실행되어
헤더 폴백을 거부합니다.

## 백엔드 단독 배포

백엔드·인증·프론트엔드는 별도의 CDK 스택입니다.

```bash
pnpm nx run @idp-v2/infra:deploy IDP-V2-Auth
pnpm nx run @idp-v2/infra:deploy IDP-V2-Backend     # 프론트엔드 불필요
pnpm nx run @idp-v2/infra:deploy IDP-V2-Frontend    # 어떤 UI든; 선택 사항
```

스택 간 연결은 SSM 파라미터로 이루어지므로, 백엔드는 프론트엔드 없이도 배포·동작합니다.
