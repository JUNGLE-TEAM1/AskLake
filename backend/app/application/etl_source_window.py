"""Source-window parsing and object identity helpers."""

from datetime import UTC, datetime, timedelta
import os
from typing import Any, Callable
from fastapi import status
from app.core.errors import ApiError
from app.core.s3_policy import resolve_s3_source_location, s3_source_config_fields, validate_s3_source_config
from app.models import (
    CatalogDatasetModel,
    ETLJobModel,
    ETLRunModel,
    KafkaContinuousBatchModel,
    KafkaContinuousMaintenanceRunModel,
    KafkaContinuousRuntimeModel,
    KafkaContinuousSessionModel,
    KafkaSnapshotModel,
    PermissionGrantModel,
    ResourceLockModel,
)
from app.schemas.common import ErrorCode

from app.application.etl_runtime_support import compact_storage_text

DEFAULT_SOURCE_IDENTITY_WORKERS = 16
MAX_SOURCE_IDENTITY_WORKERS = 64

def source_uses_incremental_folder_window(job: ETLJobModel) -> bool:
    source_type = str(getattr(job, "source_type", "") or "").strip().casefold()
    if not (source_type.startswith("file / s3") or source_type.startswith("data lake")):
        return False
    fields = s3_source_config_fields(getattr(job, "source_config", None) or [])
    return (
        fields.get("collection scope", "").casefold() == "folder"
        and fields.get("collection mode", "incremental").casefold() == "incremental"
    )

def listed_s3_object_identity(item: dict[str, Any], modified_at: datetime) -> dict[str, Any]:
    key = str(item.get("Key") or "").strip()
    e_tag = normalize_s3_etag(item.get("ETag"))
    if not key or not e_tag or item.get("Size") is None:
        raise ApiError(
            "SOURCE_OBJECT_IDENTITY_UNAVAILABLE",
            "Incremental source listing did not provide complete object identity metadata",
            status.HTTP_503_SERVICE_UNAVAILABLE,
            {"key": key or None},
        )
    return {
        "key": key,
        "eTag": e_tag,
        "versionId": None,
        "lastModified": object_last_modified_iso(modified_at),
        "size": s3_object_size(item.get("Size")),
    }

def pin_listed_s3_object_identity(
    client: Any,
    bucket: str,
    listed_identity: dict[str, Any],
    job: ETLJobModel,
) -> dict[str, Any]:
    key = str(listed_identity["key"])
    try:
        response = client.head_object(Bucket=bucket, Key=key)
    except Exception as exc:
        raise ApiError(
            "SERVICE_UNAVAILABLE",
            "Incremental source object identity could not be pinned",
            status.HTTP_503_SERVICE_UNAVAILABLE,
            {
                "bucket": bucket,
                "key": key,
                "reason": compact_storage_text(exc, limit=1000),
            },
        ) from exc

    head_identity = head_s3_object_identity(key, response)
    mismatch_fields = source_object_identity_mismatch_fields(
        listed_identity,
        head_identity,
        include_version=False,
    )
    if mismatch_fields:
        raise source_object_identity_changed_error(job, key, mismatch_fields)
    return head_identity

def head_s3_object_identity(key: str, response: dict[str, Any]) -> dict[str, Any]:
    e_tag = normalize_s3_etag(response.get("ETag"))
    modified_at = object_last_modified(response.get("LastModified"))
    if not e_tag or modified_at is None or response.get("ContentLength") is None:
        raise ApiError(
            "SOURCE_OBJECT_IDENTITY_UNAVAILABLE",
            "Incremental source HEAD did not provide complete object identity metadata",
            status.HTTP_503_SERVICE_UNAVAILABLE,
            {"key": key},
        )
    return {
        "key": key,
        "eTag": e_tag,
        "versionId": normalize_s3_version_id(response.get("VersionId")),
        "lastModified": object_last_modified_iso(modified_at),
        "size": s3_object_size(response.get("ContentLength")),
    }

def source_object_identity_mismatch_fields(
    expected: dict[str, Any],
    actual: dict[str, Any],
    *,
    include_version: bool = True,
) -> list[str]:
    fields = ["key", "eTag", "lastModified", "size"]
    if include_version:
        fields.append("versionId")
    return [field for field in fields if expected.get(field) != actual.get(field)]

