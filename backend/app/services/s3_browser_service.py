from __future__ import annotations

import os
import re
from typing import Any

from fastapi import status

from app.core.errors import ApiError
from app.core.s3_policy import configured_s3_buckets
from app.schemas.common import ErrorCode
from app.schemas.integration import (
    S3BucketsResponse,
    S3PrefixFile,
    S3PrefixFolder,
    S3PrefixesResponse,
)
from app.services.object_storage import object_storage_provider, object_storage_runtime


DEFAULT_BUCKETS = ["asklake-output"]
MAX_PREFIX_LENGTH = 1024


def allowed_buckets() -> list[str]:
    configured = [
        bucket
        for bucket in [str(os.environ.get("ASKLAKE_SPARK_OUTPUT_BUCKET") or "").strip()]
        if bucket
    ]
    configured.extend(configured_s3_buckets())
    configured.extend(
        bucket.strip()
        for bucket in str(
            os.environ.get("AWS_S3_ALLOWED_BUCKETS")
            or os.environ.get("ASKLAKE_S3_ALLOWED_BUCKETS")
            or ""
        ).split(",")
        if bucket.strip()
    )
    buckets = list(dict.fromkeys(configured))
    if buckets:
        return buckets
    if object_storage_provider() == "aws":
        raise ApiError(
            ErrorCode.SERVICE_UNAVAILABLE,
            "S3 target browsing requires ASKLAKE_SPARK_OUTPUT_BUCKET or S3_ALLOWED_BUCKETS",
            status.HTTP_503_SERVICE_UNAVAILABLE,
        )
    return DEFAULT_BUCKETS.copy()


def list_s3_buckets() -> S3BucketsResponse:
    return S3BucketsResponse(buckets=allowed_buckets())


def list_s3_prefixes(
    *,
    bucket: str,
    continuation_token: str | None,
    prefix: str,
) -> S3PrefixesResponse:
    allowed_bucket = _require_allowed_bucket(bucket)
    safe_prefix = _validate_prefix(prefix)
    request: dict[str, Any] = {
        "Bucket": allowed_bucket,
        "Delimiter": "/",
        "Prefix": safe_prefix,
    }
    if continuation_token:
        request["ContinuationToken"] = continuation_token
    try:
        response = _build_s3_client().list_objects_v2(**request)
    except ApiError:
        raise
    except Exception as error:
        raise ApiError(
            "S3_LIST_FAILED",
            "S3 prefix list failed",
            status.HTTP_502_BAD_GATEWAY,
            {"message": str(error)},
        ) from error

    files = [
        S3PrefixFile(key=str(item["Key"]), name=_file_name(str(item["Key"]), safe_prefix))
        for item in response.get("Contents", [])
        if isinstance(item, dict) and item.get("Key") and item.get("Key") != safe_prefix
    ]
    folders = [
        S3PrefixFolder(name=_folder_name(str(item["Prefix"])), prefix=str(item["Prefix"]))
        for item in response.get("CommonPrefixes", [])
        if isinstance(item, dict) and item.get("Prefix")
    ]
    return S3PrefixesResponse(
        bucket=allowed_bucket,
        files=files,
        folders=folders,
        next_continuation_token=response.get("NextContinuationToken"),
        prefix=safe_prefix,
    )


def _require_allowed_bucket(bucket: str) -> str:
    normalized = str(bucket or "").strip()
    if not normalized:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "bucket is required",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if normalized not in allowed_buckets():
        raise ApiError(
            ErrorCode.FORBIDDEN,
            "bucket is not allowed",
            status.HTTP_403_FORBIDDEN,
            {"bucket": normalized},
        )
    return normalized


def _validate_prefix(prefix: str) -> str:
    normalized = str(prefix or "").strip().replace("\\", "/")
    normalized = re.sub(r"^/+", "", normalized)
    normalized = re.sub(r"/{2,}", "/", normalized)
    if normalized and not normalized.endswith("/"):
        normalized = f"{normalized}/"
    if (
        len(normalized) > MAX_PREFIX_LENGTH
        or ".." in normalized
        or any(ord(character) < 32 for character in normalized)
    ):
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "prefix is invalid",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    return normalized


def _build_s3_client() -> Any:
    try:
        import boto3
        from botocore.config import Config
    except ImportError as error:
        raise ApiError(
            ErrorCode.SERVICE_UNAVAILABLE,
            "Python S3 client dependency is not installed",
            status.HTTP_503_SERVICE_UNAVAILABLE,
        ) from error

    runtime = object_storage_runtime()
    return boto3.client(
        "s3",
        config=Config(
            connect_timeout=5,
            read_timeout=15,
            retries={"max_attempts": 2, "mode": "standard"},
            s3={"addressing_style": "path" if runtime.force_path_style else "auto"},
        ),
        **runtime.boto3_kwargs(),
    )


def _file_name(key: str, current_prefix: str) -> str:
    return next((part for part in reversed(key[len(current_prefix):].split("/")) if part), key)


def _folder_name(prefix: str) -> str:
    return next((part for part in reversed(prefix.split("/")) if part), prefix)
