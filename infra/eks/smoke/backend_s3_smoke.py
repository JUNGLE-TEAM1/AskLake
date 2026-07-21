#!/usr/bin/env python3

import json
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


def assert_payload(label: str, result, expected: bytes) -> None:
    if result["Body"].read() != expected:
        raise RuntimeError(f"{label}=payload_mismatch")


def main() -> None:
    region = required("AWS_REGION")
    expected_role_name = required("EXPECTED_ROLE_NAME")
    contract = json.loads(required("SMOKE_CONTRACT_JSON"))
    payload = b"asklake-backend-s3-smoke-v2"

    identity = boto3.client("sts", region_name=region).get_caller_identity()
    if f"assumed-role/{expected_role_name}/" not in identity.get("Arn", ""):
        raise RuntimeError("pod_identity=unexpected_role")
    print("pod_identity=expected_backend_role")

    s3 = boto3.client("s3", region_name=region)

    for boundary in contract["readOnlyBoundaries"]:
        label = boundary["label"]
        assert_payload(
            f"{label}_get",
            s3.get_object(Bucket=boundary["bucket"], Key=boundary["key"]),
            payload,
        )
        print(f"{label}_get=true")
        expect_denied(
            f"{label}_put",
            lambda boundary=boundary: s3.put_object(
                Bucket=boundary["bucket"],
                Key=boundary["key"],
                Body=payload,
            ),
        )

    for boundary in contract["writeBoundaries"]:
        label = boundary["label"]
        s3.put_object(Bucket=boundary["bucket"], Key=boundary["key"], Body=payload)
        assert_payload(
            f"{label}_get",
            s3.get_object(Bucket=boundary["bucket"], Key=boundary["key"]),
            payload,
        )
        s3.delete_object(Bucket=boundary["bucket"], Key=boundary["key"])
        print(f"{label}_put_get_delete=true")

    for boundary in contract["deniedBoundaries"]:
        label = boundary["label"]
        expect_denied(
            f"{label}_get",
            lambda boundary=boundary: s3.get_object(
                Bucket=boundary["bucket"],
                Key=boundary["key"],
            ),
        )
        expect_denied(
            f"{label}_list",
            lambda boundary=boundary: s3.list_objects_v2(
                Bucket=boundary["bucket"],
                Prefix=boundary["prefix"],
                MaxKeys=1,
            ),
        )

    expect_denied(
        "bucket_location",
        lambda: s3.get_bucket_location(Bucket=contract["metadataProbeBucket"]),
    )
    print("backend_s3_boundary_smoke=passed")


if __name__ == "__main__":
    main()
