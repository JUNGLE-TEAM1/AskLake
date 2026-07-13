"""Provider-neutral Storage Layout V1 for Spark data-plane artifacts."""

from __future__ import annotations

import json
import os
import re
import unicodedata
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import quote, unquote_to_bytes

from fastapi import status

from app.core.errors import ApiError


BACKEND_DIR = Path(__file__).resolve().parents[2]
CONTRACT_PATH = BACKEND_DIR / "fixtures" / "contracts" / "storage-layout-v1.json"
CONTRACT = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
STORAGE_LAYOUT_VERSION = str(CONTRACT["version"])


def storage_layout_config(environment: Mapping[str, str] | None = None) -> dict[str, Any]:
    env = environment if environment is not None else os.environ
    configured_environment = (
        env.get("ASKLAKE_STORAGE_ENVIRONMENT")
        or env.get("APP_ENV")
        or env.get("NODE_ENV")
        or CONTRACT["defaults"]["environment"]
    )
    defaults = CONTRACT["defaults"]["retentionDays"]
    return {
        "basePrefix": _normalize_prefix(
            env.get("ASKLAKE_STORAGE_BASE_PREFIX") or CONTRACT["defaults"]["basePrefix"],
            "ASKLAKE_STORAGE_BASE_PREFIX",
        ),
        "bucket": _normalize_bucket(
            env.get("ASKLAKE_SPARK_OUTPUT_BUCKET") or "asklake-output",
            "ASKLAKE_SPARK_OUTPUT_BUCKET",
        ),
        "environment": _safe_segment(configured_environment, "ASKLAKE_STORAGE_ENVIRONMENT").lower(),
        "retentionDays": {
            "data": _retention_days(env.get("ASKLAKE_STORAGE_DATA_RETENTION_DAYS"), defaults["data"]),
            "checkpoints": _retention_days(
                env.get("ASKLAKE_STORAGE_CHECKPOINT_RETENTION_DAYS"),
                defaults["checkpoints"],
            ),
            "manifests": _retention_days(
                env.get("ASKLAKE_STORAGE_MANIFEST_RETENTION_DAYS"),
                defaults["manifests"],
            ),
            "quarantine": _retention_days(
                env.get("ASKLAKE_STORAGE_QUARANTINE_RETENTION_DAYS"),
                defaults["quarantine"],
            ),
            "logs": _retention_days(env.get("ASKLAKE_STORAGE_LOG_RETENTION_DAYS"), defaults["logs"]),
        },
    }


