"""Fail-fast S3 readiness check for AWS and the local MinIO Compose stack."""

from __future__ import annotations

import os
import sys
import uuid

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError


def main() -> int:
    provider = os.environ.get("ASKLAKE_OBJECT_STORAGE_PROVIDER", "").strip().lower()
    if provider not in {"aws", "minio"}:
        print("ASKLAKE_OBJECT_STORAGE_PROVIDER must be aws or minio", file=sys.stderr)
        return 2

    read_buckets = csv_env("ASKLAKE_S3_READINESS_READ_BUCKETS")
    write_buckets = csv_env("ASKLAKE_S3_READINESS_WRITE_BUCKETS")
    if not read_buckets or not write_buckets:
        print("S3 readiness read/write bucket lists are required", file=sys.stderr)
        return 2

    region = os.environ.get("AWS_REGION") or os.environ.get("S3_REGION") or "ap-northeast-2"
    client_options: dict[str, object] = {
        "region_name": region,
        "config": Config(
            connect_timeout=3,
            read_timeout=10,
            retries={"max_attempts": 2, "mode": "standard"},
            s3={"addressing_style": "path"} if provider == "minio" else None,
        ),
    }
    if provider == "minio":
        endpoint = (os.environ.get("MINIO_ENDPOINT") or os.environ.get("S3_ENDPOINT") or "").strip()
        access_key = (os.environ.get("MINIO_ACCESS_KEY") or os.environ.get("AWS_ACCESS_KEY_ID") or "").strip()
        secret_key = (os.environ.get("MINIO_SECRET_KEY") or os.environ.get("AWS_SECRET_ACCESS_KEY") or "").strip()
        if not endpoint or not access_key or not secret_key:
            print("MinIO readiness requires endpoint and credentials", file=sys.stderr)
            return 2
        client_options.update({
            "endpoint_url": endpoint,
            "aws_access_key_id": access_key,
            "aws_secret_access_key": secret_key,
        })
    client = boto3.client("s3", **client_options)
    try:
        if provider == "minio":
            for bucket in sorted(read_buckets | write_buckets):
                ensure_local_bucket(client, bucket)
        for bucket in sorted(read_buckets | write_buckets):
            client.head_bucket(Bucket=bucket)
        for bucket in sorted(read_buckets):
            client.list_objects_v2(Bucket=bucket, MaxKeys=1)
        for bucket in sorted(write_buckets):
            verify_write_round_trip(client, bucket)
    except (BotoCoreError, ClientError, RuntimeError) as error:
        print(f"S3 readiness failed: {type(error).__name__}", file=sys.stderr)
        return 1

    print(
        "S3 readiness passed: "
        f"provider={provider}, region={region}, "
        f"readBuckets={len(read_buckets)}, writeBuckets={len(write_buckets)}"
    )
    return 0


def csv_env(name: str) -> set[str]:
    return {value.strip() for value in os.environ.get(name, "").split(",") if value.strip()}


def verify_write_round_trip(client, bucket: str) -> None:
    key = f"__asklake_readiness/{uuid.uuid4().hex}.txt"
    payload = b"asklake-s3-readiness\n"
    uploaded = False
    try:
        client.put_object(Bucket=bucket, Key=key, Body=payload, ContentType="text/plain")
        uploaded = True
        response = client.head_object(Bucket=bucket, Key=key)
        if int(response.get("ContentLength") or -1) != len(payload):
            raise RuntimeError(f"AWS S3 readiness object size mismatch for bucket {bucket}")
    finally:
        if uploaded:
            client.delete_object(Bucket=bucket, Key=key)


def ensure_local_bucket(client, bucket: str) -> None:
    try:
        client.head_bucket(Bucket=bucket)
        return
    except ClientError as error:
        code = str(error.response.get("Error", {}).get("Code") or "")
        status = int(error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") or 0)
        if code not in {"404", "NoSuchBucket", "NotFound"} and status != 404:
            raise
    client.create_bucket(Bucket=bucket)


if __name__ == "__main__":
    raise SystemExit(main())
