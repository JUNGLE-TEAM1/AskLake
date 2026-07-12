import os
import re
from typing import Any

from fastapi import APIRouter, Query, status

from app.core.errors import ApiError
from app.schemas.common import ErrorCode
from app.services.etl_service import build_catalog_s3_client

router = APIRouter(prefix="/s3", tags=["s3"])

MAX_PREFIX_LENGTH = 1024


def configured_buckets() -> list[str]:
    return [
        bucket.strip()
        for bucket in str(os.environ.get("S3_ALLOWED_BUCKETS") or "").split(",")
        if bucket.strip()
    ]


def normalize_prefix(prefix: str) -> str:
    if len(prefix) > MAX_PREFIX_LENGTH:
        raise ApiError(ErrorCode.VALIDATION_ERROR, "S3 prefix is too long", status.HTTP_422_UNPROCESSABLE_CONTENT)
    if "\\" in prefix or any(ord(character) < 32 for character in prefix):
        raise ApiError(ErrorCode.VALIDATION_ERROR, "S3 prefix contains unsupported characters", status.HTTP_422_UNPROCESSABLE_CONTENT)
    normalized = re.sub(r"/{2,}", "/", prefix.lstrip("/"))
    if ".." in normalized.split("/"):
        raise ApiError(ErrorCode.VALIDATION_ERROR, "S3 prefix cannot contain parent traversal", status.HTTP_422_UNPROCESSABLE_CONTENT)
    return normalized


@router.get("/buckets")
def list_buckets() -> dict[str, list[str]]:
    allowed = configured_buckets()
    try:
        response = build_catalog_s3_client().list_buckets()
    except ApiError:
        raise
    except Exception as exc:
        raise ApiError(ErrorCode.SERVICE_UNAVAILABLE, "S3 bucket listing is unavailable", status.HTTP_503_SERVICE_UNAVAILABLE) from exc

    available = sorted({str(item.get("Name") or "") for item in response.get("Buckets") or [] if item.get("Name")})
    return {"buckets": [bucket for bucket in available if not allowed or bucket in allowed]}


@router.get("/prefixes")
def list_prefixes(
    bucket: str = Query(min_length=1),
    prefix: str = Query(default=""),
    continuation_token: str | None = Query(default=None, alias="continuationToken"),
) -> dict[str, Any]:
    allowed = configured_buckets()
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
