import base64
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException, Request, Response

from app.config import Settings, get_settings


SESSION_COOKIE_NAME = "digitize_session"
CSRF_HEADER_NAME = "x-csrf-token"
MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
PUBLIC_API_PATHS = {
    "/api/health",
    "/api/auth/session",
    "/api/auth/logout",
}


@dataclass(frozen=True)
class SessionData:
    csrf_token: str
    expires_at: int


def is_public_api_path(path: str) -> bool:
    return path in PUBLIC_API_PATHS


def authenticate_access_code(access_code: str, settings: Settings | None = None) -> bool:
    settings = settings or get_settings()
    expected = (settings.app_access_secret or "").strip()
    if not expected:
        return False
    return hmac.compare_digest(access_code.strip(), expected)


def create_session(response: Response, settings: Settings | None = None) -> dict[str, Any]:
    settings = settings or get_settings()
    csrf_token = secrets.token_urlsafe(32)
    expires_at = int(time.time()) + max(60, int(settings.session_ttl_seconds or 86400))
    token = _encode_session({"csrf": csrf_token, "exp": expires_at, "iat": int(time.time())}, settings)
    response.set_cookie(
        SESSION_COOKIE_NAME,
        token,
        max_age=max(60, int(settings.session_ttl_seconds or 86400)),
        httponly=True,
        secure=bool(settings.session_cookie_secure),
        samesite=settings.normalized_session_cookie_samesite,
        path="/",
    )
    return {"authenticated": True, "csrf_token": csrf_token, "expires_at": expires_at, "auth_required": settings.auth_required}


def clear_session(response: Response, settings: Settings | None = None) -> dict[str, Any]:
    settings = settings or get_settings()
    response.delete_cookie(
        SESSION_COOKIE_NAME,
        path="/",
        secure=bool(settings.session_cookie_secure),
        samesite=settings.normalized_session_cookie_samesite,
    )
    return {"authenticated": False, "csrf_token": None, "expires_at": None, "auth_required": settings.auth_required}


def read_session(request: Request, settings: Settings | None = None) -> SessionData | None:
    settings = settings or get_settings()
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if not token:
        return None
    payload = _decode_session(token, settings)
    if not payload:
        return None
    expires_at = int(payload.get("exp") or 0)
    csrf_token = str(payload.get("csrf") or "")
    if not csrf_token or expires_at < int(time.time()):
        return None
    return SessionData(csrf_token=csrf_token, expires_at=expires_at)


def require_session_for_request(request: Request, settings: Settings | None = None) -> SessionData | None:
    settings = settings or get_settings()
    if not settings.auth_required:
        return None
    session = read_session(request, settings)
    if not session:
        raise HTTPException(status_code=401, detail="Authentication required")
    if request.method.upper() in MUTATING_METHODS:
        sent_token = request.headers.get(CSRF_HEADER_NAME, "")
        if not hmac.compare_digest(sent_token, session.csrf_token):
            raise HTTPException(status_code=403, detail="CSRF token is missing or invalid")
    return session


def _encode_session(payload: dict[str, Any], settings: Settings) -> str:
    secret = settings.resolved_session_secret_key
    if not secret:
        raise HTTPException(status_code=503, detail="Session secret is not configured")
    body = _base64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signature = _base64url_encode(hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest())
    return f"{body}.{signature}"


def _decode_session(token: str, settings: Settings) -> dict[str, Any] | None:
    secret = settings.resolved_session_secret_key
    if not secret or "." not in token:
        return None
    body, signature = token.rsplit(".", 1)
    expected = _base64url_encode(hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest())
    if not hmac.compare_digest(signature, expected):
        return None
    try:
        return json.loads(_base64url_decode(body).decode("utf-8"))
    except (ValueError, json.JSONDecodeError):
        return None


def _base64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _base64url_decode(value: str) -> bytes:
    padded = value + "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))
