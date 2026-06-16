"""음성(양방향 오디오) 세션용 연결 정보 발급.

브라우저는 지연시간을 위해 Bedrock AgentCore 의 bidi WebSocket 에 직접 연결하되,
Cognito Identity Pool 자격증명 흐름을 프론트엔드에서 제거한다. 대신 백엔드가
태스크 롤로 SigV4 query 서명을 해 단기 wss URL 을 발급한다.
"""

from urllib.parse import quote

import boto3
from botocore.auth import SigV4QueryAuth
from botocore.awsrequest import AWSRequest
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.auth import CurrentUser
from app.config import get_config

router = APIRouter(prefix="/voice", tags=["voice"])

WS_URL_EXPIRES_SECONDS = 60


class VoiceConnectionResponse(BaseModel):
    ws_url: str
    expires_in: int


def _region_from_arn(arn: str) -> str:
    return arn.split(":")[3]


@router.post("/connection", response_model=VoiceConnectionResponse)
def create_voice_connection(user: CurrentUser) -> VoiceConnectionResponse:
    """Bedrock AgentCore bidi 런타임에 대한 단기 presigned wss URL 발급."""
    config = get_config()
    bidi_arn = config.bidi_agent_runtime_arn
    if not bidi_arn:
        raise HTTPException(status_code=500, detail="Bidi agent runtime ARN not configured")

    region = _region_from_arn(bidi_arn)
    credentials = boto3.Session().get_credentials()
    if credentials is None:
        raise HTTPException(status_code=500, detail="No AWS credentials available")

    url = f"https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{quote(bidi_arn, safe='')}/ws"
    aws_request = AWSRequest(method="GET", url=url)
    SigV4QueryAuth(
        credentials.get_frozen_credentials(),
        "bedrock-agentcore",
        region,
        expires=WS_URL_EXPIRES_SECONDS,
    ).add_auth(aws_request)

    ws_url = aws_request.url.replace("https://", "wss://", 1)
    return VoiceConnectionResponse(ws_url=ws_url, expires_in=WS_URL_EXPIRES_SECONDS)
