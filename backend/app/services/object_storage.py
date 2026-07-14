"""Provider-aware object storage settings shared by FastAPI services."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ObjectStorageRuntime:
    provider: str
    endpoint: str | None
    force_path_style: bool
    region: str
    access_key: str | None = None
    secret_key: str | None = None

    def boto3_kwargs(self) -> dict[str, Any]:
        kwargs: dict[str, Any] = {"region_name": self.region}
        if self.endpoint:
            kwargs["endpoint_url"] = self.endpoint
        if self.access_key and self.secret_key:
            kwargs["aws_access_key_id"] = self.access_key
            kwargs["aws_secret_access_key"] = self.secret_key
        return kwargs


def object_storage_provider() -> str:
    value = os.environ.get("ASKLAKE_OBJECT_STORAGE_PROVIDER", "minio").strip().lower()
    if value in {"aws", "amazon s3", "s3"}:
        return "aws"
    if value in {"minio", "minio/s3"}:
        return "minio"
    raise RuntimeError(f"Unsupported object storage provider: {value}")


def object_storage_runtime() -> ObjectStorageRuntime:
    provider = object_storage_provider()
    if provider == "aws":
        return ObjectStorageRuntime(
            provider=provider,
            endpoint=_optional_env("S3_ENDPOINT") or _optional_env("AWS_ENDPOINT_URL_S3"),
            force_path_style=_boolean_env("S3_FORCE_PATH_STYLE", False),
            region=_optional_env("S3_REGION") or _optional_env("AWS_REGION") or "ap-northeast-2",
        )
    return ObjectStorageRuntime(
        provider=provider,
        endpoint=_optional_env("S3_ENDPOINT") or _optional_env("MINIO_ENDPOINT") or "http://127.0.0.1:9000",
        force_path_style=_boolean_env("S3_FORCE_PATH_STYLE", True),
        region=_optional_env("MINIO_REGION") or "us-east-1",
        access_key=_optional_env("MINIO_ACCESS_KEY") or _optional_env("MINIO_ROOT_USER"),
        secret_key=_optional_env("MINIO_SECRET_KEY") or _optional_env("MINIO_ROOT_PASSWORD"),
    )


def _optional_env(name: str) -> str | None:
    value = os.environ.get(name)
    return value.strip() if value and value.strip() else None


def _boolean_env(name: str, fallback: bool) -> bool:
    value = _optional_env(name)
    if value is None:
        return fallback
    return value.lower() in {"true", "1", "yes", "on"}
