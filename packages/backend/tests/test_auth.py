"""app.auth 인증 의존성 테스트."""

import time
from unittest.mock import MagicMock, patch

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException

from app.auth import AuthenticatedUser, get_current_user
from app.config import Config

USER_POOL_ID = "us-east-1_TESTPOOL"
APP_CLIENT_ID = "test-client-id"
REGION = "us-east-1"
ISSUER = f"https://cognito-idp.{REGION}.amazonaws.com/{USER_POOL_ID}"

_private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _make_token(**overrides) -> str:
    claims = {
        "sub": "abc-123",
        "username": "user-1",
        "token_use": "access",
        "client_id": APP_CLIENT_ID,
        "iss": ISSUER,
        "exp": int(time.time()) + 3600,
    }
    claims.update(overrides)
    return jwt.encode(claims, _private_key, algorithm="RS256")


def _jwt_config() -> Config:
    return Config(
        auth_mode="jwt",
        cognito_user_pool_id=USER_POOL_ID,
        cognito_app_client_id=APP_CLIENT_ID,
        aws_region=REGION,
    )


def _patch_jwks():
    """PyJWKClient가 테스트 private key의 공개키를 반환하도록 패치."""
    signing_key = MagicMock()
    signing_key.key = _private_key.public_key()
    client = MagicMock()
    client.get_signing_key_from_jwt.return_value = signing_key
    return patch("app.auth._get_jwks_client", return_value=client)


class TestLegacyMode:
    def test_x_user_id_accepted(self):
        with patch("app.auth.get_config", return_value=Config(auth_mode="legacy")):
            user = get_current_user(authorization=None, x_user_id="user-9")
        assert user == AuthenticatedUser(user_id="user-9")

    def test_missing_credentials_rejected(self):
        with (
            patch("app.auth.get_config", return_value=Config(auth_mode="legacy")),
            pytest.raises(HTTPException) as exc,
        ):
            get_current_user(authorization=None, x_user_id=None)
        assert exc.value.status_code == 401


class TestJwtMode:
    def test_valid_token(self):
        with patch("app.auth.get_config", return_value=_jwt_config()), _patch_jwks():
            user = get_current_user(authorization=f"Bearer {_make_token()}", x_user_id=None)
        assert user.user_id == "user-1"
        assert user.sub == "abc-123"

    def test_expired_token_rejected(self):
        token = _make_token(exp=int(time.time()) - 10)
        with (
            patch("app.auth.get_config", return_value=_jwt_config()),
            _patch_jwks(),
            pytest.raises(HTTPException) as exc,
        ):
            get_current_user(authorization=f"Bearer {token}", x_user_id=None)
        assert exc.value.status_code == 401

    def test_wrong_client_id_rejected(self):
        token = _make_token(client_id="someone-else")
        with (
            patch("app.auth.get_config", return_value=_jwt_config()),
            _patch_jwks(),
            pytest.raises(HTTPException) as exc,
        ):
            get_current_user(authorization=f"Bearer {token}", x_user_id=None)
        assert exc.value.status_code == 401

    def test_id_token_rejected(self):
        token = _make_token(token_use="id")
        with (
            patch("app.auth.get_config", return_value=_jwt_config()),
            _patch_jwks(),
            pytest.raises(HTTPException) as exc,
        ):
            get_current_user(authorization=f"Bearer {token}", x_user_id=None)
        assert exc.value.status_code == 401

    def test_x_user_id_ignored_in_jwt_mode(self):
        """jwt 모드에서는 Bearer 없이 x-user-id만으로 인증 불가."""
        with (
            patch("app.auth.get_config", return_value=_jwt_config()),
            pytest.raises(HTTPException) as exc,
        ):
            get_current_user(authorization=None, x_user_id="user-1")
        assert exc.value.status_code == 401
