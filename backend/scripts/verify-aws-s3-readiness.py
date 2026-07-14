"""Fail-fast AWS S3/IAM readiness check for the production Compose stack."""

from __future__ import annotations

import os
import sys
import uuid

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError


def main() -> int:
    provider = os.environ.get("ASKLAKE_OBJECT_STORAGE_PROVIDER", "").strip().lower()
    if provider != "aws":
        print("ASKLAKE_OBJECT_STORAGE_PROVIDER=aws is required", file=sys.stderr)
        return 2

    read_buckets = csv_env("ASKLAKE_S3_READINESS_READ_BUCKETS")
    write_buckets = csv_env("ASKLAKE_S3_READINESS_WRITE_BUCKETS")
    if not read_buckets or not write_buckets:
        print("AWS S3 readiness read/write bucket lists are required", file=sys.stderr)
        return 2

    region = os.environ.get("AWS_REGION") or os.environ.get("S3_REGION") or "ap-northeast-2"
    client = boto3.client(
        "s3",
        region_name=region,
        config=Config(connect_timeout=3, read_timeout=10, retries={"max_attempts": 2, "mode": "standard"}),
    )
    try:
        for bucket in sorted(read_buckets | write_buckets):
            client.head_bucket(Bucket=bucket)
        for bucket in sorted(read_buckets):
            client.list_objects_v2(Bucket=bucket, MaxKeys=1)
        for bucket in sorted(write_buckets):
            verify_write_round_trip(client, bucket)
    except (BotoCoreError, ClientError, RuntimeError) as error:
        print(f"AWS S3 readiness failed: {type(error).__name__}", file=sys.stderr)
        return 1

    print(
        "AWS S3 readiness passed: "
        f"region={region}, readBuckets={len(read_buckets)}, writeBuckets={len(write_buckets)}"
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


if __name__ == "__main__":
    raise SystemExit(main())
