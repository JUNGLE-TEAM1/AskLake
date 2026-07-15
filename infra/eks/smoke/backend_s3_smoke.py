#!/usr/bin/env python3

import os

import boto3
from botocore.exceptions import ClientError


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"missing required environment variable: {name}")
    return value


def expect_denied(label: str, operation) -> None:
    try:
        operation()
    except ClientError as error:
        code = error.response.get("Error", {}).get("Code", "Unknown")
        if code not in {"AccessDenied", "AllAccessDisabled"}:
            raise RuntimeError(f"{label}=unexpected_error:{code}") from None
        print(f"{label}=denied")
        return
    raise RuntimeError(f"{label}=unexpectedly_allowed")


def main() -> None:
    region = required("AWS_REGION")
    expected_role_name = required("EXPECTED_ROLE_NAME")
    positive_bucket = required("POSITIVE_BUCKET")
    positive_key = required("POSITIVE_KEY")
    readonly_bucket = required("READONLY_BUCKET")
    readonly_key = required("READONLY_KEY")
    denied_read_bucket = required("DENIED_READ_BUCKET")
    denied_read_key = required("DENIED_READ_KEY")
    denied_list_prefix = required("DENIED_LIST_PREFIX")

    identity = boto3.client("sts", region_name=region).get_caller_identity()
    if f"assumed-role/{expected_role_name}/" not in identity.get("Arn", ""):
        raise RuntimeError("pod_identity=unexpected_role")
    print("pod_identity=expected_backend_role")

    s3 = boto3.client("s3", region_name=region)
    payload = b"asklake-backend-s3-smoke-v1"

    try:
        s3.put_object(Bucket=positive_bucket, Key=positive_key, Body=payload)
        result = s3.get_object(Bucket=positive_bucket, Key=positive_key)
        if result["Body"].read() != payload:
            raise RuntimeError("positive_round_trip=payload_mismatch")
        s3.delete_object(Bucket=positive_bucket, Key=positive_key)

        try:
            s3.get_object(Bucket=positive_bucket, Key=positive_key)
        except ClientError as error:
            code = error.response.get("Error", {}).get("Code", "Unknown")
            if code not in {"NoSuchKey", "404"}:
                raise RuntimeError(f"positive_cleanup=unexpected_error:{code}") from None
        else:
            raise RuntimeError("positive_cleanup=object_still_exists")
        print("positive_put_get_delete=true")

        expect_denied(
            "readonly_prefix_put",
            lambda: s3.put_object(Bucket=readonly_bucket, Key=readonly_key, Body=payload),
        )
        expect_denied(
            "outside_prefix_get",
            lambda: s3.get_object(Bucket=denied_read_bucket, Key=denied_read_key),
        )
        expect_denied(
            "outside_prefix_list",
            lambda: s3.list_objects_v2(
                Bucket=denied_read_bucket,
                Prefix=denied_list_prefix,
                MaxKeys=1,
            ),
        )
        expect_denied(
            "bucket_location",
            lambda: s3.get_bucket_location(Bucket=positive_bucket),
        )
    finally:
        try:
            s3.delete_object(Bucket=positive_bucket, Key=positive_key)
        except ClientError:
            pass

    print("backend_s3_boundary_smoke=passed")


if __name__ == "__main__":
    main()
