"""Bedrock AgentCore 호출을 SSE로 중계하는 프록시.

프론트엔드가 AWS 자격증명/SigV4 없이 표준 fetch + SSE 로 에이전트를 호출할 수 있도록
백엔드(태스크 롤)가 invoke_agent_runtime 을 대신 호출하고, 에이전트가 내보내는
JSON 이벤트 스트림을 SSE(`data: {...}\n\n`)로 재포장한다.

긴 생성 동안 중간 프록시(CloudFront/ALB) idle timeout 을 막기 위해 15초마다
`: ping` 하트비트 주석을 흘려보낸다.
"""

import asyncio
import json
import queue
import threading
from functools import lru_cache
from typing import Any

import boto3
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.auth import CurrentUser
from app.config import get_config

router = APIRouter(prefix="/chat", tags=["chat"])

HEARTBEAT_INTERVAL_SECONDS = 15
_STREAM_DONE = object()


class ContentSource(BaseModel):
    base64: str


class ImageContent(BaseModel):
    format: str
    source: ContentSource


class DocumentContent(BaseModel):
    format: str
    name: str
    source: ContentSource


class ContentBlock(BaseModel):
    image: ImageContent | None = None
    document: DocumentContent | None = None
    text: str | None = None


class InvokeRequest(BaseModel):
    prompt: list[ContentBlock]
    session_id: str
    agent_id: str | None = None
    runtime_arn: str | None = None


@lru_cache
def _get_agentcore_client():
    return boto3.client("bedrock-agentcore", region_name=get_config().aws_region)


def _iter_agent_events(payload: dict[str, Any], runtime_arn: str, session_id: str, out: queue.Queue) -> None:
    """블로킹 boto3 스트림을 별도 스레드에서 읽어 큐로 전달."""
    try:
        client = _get_agentcore_client()
        response = client.invoke_agent_runtime(
            agentRuntimeArn=runtime_arn,
            runtimeSessionId=session_id,
            payload=json.dumps(payload).encode("utf-8"),
            contentType="application/json",
        )
        body = response.get("response")
        if body is None:
            out.put(_STREAM_DONE)
            return

        # AgentCore 스트림은 줄 단위(JSON 또는 "data: {json}") 로 도착한다.
        for line in body.iter_lines():
            if not line:
                continue
            text = line.decode("utf-8") if isinstance(line, bytes) else line
            text = text.strip()
            if text.startswith("data:"):
                text = text[5:].strip()
            if text:
                out.put(text)
    except Exception as e:  # noqa: BLE001 - 에러도 클라이언트로 전달
        out.put(json.dumps({"type": "error", "content": str(e)}))
    finally:
        out.put(_STREAM_DONE)


async def _sse_stream(payload: dict[str, Any], runtime_arn: str, session_id: str):
    out: queue.Queue = queue.Queue()
    worker = threading.Thread(
        target=_iter_agent_events,
        args=(payload, runtime_arn, session_id, out),
        daemon=True,
    )
    worker.start()

    loop = asyncio.get_running_loop()
    while True:
        try:
            item = await asyncio.wait_for(
                loop.run_in_executor(None, out.get),
                timeout=HEARTBEAT_INTERVAL_SECONDS,
            )
        except TimeoutError:
            yield ": ping\n\n"
            continue

        if item is _STREAM_DONE:
            break
        yield f"data: {item}\n\n"


@router.post("/projects/{project_id}/invoke")
async def invoke_agent(project_id: str, request: InvokeRequest, user: CurrentUser) -> StreamingResponse:
    """에이전트를 호출하고 SSE 로 스트리밍 응답을 중계한다."""
    config = get_config()
    runtime_arn = request.runtime_arn or config.agent_runtime_arn
    if not runtime_arn:
        raise HTTPException(status_code=500, detail="Agent runtime ARN not configured")

    payload = {
        "prompt": [block.model_dump(exclude_none=True) for block in request.prompt],
        "session_id": request.session_id,
        "project_id": project_id,
        "user_id": user.user_id,
        "agent_id": request.agent_id,
    }

    return StreamingResponse(
        _sse_stream(payload, runtime_arn, request.session_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
