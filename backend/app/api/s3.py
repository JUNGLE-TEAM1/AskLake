import re
from typing import Any

from fastapi import APIRouter, Depends, Query, status

from app.core.auth_context import ActorContext, get_actor_context, require_permission
from app.core.config import settings
from app.core.errors import ApiError
from app.core.s3_policy import configured_s3_buckets, require_s3_bucket_allowlist
from app.schemas.common import ErrorCode
from app.services.etl_service import build_catalog_s3_client

router = APIRouter(prefix="/s3", tags=["s3"])

MAX_PREFIX_LENGTH = 1024


def configured_buckets() -> list[str]:
    return configured_s3_buckets()


def require_bucket_allowlist() -> list[str]:
    return require_s3_bucket_allowlist(
        allow_unconfigured=settings.allows_header_auth_fallback,
    )


def normalize_prefix(prefix: str) -> str:
    if len(prefix) > MAX_PREFIX_LENGTH:
        raise ApiError(ErrorCode.VALIDATION_ERROR, "S3 prefix is too long", status.HTTP_422_UNPROCESSABLE_ENTITY)
    if "\\" in prefix or any(ord(character) < 32 for character in prefix):
        raise ApiError(ErrorCode.VALIDATION_ERROR, "S3 prefix contains unsupported characters", status.HTTP_422_UNPROCESSABLE_ENTITY)
    normalized = re.sub(r"/{2,}", "/", prefix.lstrip("/"))
    if ".." in normalized.split("/"):
        raise ApiError(ErrorCode.VALIDATION_ERROR, "S3 prefix cannot contain parent traversal", status.HTTP_422_UNPROCESSABLE_ENTITY)
    return normalized


@router.get("/buckets")
def list_buckets(actor: ActorContext = Depends(get_actor_context)) -> dict[str, list[str]]:
    require_permission(actor, "manage", resource_label="S3 browser")
    allowed = require_bucket_allowlist()
    if allowed:
        return {"buckets": sorted(set(allowed))}

    try:
        response = build_catalog_s3_client().list_buckets()
    except ApiError:
        raise
    except Exception as exc:
        raise ApiError(ErrorCode.SERVICE_UNAVAILABLE, "S3 bucket listing is unavailable", status.HTTP_503_SERVICE_UNAVAILABLE) from exc

    available = sorted({str(item.get("Name") or "") for item in response.get("Buckets") or [] if item.get("Name")})
    return {"buckets": available}


@router.get("/prefixes")
def list_prefixes(
    bucket: str = Query(min_length=1),
    prefix: str = Query(default=""),
    continuation_token: str | None = Query(default=None, alias="continuationToken"),
    actor: ActorContext = Depends(get_actor_context),
) -> dict[str, Any]:
    require_permission(actor, "manage", resource_label="S3 browser")
    allowed = require_bucket_allowlist()
    if allowed and bucket not in allowed:
        raise ApiError(ErrorCode.FORBIDDEN, "Bucket is not available to AskLake", status.HTTP_403_FORBIDDEN)

    normalized_prefix = normalize_prefix(prefix)
    request: dict[str, Any] = {
        "Bucket": bucket,
        "Prefix": normalized_prefix,
        "Delimiter": "/",
        "MaxKeys": 200,
    }
    if continuation_token:
        request["ContinuationToken"] = continuation_token
    try:
        response = build_catalog_s3_client().list_objects_v2(**request)
    except ApiError:
        raise
    except Exception as exc:
        raise ApiError(ErrorCode.SERVICE_UNAVAILABLE, "S3 prefix listing is unavailable", status.HTTP_503_SERVICE_UNAVAILABLE) from exc

    folders = [
        {"name": value.rstrip("/").rsplit("/", 1)[-1], "prefix": value, "type": "folder"}
        for item in response.get("CommonPrefixes") or []
        if (value := str(item.get("Prefix") or ""))
    ]
    files = [
        {"key": value, "name": value.rsplit("/", 1)[-1], "type": "file"}
        for item in response.get("Contents") or []
        if (value := str(item.get("Key") or "")) and value != normalized_prefix
    ]
    return {
        "bucket": bucket,
        "files": files,
        "folders": folders,
        "nextContinuationToken": response.get("NextContinuationToken") if response.get("IsTruncated") else None,
        "prefix": normalized_prefix,
    }