def source_object_identity_changed_error(
    job: ETLJobModel,
    key: str,
    mismatch_fields: list[str],
) -> ApiError:
    return ApiError(
        "SOURCE_OBJECT_IDENTITY_CHANGED",
        "Incremental source object changed while its fixed inventory was being created",
        status.HTTP_409_CONFLICT,
        {"jobId": job.id, "key": key, "mismatchFields": mismatch_fields},
    )

def parse_incremental_timestamp(value: str | None, field_name: str) -> datetime | None:
    normalized = str(value or "").strip()
    if not normalized:
        return None
    try:
        parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            f"Invalid {field_name} timestamp",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        ) from exc
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)

def object_last_modified(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    try:
        return parse_incremental_timestamp(str(value or ""), "LastModified")
    except ApiError:
        return None

def object_last_modified_iso(value: Any) -> str:
    modified_at = object_last_modified(value)
    if modified_at is None:
        return ""
    return modified_at.isoformat(timespec="milliseconds").replace("+00:00", "Z")

def normalize_s3_etag(value: Any) -> str:
    normalized = str(value or "").strip()
    if normalized.startswith("W/"):
        normalized = normalized[2:].strip()
    return normalized[1:-1] if len(normalized) >= 2 and normalized[0] == normalized[-1] == '"' else normalized

def normalize_s3_version_id(value: Any) -> str | None:
    normalized = str(value or "").strip()
    return None if not normalized or normalized.casefold() == "null" else normalized

def s3_object_size(value: Any) -> int:
    if isinstance(value, bool):
        raise ApiError(
            "SOURCE_OBJECT_IDENTITY_UNAVAILABLE",
            "Incremental source object size is invalid",
            status.HTTP_503_SERVICE_UNAVAILABLE,
        )
    try:
        size = int(value)
    except (TypeError, ValueError) as exc:
        raise ApiError(
            "SOURCE_OBJECT_IDENTITY_UNAVAILABLE",
            "Incremental source object size is invalid",
            status.HTTP_503_SERVICE_UNAVAILABLE,
        ) from exc
    if size < 0:
        raise ApiError(
            "SOURCE_OBJECT_IDENTITY_UNAVAILABLE",
            "Incremental source object size is invalid",
            status.HTTP_503_SERVICE_UNAVAILABLE,
        )
    return size

def incremental_object_key_limit() -> int:
    try:
        return max(1, int(os.environ.get("ASKLAKE_INCREMENTAL_OBJECT_KEY_LIMIT") or "20000"))
    except ValueError:
        return 20000

def source_identity_worker_count(item_count: int) -> int:
    try:
        configured = int(os.environ.get("ASKLAKE_SOURCE_IDENTITY_WORKERS") or DEFAULT_SOURCE_IDENTITY_WORKERS)
    except ValueError:
        configured = DEFAULT_SOURCE_IDENTITY_WORKERS
    return max(1, min(item_count, configured, MAX_SOURCE_IDENTITY_WORKERS))

def build_source_s3_client(job: ETLJobModel) -> Any:
    fields = s3_source_config_fields(job.source_config or [])
    try:
        import boto3
        from botocore.config import Config
    except ImportError as exc:
        raise ApiError(
            "SERVICE_UNAVAILABLE",
            "Python S3 client dependency is not installed",
            status.HTTP_503_SERVICE_UNAVAILABLE,
        ) from exc
    endpoint = (
        fields.get("endpoint url")
        or fields.get("endpoint")
        or os.environ.get("S3_ENDPOINT")
        or os.environ.get("MINIO_ENDPOINT")
    )
    access_key = (
        fields.get("access key")
        or os.environ.get("AWS_ACCESS_KEY_ID")
        or os.environ.get("MINIO_ACCESS_KEY")
    )
    secret_key = (
        fields.get("secret key")
        or os.environ.get("AWS_SECRET_ACCESS_KEY")
        or os.environ.get("MINIO_SECRET_KEY")
    )
    region = fields.get("region") or os.environ.get("AWS_REGION") or os.environ.get("MINIO_REGION") or "us-east-1"
    force_path_style = str(
        fields.get("use path style") or os.environ.get("S3_FORCE_PATH_STYLE") or "true"
    ).casefold() != "false"
    kwargs: dict[str, Any] = {
        "config": Config(s3={"addressing_style": "path" if force_path_style else "auto"}),
        "region_name": region,
    }
    if endpoint:
        kwargs["endpoint_url"] = endpoint
    if access_key:
        kwargs["aws_access_key_id"] = access_key
    if secret_key:
        kwargs["aws_secret_access_key"] = secret_key
    return boto3.client("s3", **kwargs)
