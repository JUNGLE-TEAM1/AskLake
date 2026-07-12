import os
from typing import Iterable
from urllib.parse import urlparse

from fastapi import status

from app.core.errors import ApiError
from app.schemas.common import ErrorCode


def configured_s3_buckets() -> list[str]:
    return [
        bucket.strip()
        for bucket in str(os.environ.get("S3_ALLOWED_BUCKETS") or "").split(",")
        if bucket.strip()
    ]


def require_s3_bucket_allowlist(*, allow_unconfigured: bool) -> list[str]:
    allowed = configured_s3_buckets()
    if not allowed and not allow_unconfigured:
        raise ApiError(
            ErrorCode.SERVICE_UNAVAILABLE,
            "S3_ALLOWED_BUCKETS must be configured outside local development",
            status.HTTP_503_SERVICE_UNAVAILABLE,
        )
    return allowed


def validate_s3_target_path(
    storage_type: str | None,
    storage_path: str | None,
    *,
    allow_unconfigured: bool,
) -> None:
    path = str(storage_path or "").strip()
    parsed = urlparse(path)
    storage_label = str(storage_type or "").strip().casefold()
    declares_s3 = "s3" in storage_label or "minio" in storage_label
    uses_s3 = parsed.scheme.casefold() in {"s3", "s3a"}
    if not declares_s3 and not uses_s3:
        return
    if not uses_s3 or not parsed.netloc or parsed.username or parsed.password:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "S3 target storagePath must use s3:// or s3a:// with a bucket",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    allowed = require_s3_bucket_allowlist(allow_unconfigured=allow_unconfigured)
    if allowed and parsed.netloc not in allowed:
        raise ApiError(
            ErrorCode.FORBIDDEN,
            "Target bucket is not available to AskLake",
            status.HTTP_403_FORBIDDEN,
            {"bucket": parsed.netloc},
        )


def validate_s3_source_config(
    source_type: str | None,
    source_config: Iterable[tuple[str, str]] | None,
    *,
    allow_unconfigured: bool,
) -> None:
    normalized_type = str(source_type or "").strip().casefold()
    if not (normalized_type.startswith("file / s3") or normalized_type.startswith("data lake")):
        return

    fields = {
        str(name or "").strip().casefold(): str(value or "").strip()
        for name, value in (source_config or [])
    }
    bucket = fields.get("bucket / stage name", "")
    if not bucket and normalized_type.startswith("data lake"):
        parsed = urlparse(fields.get("path", ""))
        if parsed.scheme.casefold() in {"s3", "s3a"}:
            bucket = parsed.netloc

    allowed = require_s3_bucket_allowlist(allow_unconfigured=allow_unconfigured)
    if bucket and allowed and bucket not in allowed:
        raise ApiError(
            ErrorCode.FORBIDDEN,
            "Source bucket is not available to AskLake",
            status.HTTP_403_FORBIDDEN,
            {"bucket": bucket},
        )
