"""Regression checks for Spark REST polling and outer bridge timeout ordering."""

import os
from pathlib import Path
import subprocess
import sys

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from app.core.errors import ApiError
from app.services import etl_service


original_environment = dict(os.environ)
original_job_payload = etl_service.job_payload_for_spark
original_run_node_bridge = etl_service.run_node_bridge
original_subprocess_run = etl_service.subprocess.run

try:
    os.environ["ASKLAKE_SPARK_RUNNER"] = "rest"
    os.environ["ASKLAKE_SPARK_RUN_TIMEOUT_SECONDS"] = "0"
    assert etl_service.spark_rest_poll_timeout_ms() == 7_200_000
    os.environ["ASKLAKE_SPARK_RUN_TIMEOUT_SECONDS"] = "1"
    os.environ["ASKLAKE_CONTINUOUS_MAINTENANCE_TIMEOUT_MS"] = "1000"

    captured = {}

    def capture_bridge(script_name, success_marker, payload, **options):
        captured.update({
            "options": options,
            "payload": payload,
            "scriptName": script_name,
            "successMarker": success_marker,
        })
        return {"status": "success"}

    etl_service.job_payload_for_spark = lambda _job: {"id": "timeout-contract"}
    etl_service.run_node_bridge = capture_bridge
    etl_service.run_spark_job(object(), "run", "run-timeout-contract")

    assert captured["payload"]["sparkRestTimeoutMs"] == 1000
    assert captured["options"]["timeout_seconds"] == 61
    assert captured["options"]["timeout_seconds"] * 1000 > captured["payload"]["sparkRestTimeoutMs"]
    assert captured["options"]["timeout_recovery"] is not None
    assert etl_service.continuous_maintenance_bridge_timeout_seconds(1000) == 31

    recovery_calls = []

    def raise_timeout(*_args, **_kwargs):
        raise subprocess.TimeoutExpired(cmd=["node"], timeout=1)

    etl_service.run_node_bridge = original_run_node_bridge
    etl_service.subprocess.run = raise_timeout
    try:
        etl_service.run_node_bridge(
            "run-spark-job-once.mjs",
            "ASKLAKE_SPARK_RUN_RESULT",
            {},
            error_marker="ASKLAKE_SPARK_RUN_ERROR",
            timeout_seconds=1,
            timeout_recovery=lambda: recovery_calls.append("kill") or {"killed": True},
        )
        raise AssertionError("A timed out bridge must raise ApiError.")
    except ApiError as error:
        assert error.code == "BACKEND_BRIDGE_TIMEOUT"
        assert error.status_code == 504
        assert error.details["recovery"]["succeeded"] is True
    assert recovery_calls == ["kill"]

    print("Spark bridge timeout contract verified: reduced polling timeout, ordered grace, and timeout recovery.")
finally:
    os.environ.clear()
    os.environ.update(original_environment)
    etl_service.job_payload_for_spark = original_job_payload
    etl_service.run_node_bridge = original_run_node_bridge
    etl_service.subprocess.run = original_subprocess_run
