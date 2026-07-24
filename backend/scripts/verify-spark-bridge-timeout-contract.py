"""Regression checks for Spark REST polling and outer bridge timeout ordering."""

import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from app.core.errors import ApiError
from app.infrastructure.runtime_io import SubprocessNodeBridge
from app.services import etl_service


original_environment = dict(os.environ)
original_job_payload = etl_service.job_payload_for_spark
original_run_node_bridge = etl_service.run_node_bridge

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

    etl_service.job_payload_for_spark = lambda _job, *_args, **_kwargs: {"id": "timeout-contract"}
    etl_service.run_node_bridge = capture_bridge
    kafka_job = SimpleNamespace(source_type="Apache Kafka", source_config=[])
    db = SimpleNamespace(commit=lambda: None, rollback=lambda: None)
    etl_service.run_spark_job(db, kafka_job, "run", "run-timeout-contract")

    assert captured["options"]["timeout_seconds"] == 61
    assert captured["options"]["timeout_seconds"] * 1000 > etl_service.spark_rest_poll_timeout_ms()
    assert captured["options"]["timeout_recovery"] is not None
    assert etl_service.continuous_maintenance_bridge_timeout_seconds(1000) == 31

    recovery_calls = []

    def raise_timeout(*_args, **_kwargs):
        raise subprocess.TimeoutExpired(cmd=["node"], timeout=1)

    etl_service.run_node_bridge = original_run_node_bridge
    timeout_bridge = SubprocessNodeBridge(
        backend_dir=BACKEND_DIR,
        scripts_dir=BACKEND_DIR / "scripts",
        runner=raise_timeout,
    )
    try:
        etl_service.run_node_bridge(
            "run-spark-job-once.mjs",
            "ASKLAKE_SPARK_RUN_RESULT",
            {},
            error_marker="ASKLAKE_SPARK_RUN_ERROR",
            timeout_seconds=1,
            timeout_recovery=lambda: recovery_calls.append("kill") or {"killed": True},
            bridge=timeout_bridge,
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
