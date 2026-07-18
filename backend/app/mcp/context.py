import base64
import binascii
import hashlib
import hmac
import json
import time
from collections.abc import Iterable
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any

from fastapi import status
from sqlalchemy import delete
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext
from app.core.config import settings
from app.core.errors import ApiError
from app.models.identity import AiContextConsumptionModel
from app.schemas.ai import AiContextActor, AiContextClaims, PermissionName
from app.schemas.common import ErrorCode


_request_context_token: ContextVar[str | None] = ContextVar("asklake_mcp_context_token", default=None)


def install_request_context_token(token: str) -> object:
    return _request_context_token.set(token)


def reset_request_context_token(token: object) -> None:
    _request_context_token.reset(token)  # type: ignore[arg-type]


def request_context_token() -> str | None:
    return _request_context_token.get()


def issue_ai_context_token(
    *,
    request_id: str,
    actor: ActorContext,
    allowed_dataset_ids: Iterable[str],
    dataset_permissions: dict[str, Iterable[PermissionName]],
    secret: str | None = None,
    ttl_seconds: int | None = None,
    now: int | None = None,
) -> str:
    signing_secret = secret or settings.ai_context_signing_secret
    if not signing_secret:
        raise ApiError(
            ErrorCode.SERVICE_UNAVAILABLE,
            "AI context signing is not configured",
            status.HTTP_503_SERVICE_UNAVAILABLE,
        )

    issued_at = int(time.time()) if now is None else int(now)
    ttl = settings.ai_context_ttl_seconds if ttl_seconds is None else int(ttl_seconds)
    if ttl < 1 or ttl > settings.ai_context_ttl_seconds:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            f"AI context token TTL must be between 1 and {settings.ai_context_ttl_seconds} seconds",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    dataset_ids = _normalized_dataset_ids(allowed_dataset_ids)
    permission_map = _normalized_permissions(dataset_permissions, dataset_ids)
    claims = AiContextClaims(
        request_id=request_id.strip(),
        actor=AiContextActor(
            name=actor.name,
            role=actor.role,
            groups=list(actor.groups),
            id=actor.id,
            email=actor.email,
        ),
        allowed_dataset_ids=dataset_ids,
        dataset_permissions=permission_map,
        issued_at=issued_at,
        expires_at=issued_at + ttl,
    )
    payload = _encode_json(claims.model_dump(mode="json", by_alias=True))
    header = _encode_json({"alg": "HS256", "typ": "ASKLAKE-AI-CONTEXT"})
    unsigned = f"{header}.{payload}"
    signature = _sign(unsigned, signing_secret)
    return f"{unsigned}.{signature}"


def verify_ai_context_token(
    token: str | None,
    *,
    secret: str | None = None,
    now: int | None = None,
) -> AiContextClaims:
    signing_secret = secret or settings.ai_context_signing_secret
    if not signing_secret:
        raise ApiError(
            ErrorCode.SERVICE_UNAVAILABLE,
            "AI context signing is not configured",
            status.HTTP_503_SERVICE_UNAVAILABLE,
        )
    if not token or not isinstance(token, str):
        raise _invalid_context_error()
    if not token.isascii():
        raise _invalid_context_error()
    if len(token) > 16_384:
        raise _invalid_context_error()

    parts = token.split(".")
    if len(parts) != 3:
        raise _invalid_context_error()
    header_part, payload_part, signature_part = parts
    unsigned = f"{header_part}.{payload_part}"
    expected_signature = _sign(unsigned, signing_secret)
    if not hmac.compare_digest(signature_part, expected_signature):
        raise _invalid_context_error()

    try:
        header = _decode_json(header_part)
        payload = _decode_json(payload_part)
        claims = AiContextClaims.model_validate(payload)
    except (ValueError, TypeError, UnicodeEncodeError, json.JSONDecodeError, binascii.Error):
        raise _invalid_context_error() from None

    if header.get("alg") != "HS256" or header.get("typ") != "ASKLAKE-AI-CONTEXT":
        raise _invalid_context_error()

    current_time = int(time.time()) if now is None else int(now)
    if (
        claims.expires_at <= claims.issued_at
        or claims.expires_at <= current_time
        or claims.issued_at > current_time + 30
        or claims.expires_at - claims.issued_at > settings.ai_context_ttl_seconds
    ):
        raise ApiError(
            ErrorCode.UNAUTHORIZED,
            "AI context token is expired or not yet valid",
            status.HTTP_401_UNAUTHORIZED,
        )
    return claims


def consume_ai_context_token(
    db: Session,
    token: str,
    claims: AiContextClaims,
    *,
    now: datetime | None = None,
) -> None:
    """Atomically consume a signed context across every backend/Gateway replica."""

    consumed_at = now or datetime.now(timezone.utc)
    token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
    try:
        db.execute(
            delete(AiContextConsumptionModel).where(
                AiContextConsumptionModel.expires_at <= consumed_at,
            ),
        )
        db.add(
            AiContextConsumptionModel(
                token_hash=token_hash,
                request_id=claims.request_id,
                expires_at=datetime.fromtimestamp(claims.expires_at, tz=timezone.utc),
            ),
        )
        db.commit()
    except IntegrityError:
        db.rollback()
        raise ApiError(
            ErrorCode.CONFLICT,
            "AI context token has already been consumed",
            status.HTTP_409_CONFLICT,
        ) from None


def _normalized_dataset_ids(dataset_ids: Iterable[str]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for dataset_id in dataset_ids:
        value = str(dataset_id).strip()
        if value and value not in seen:
            normalized.append(value)
            seen.add(value)
    if not normalized:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "At least one dataset must be allowed in an AI context",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    return normalized


def _normalized_permissions(
    permissions: dict[str, Iterable[PermissionName]],
    dataset_ids: list[str],
) -> dict[str, list[PermissionName]]:
    normalized: dict[str, list[PermissionName]] = {}
    for dataset_id in dataset_ids:
        values: list[PermissionName] = []
        for permission in permissions.get(dataset_id, []):
            if permission in {"view", "query", "run", "manage", "delete", "share"} and permission not in values:
                values.append(permission)
        normalized[dataset_id] = values
    return normalized


def _encode_json(value: dict[str, Any]) -> str:
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return _base64url_encode(raw)


def _decode_json(value: str) -> dict[str, Any]:
    decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    result = json.loads(
        decoded.decode("utf-8"),
        parse_constant=lambda constant: (_ for _ in ()).throw(ValueError(f"Invalid JSON constant: {constant}")),
    )
    if not isinstance(result, dict):
        raise ValueError("Token JSON must be an object")
    return result


def _base64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _sign(value: str, secret: str) -> str:
    digest = hmac.new(secret.encode("utf-8"), value.encode("ascii"), hashlib.sha256).digest()
    return _base64url_encode(digest)


def _invalid_context_error() -> ApiError:
    return ApiError(
        ErrorCode.UNAUTHORIZED,
        "AI context token is invalid",
        status.HTTP_401_UNAUTHORIZED,
    )
