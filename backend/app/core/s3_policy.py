import os
from typing import Iterable
from urllib.parse import urlparse

from fastapi import status

from app.core.errors import ApiError
from app.schemas.common import ErrorCode


DEFAULT_FILE_S3_BUCKET = "m3-raw"
DEFAULT_DATA_LAKE_PATH = "s3://m3-raw/nyc_taxi/yellow_parquet/"


def configured_s3_buckets() -> list[str]:
    return [
        bucket.strip()
        for bucket in str(os.environ.get("S3_ALLOWED_BUCKETS") or "").split(",")
        if bucket.strip()
    ]


def configured_s3_endpoints() -> list[str]:
    configured = [
        value.strip()
        for value in str(os.environ.get("S3_ALLOWED_ENDPOINTS") or "").split(",")
        if value.strip()
    ]
    configured.extend(
        value.strip()
        for name in ("S3_ENDPOINT", "MINIO_ENDPOINT")
        if (value := str(os.environ.get(name) or "")).strip()
    )
    return list(dict.fromkeys(normalize_s3_endpoint(value) for value in configured))


def normalize_s3_endpoint(value: str) -> str:
    parsed = urlparse(str(value or "").strip())
    if parsed.scheme.casefold() not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "S3 endpoint must be an http(s) origin without credentials",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    path = parsed.path.rstrip("/")
    return f"{parsed.scheme.casefold()}://{parsed.netloc.casefold()}{path}"


def require_s3_bucket_allowlist(*, allow_unconfigured: bool) -> list[str]:
    allowed = configured_s3_buckets()
    if not allowed and not allow_unconfigured:
        raise ApiError(
            "SERVICE_UNAVAILABLE",
            "S3_ALLOWED_BUCKETS must be configured outside local development",
            status.HTTP_503_SERVICE_UNAVAILABLE,
        )
    return allowed


def validate_s3_source_config(
    source_type: str | None,
    source_config: Iterable[object] | None,
    *,
    allow_unconfigured: bool,
) -> None:
    normalized_type = str(source_type or "").strip().casefold()
    if not (normalized_type.startswith("file / s3") or normalized_type.startswith("data lake")):
        return

    fields = s3_source_config_fields(source_config)
    bucket, _prefix = resolve_s3_source_location(source_type, fields)
    allowed = require_s3_bucket_allowlist(allow_unconfigured=allow_unconfigured)
    if bucket and allowed and bucket not in allowed:
        raise ApiError(
            ErrorCode.FORBIDDEN,
            "Source bucket is not available to AskLake",
            status.HTTP_403_FORBIDDEN,
            {"bucket": bucket},
        )
    if allow_unconfigured:
        return

    endpoint = fields.get("endpoint url") or fields.get("endpoint")
    if not endpoint:
        return
    allowed_endpoints = configured_s3_endpoints()
    if not allowed_endpoints:
        raise ApiError(
            "SERVICE_UNAVAILABLE",
            "S3_ALLOWED_ENDPOINTS or S3_ENDPOINT must be configured for a custom source endpoint",
            status.HTTP_503_SERVICE_UNAVAILABLE,
        )
    if normalize_s3_endpoint(endpoint) not in allowed_endpoints:
        raise ApiError(
            ErrorCode.FORBIDDEN,
            "Source S3 endpoint is not available to AskLake",
            status.HTTP_403_FORBIDDEN,
            {"endpoint": normalize_s3_endpoint(endpoint)},
        )


def s3_source_config_fields(source_config: Iterable[object] | None) -> dict[str, str]:
    fields: dict[str, str] = {}
    for row in source_config or []:
        if not isinstance(row, (list, tuple)) or len(row) < 2:
            continue
        fields[str(row[0] or "").strip().casefold()] = str(row[1] or "").strip()
    return fields


def resolve_s3_source_location(
    source_type: str | None,
    source_config: Iterable[object] | dict[str, str] | None,
) -> tuple[str, str]:
    fields = source_config if isinstance(source_config, dict) else s3_source_config_fields(source_config)
    normalized_type = str(source_type or "").strip().casefold()
    declared_value = fields.get("bucket / stage name", "").strip()
    declared_parsed = urlparse(declared_value)
    declared_bucket = (
        declared_parsed.netloc
        if declared_parsed.scheme.casefold() in {"s3", "s3a"}
        else declared_value.strip("/")
    )
    path_value = (
        fields.get("path", "")
        if normalized_type.startswith("data lake")
        else fields.get("path / prefix", "") or fields.get("path", "")
    ).strip()
    if normalized_type.startswith("data lake") and not path_value:
        path_value = DEFAULT_DATA_LAKE_PATH
    path_parsed = urlparse(path_value)
    path_bucket = path_parsed.netloc if path_parsed.scheme.casefold() in {"s3", "s3a"} else ""
    if declared_bucket and path_bucket and declared_bucket != path_bucket:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "S3 source bucket does not match the bucket in the source path",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            {"declaredBucket": declared_bucket, "pathBucket": path_bucket},
        )
    bucket = path_bucket or declared_bucket
    if not bucket and normalized_type.startswith("file / s3"):
        bucket = str(os.environ.get("MINIO_BUCKET") or "").strip() or DEFAULT_FILE_S3_BUCKET
    prefix = path_parsed.path.lstrip("/") if path_bucket else path_value.lstrip("/")
    if bucket and prefix.startswith(f"{bucket}/"):
        prefix = prefix[len(bucket) + 1:]
    return bucket, prefix
