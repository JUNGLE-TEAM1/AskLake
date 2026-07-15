"""Shared MinIO/AWS S3 runtime configuration for Spark launch scripts."""

from __future__ import annotations

import os


AWS_ENV_AND_INSTANCE_PROVIDERS = (
    "software.amazon.awssdk.auth.credentials.DefaultCredentialsProvider"
)
MINIO_SIMPLE_PROVIDER = "org.apache.hadoop.fs.s3a.SimpleAWSCredentialsProvider"


def object_storage_provider() -> str:
    value = os.environ.get("ASKLAKE_OBJECT_STORAGE_PROVIDER", "minio").strip().lower()
    if value in {"aws", "amazon s3", "s3"}:
        return "aws"
    if value in {"minio", "minio/s3"}:
        return "minio"
    raise RuntimeError(f"Unsupported object storage provider: {value}")


def object_storage_region() -> str:
    if object_storage_provider() == "aws":
        return os.environ.get("S3_REGION") or os.environ.get("AWS_REGION") or "ap-northeast-2"
    return os.environ.get("MINIO_REGION") or "us-east-1"


def object_storage_endpoint() -> str:
    if object_storage_provider() == "aws":
        return os.environ.get("S3_ENDPOINT") or os.environ.get("AWS_ENDPOINT_URL_S3") or ""
    return os.environ.get("MINIO_ENDPOINT") or "http://m3-minio:9000"


def object_storage_force_path_style() -> bool:
    configured = os.environ.get("S3_FORCE_PATH_STYLE")
    if configured is None or not configured.strip():
        return object_storage_provider() == "minio"
    return configured.strip().lower() in {"true", "1", "yes", "on"}


def configure_spark_builder(builder):
    """Return a SparkSession builder configured for the selected provider."""
    provider = object_storage_provider()
    endpoint = object_storage_endpoint()
    region = object_storage_region()
    builder = (
        builder
        .config("spark.hadoop.fs.s3a.endpoint.region", region)
        .config("spark.hadoop.fs.s3a.path.style.access", str(object_storage_force_path_style()).lower())
        .config("spark.hadoop.fs.s3a.connection.ssl.enabled", "true" if provider == "aws" else _minio_ssl(endpoint))
    )
    if endpoint:
        builder = builder.config("spark.hadoop.fs.s3a.endpoint", endpoint)
    if provider == "minio":
        access_key = os.environ.get("MINIO_ACCESS_KEY") or os.environ.get("MINIO_ROOT_USER") or ""
        secret_key = os.environ.get("MINIO_SECRET_KEY") or os.environ.get("MINIO_ROOT_PASSWORD") or ""
        return (
            builder
            .config("spark.hadoop.fs.s3a.access.key", access_key)
            .config("spark.hadoop.fs.s3a.secret.key", secret_key)
            .config("spark.hadoop.fs.s3a.aws.credentials.provider", MINIO_SIMPLE_PROVIDER)
        )
    return builder.config("spark.hadoop.fs.s3a.aws.credentials.provider", AWS_ENV_AND_INSTANCE_PROVIDERS)


def configure_spark_hadoop(hadoop) -> None:
    """Apply the same provider contract to a running Spark Hadoop config."""
    provider = object_storage_provider()
    endpoint = object_storage_endpoint()
    hadoop.set("fs.s3a.endpoint.region", object_storage_region())
    hadoop.set("fs.s3a.path.style.access", str(object_storage_force_path_style()).lower())
    hadoop.set("fs.s3a.connection.ssl.enabled", "true" if provider == "aws" else _minio_ssl(endpoint))
    if endpoint:
        hadoop.set("fs.s3a.endpoint", endpoint)
    if provider == "minio":
        hadoop.set("fs.s3a.access.key", os.environ.get("MINIO_ACCESS_KEY", ""))
        hadoop.set("fs.s3a.secret.key", os.environ.get("MINIO_SECRET_KEY", ""))
        hadoop.set("fs.s3a.aws.credentials.provider", MINIO_SIMPLE_PROVIDER)
    else:
        hadoop.set("fs.s3a.aws.credentials.provider", AWS_ENV_AND_INSTANCE_PROVIDERS)


def _minio_ssl(endpoint: str) -> str:
    configured = os.environ.get("MINIO_SSL_ENABLED")
    if configured is not None and configured.strip():
        return configured.strip().lower()
    return "true" if endpoint.lower().startswith("https://") else "false"
