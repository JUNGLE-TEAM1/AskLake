#!/usr/bin/env python3
"""Verify production Compose runtime edges without creating user datasets.

This is intentionally narrower than the isolated local Iceberg E2E harnesses.
It runs inside the deployed backend container, uses the instance role, and only
creates the temporary Trino readiness table/result object which the existing
readiness verifier removes before returning.
"""

from __future__ import annotations

import json
import importlib.util
import os
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import urlopen

from app.core.config import settings


def verify_trino_readiness() -> None:
    path = Path(__file__).with_name("verify-trino-production-readiness.py")
    spec = importlib.util.spec_from_file_location("asklake_trino_production_readiness", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load the Trino production readiness verifier")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.main()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def bounded_positive_integer(name: str, *, default: int, minimum: int, maximum: int) -> int:
    raw = str(os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as error:
        raise RuntimeError(f"{name} must be an integer between {minimum} and {maximum}") from error
    if not minimum <= value <= maximum:
        raise RuntimeError(f"{name} must be an integer between {minimum} and {maximum}")
    return value


def retry_probe(label: str, probe):
    retries = bounded_positive_integer(
        "ASKLAKE_PRODUCTION_SMOKE_RETRIES", default=12, minimum=1, maximum=60
    )
    delay_seconds = bounded_positive_integer(
        "ASKLAKE_PRODUCTION_SMOKE_RETRY_DELAY_SECONDS", default=5, minimum=1, maximum=60
    )
    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            return {**probe(), "attempt": attempt}
        except Exception as error:
            last_error = error
            if attempt < retries:
                time.sleep(delay_seconds)
    raise RuntimeError(f"{label} probe failed after {retries} attempts: {last_error}") from last_error


def verify_spark_rest() -> dict[str, object]:
    rest_url = str(os.environ.get("ASKLAKE_SPARK_REST_URL") or "").rstrip("/")
    require(rest_url.startswith("http://") or rest_url.startswith("https://"), "ASKLAKE_SPARK_REST_URL is required")
    probe_url = f"{rest_url}/v1/submissions/status/asklake-production-runtime-smoke"
    try:
        with urlopen(probe_url, timeout=10) as response:  # nosec B310 - internal Compose URL is configured by deploy env
            return {"statusCode": int(response.status), "url": rest_url}
    except HTTPError as error:
        # Spark REST reports an unknown submission with 404. That still proves
        # the backend can reach the actual master REST endpoint.
        if error.code != 404:
            raise RuntimeError(f"Spark REST probe returned HTTP {error.code}") from error
        return {"statusCode": error.code, "url": rest_url}
    except OSError as error:
        raise RuntimeError(f"Spark REST probe failed: {error}") from error


def verify_kafka_metadata() -> dict[str, object]:
    broker = str(os.environ.get("ASKLAKE_KAFKA_BROKER") or "").strip()
    require(broker, "ASKLAKE_KAFKA_BROKER is required")
    program = """
import { Kafka } from 'kafkajs';
const broker = process.env.ASKLAKE_KAFKA_BROKER;
const kafka = new Kafka({ brokers: [broker], clientId: 'asklake-production-runtime-smoke', retry: { retries: 1 } });
const admin = kafka.admin();
try {
  await admin.connect();
  const metadata = await admin.fetchTopicMetadata();
  console.log(JSON.stringify({ broker, topicCount: metadata.topics.length }));
} finally {
  await admin.disconnect().catch(() => {});
}
"""
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", program],
        text=True,
        capture_output=True,
        env={**os.environ, "ASKLAKE_KAFKA_BROKER": broker},
        timeout=30,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"Kafka metadata probe failed: {(completed.stderr or completed.stdout).strip()}")
    try:
        payload = json.loads(completed.stdout.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError) as error:
        raise RuntimeError("Kafka metadata probe returned an invalid payload") from error
    require(payload.get("broker") == broker, "Kafka metadata probe returned an unexpected broker")
    return payload


def main() -> None:
    require(settings.app_env.casefold() == "production", "Production runtime smoke requires APP_ENV=production")
    require(settings.asklake_object_storage_provider == "aws", "Production runtime smoke requires AWS object storage")
    require(settings.trino_enabled, "Production runtime smoke requires TRINO_ENABLED=true")
    require(str(os.environ.get("ASKLAKE_SPARK_RUNNER") or "").casefold() == "rest", "Production runtime smoke requires ASKLAKE_SPARK_RUNNER=rest")

    spark = retry_probe("Spark REST", verify_spark_rest)
    kafka = retry_probe("Kafka metadata", verify_kafka_metadata)
    verify_trino_readiness()
    print(json.dumps({
        "iceberg": "verified",
        "kafka": kafka,
        "ok": True,
        "sparkRest": spark,
        "trino": "verified",
    }, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error), "ok": False}), file=sys.stderr)
        raise SystemExit(1) from error