def create_storage_layout(
    *,
    dataset_id: str,
    explicit_root: str | None = None,
    job_id: str | None = None,
    layer: str = "bronze",
    run_id: str | None = None,
    bucket: str | None = None,
    environment: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    env = environment if environment is not None else os.environ
    config = storage_layout_config(env)
    safe_dataset_id = _safe_segment(dataset_id, "datasetId")
    safe_layer = _safe_segment(layer or "bronze", "layer").lower()
    root = (
        canonical_object_storage_uri(explicit_root, env)
        if explicit_root and explicit_root.strip()
        else _join_uri(
            f"s3a://{_normalize_bucket(bucket or config['bucket'], 'bucket')}",
            config["basePrefix"],
            config["environment"],
            CONTRACT["segments"]["datasets"],
            safe_dataset_id,
            safe_layer,
        )
    )
    safe_job_id = _safe_segment(job_id, "jobId") if job_id else None
    safe_run_id = _safe_segment(run_id, "runId") if run_id else None
    batch_data_path = _join_uri(root, safe_run_id) if safe_run_id else None
    return {
        "batchDataPath": batch_data_path,
        "batchQuarantinePath": f"{batch_data_path}_quarantine" if batch_data_path else None,
        "checkpointPath": (
            _join_uri(root, CONTRACT["segments"]["checkpoints"], safe_job_id)
            if safe_job_id
            else None
        ),
        "continuousDataRoot": _join_uri(root, CONTRACT["segments"]["continuousData"]),
        "logReferenceRoot": _join_uri(
            root,
            CONTRACT["segments"]["logs"],
            safe_job_id or safe_dataset_id,
        ),
        "manifestRoot": _join_uri(root, CONTRACT["segments"]["manifests"]),
        "quarantineRoot": _join_uri(root, CONTRACT["segments"]["quarantine"]),
        "retentionDays": config["retentionDays"],
        "root": root,
        "version": STORAGE_LAYOUT_VERSION,
    }


def canonical_object_storage_uri(
    value: str,
    environment: Mapping[str, str] | None = None,
) -> str:
    env = environment if environment is not None else os.environ
    raw = str(value or "").strip()
    if not raw or re.search(r"[\\\x00-\x1f\x7f]", raw) or "?" in raw or "#" in raw:
        raise _storage_error(
            "Storage path must be a plain s3:// or s3a:// URI without query, fragment, or control characters."
        )
    match = re.fullmatch(r"s3a?://([^/]+)(?:/(.*))?", raw, flags=re.IGNORECASE)
    if match is None:
        raise _storage_error("Storage path must use the s3:// or s3a:// scheme.")
    storage_bucket = _normalize_bucket(match.group(1), "storage bucket")
    configured_bucket = _normalize_bucket(
        env.get("ASKLAKE_SPARK_OUTPUT_BUCKET") or "asklake-output",
        "ASKLAKE_SPARK_OUTPUT_BUCKET",
    )
    if storage_bucket == "asklake-output" and configured_bucket != "asklake-output":
        storage_bucket = configured_bucket
    object_path = _canonical_object_key_path(match.group(2) or "", "storage path")
    suffix = f"/{object_path}" if object_path else ""
    return f"s3a://{storage_bucket}{suffix}"


def assert_production_data_plane_path(
    value: str,
    environment: Mapping[str, str] | None = None,
) -> str:
    env = environment if environment is not None else os.environ
    if not _is_production(env):
        return value
    try:
        return canonical_object_storage_uri(value, env)
    except ApiError as error:
        raise _storage_error(
            "Production Spark data, checkpoint, manifest, and quarantine paths must use canonical object storage URIs.",
            code="STORAGE_LAYOUT_LOCAL_PATH_FORBIDDEN",
        ) from error


def _join_uri(root: str, *segments: str | None) -> str:
    suffix: list[str] = []
    for segment in segments:
        if segment is not None:
            suffix.extend(_normalize_generated_segments(segment, "storage segment"))
    return f"{str(root).rstrip('/')}/{'/'.join(suffix)}" if suffix else str(root).rstrip("/")


def _normalize_prefix(value: str, name: str) -> str:
    return "/".join(_normalize_generated_segments(value, name))


def _normalize_generated_segments(value: str, name: str) -> list[str]:
    raw = str(value or "").strip().strip("/")
    if not raw:
        return []
    return [_safe_segment(segment, name) for segment in raw.split("/") if segment]


def _canonical_object_key_path(value: str, name: str) -> str:
    raw = str(value or "")
    if not raw:
        return ""
    if raw.endswith("/"):
        raw = raw[:-1]
    if not raw:
        return ""
    if raw.startswith("/") or raw.endswith("/") or "//" in raw:
        raise _storage_error(f"{name} must not contain empty path segments.")
    canonical: list[str] = []
    for segment in raw.split("/"):
        if re.search(r"%(?![0-9A-Fa-f]{2})", segment):
            raise _storage_error(f"{name} contains invalid percent encoding.")
        try:
            decoded = unquote_to_bytes(segment).decode("utf-8", errors="strict")
        except UnicodeDecodeError as error:
            raise _storage_error(f"{name} contains invalid percent encoding.") from error
        if decoded in {".", ".."} or re.search(r"[/\\\x00-\x1f\x7f]", decoded):
            raise _storage_error(f"{name} contains a forbidden path segment.")
        canonical.append(quote(decoded, safe="-_.!~*'()"))
    return "/".join(canonical)


def _safe_segment(value: str | None, name: str) -> str:
    normalized = unicodedata.normalize("NFKC", str(value or "")).strip()
    if not normalized:
        raise _storage_error(f"{name} is required.")
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", normalized).strip("-")
    if not safe or safe in {".", ".."}:
        raise _storage_error(f"{name} does not contain a safe storage segment.")
    return safe


def _normalize_bucket(value: str, name: str) -> str:
    storage_bucket = re.sub(r"^s3a?://", "", str(value or "").strip(), flags=re.IGNORECASE)
    storage_bucket = storage_bucket.strip("/").lower()
    if (
        re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", storage_bucket) is None
        or ".." in storage_bucket
    ):
        raise _storage_error(f"{name} must be a valid S3 bucket name.")
    return storage_bucket


def _retention_days(value: str | None, fallback: int) -> int:
    if value is None or not str(value).strip():
        return int(fallback)
    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise _storage_error("Storage retention days must be an integer between 0 and 36500.") from error
    if parsed < 0 or parsed > 36_500:
        raise _storage_error("Storage retention days must be an integer between 0 and 36500.")
    return parsed


def _is_production(environment: Mapping[str, str]) -> bool:
    return any(
        str(environment.get(name) or "").strip().lower() in {"prod", "production"}
        for name in ("APP_ENV", "NODE_ENV")
    )


def _storage_error(message: str, *, code: str = "STORAGE_LAYOUT_INVALID") -> ApiError:
    return ApiError(code, message, status.HTTP_422_UNPROCESSABLE_ENTITY)
