"""JWT 기반 사용자 인증 의존성.

API Gateway JWT authorizer가 1차 검증을 하지만, CloudFront 스트리밍 경로는
API Gateway를 우회하므로 백엔드가 직접 토큰을 검증한다 (defense in depth).
AUTH_MODE=legacy 에서는 기존 x-user-id 헤더를 허용한다 (로컬 개발/테스트용).
"""

from typing import Annotated

import jwt
from fastapi import Depends, Header, HTTPException
from pydantic import BaseModel

from app.config import get_config

_jwks_client: jwt.PyJWKClient | None = None


class AuthenticatedUser(BaseModel):
    user_id: str
    sub: str | None = None


def _get_jwks_client() -> jwt.PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        config = get_config()
        jwks_url = (
            f"https://cognito-idp.{config.aws_region}.amazonaws.com/{config.cognito_user_pool_id}/.well-known/jwks.json"
        )
        _jwks_client = jwt.PyJWKClient(jwks_url, cache_keys=True)
    return _jwks_client


def _validate_token(token: str) -> AuthenticatedUser:
    config = get_config()
    issuer = f"https://cognito-idp.{config.aws_region}.amazonaws.com/{config.cognito_user_pool_id}"
    try:
        signing_key = _get_jwks_client().get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            issuer=issuer,
            options={"require": ["exp", "iss", "sub"]},
        )
    except jwt.PyJWTError as e:
        raise HTTPException(status_code=401, detail=f"Invalid token: {e}") from e

    if claims.get("token_use") != "access":
        raise HTTPException(status_code=401, detail="Invalid token: not an access token")
    if config.cognito_app_client_id and claims.get("client_id") != config.cognito_app_client_id:
        raise HTTPException(status_code=401, detail="Invalid token: client_id mismatch")

    username = claims.get("username") or claims.get("cognito:username")
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token: missing username claim")

    return AuthenticatedUser(user_id=username, sub=claims.get("sub"))


def get_current_user(
    authorization: str | None = Header(None),
    x_user_id: str | None = Header(None, alias="x-user-id"),
) -> AuthenticatedUser:
    config = get_config()

    if authorization and authorization.lower().startswith("bearer ") and config.cognito_user_pool_id:
        return _validate_token(authorization[7:])

    if config.auth_mode == "legacy" and x_user_id:
        return AuthenticatedUser(user_id=x_user_id)

    raise HTTPException(status_code=401, detail="Not authenticated")


CurrentUser = Annotated[AuthenticatedUser, Depends(get_current_user)]
