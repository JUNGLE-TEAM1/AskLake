#!/usr/bin/env python3

import json
import os
import socket
import sys
from urllib.parse import urlparse

import boto3
import psycopg
from botocore.exceptions import ClientError


def required(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise RuntimeError(f"missing_{name.lower()}")
    return value


def denied_list(client, bucket: str, prefix: str) -> bool:
    try:
        client.list_objects_v2(Bucket=bucket, Prefix=prefix, MaxKeys=1)
    except ClientError as error:
        return error.response.get("Error", {}).get("Code") in {"AccessDenied", "AllAccessDisabled"}
    return False


def main() -> None:
    region = required("AWS_REGION")
    expected_role = required("EXPECTED_ROLE_ARN")
    warehouse_bucket = required("WAREHOUSE_BUCKET")
    warehouse_key = required("WAREHOUSE_KEY")
    warehouse_denied_prefix = required("WAREHOUSE_DENIED_PREFIX")
    query_bucket = required("QUERY_BUCKET")
    query_key = required("QUERY_KEY")
    query_denied_prefix = required("QUERY_DENIED_PREFIX")
    dns_name = required("SMOKE_SERVICE_DNS")

    identity = boto3.client("sts", region_name=region).get_caller_identity()
    expected_account = expected_role.split(":")[4]
    expected_role_name = expected_role.rsplit("/", 1)[-1]
    arn = identity.get("Arn", "")
    if identity.get("Account") != expected_account or f":assumed-role/{expected_role_name}/" not in arn:
        raise RuntimeError("unexpected_pod_identity")

    socket.getaddrinfo(dns_name, 8443, type=socket.SOCK_STREAM)

    jdbc_url = required("TRINO_ICEBERG_JDBC_URL")
    if not jdbc_url.startswith("jdbc:"):
        raise RuntimeError("invalid_jdbc_url")
    parsed = urlparse(jdbc_url.removeprefix("jdbc:"))
    database = parsed.path.lstrip("/")
    if database != "iceberg_catalog" or not parsed.hostname:
        raise RuntimeError("unexpected_jdbc_database")
    with psycopg.connect(
        host=parsed.hostname,
        port=parsed.port or 5432,
        dbname=database,
        user=required("TRINO_ICEBERG_JDBC_USER"),
        password=required("TRINO_ICEBERG_JDBC_PASSWORD"),
        sslmode="require",
        connect_timeout=10,
    ) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT current_database(), current_user")
            row = cursor.fetchone()
            if row != ("iceberg_catalog", "iceberg_catalog"):
                raise RuntimeError("unexpected_database_identity")

    s3 = boto3.client("s3", region_name=region)
    payload = b"asklake-trino-data-plane-smoke"
    written = []
    try:
        for bucket, key in ((warehouse_bucket, warehouse_key), (query_bucket, query_key)):
            s3.put_object(Bucket=bucket, Key=key, Body=payload)
            written.append((bucket, key))
            body = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
            if body != payload:
                raise RuntimeError("s3_round_trip_mismatch")
            listed = s3.list_objects_v2(Bucket=bucket, Prefix=key, MaxKeys=1)
            if not any(item.get("Key") == key for item in listed.get("Contents", [])):
                raise RuntimeError("s3_allowed_list_missing")
        if not denied_list(s3, warehouse_bucket, warehouse_denied_prefix):
            raise RuntimeError("warehouse_outside_prefix_allowed")
        if not denied_list(s3, query_bucket, query_denied_prefix):
            raise RuntimeError("query_outside_prefix_allowed")
    finally:
        for bucket, key in written:
            try:
                s3.delete_object(Bucket=bucket, Key=key)
            except ClientError:
                pass

    print(json.dumps({
        "status": "passed",
        "identity": True,
        "rds": True,
        "s3": True,
        "dns": True,
        "negativeBoundary": True,
    }, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # Sanitized: never print endpoints, object names, or credential-bearing exceptions.
        print(json.dumps({"status": "failed", "reason": type(error).__name__}, separators=(",", ":")))
        sys.exit(1)
