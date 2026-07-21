import importlib.util
import io
import json
import os
import sys
import types
import urllib.error
from pathlib import Path
from unittest.mock import patch


ROOT_DIR = Path(__file__).resolve().parents[2]
DAG_PATH = ROOT_DIR / "airflow" / "dags" / "asklake_etl_job.py"


class FakeResponse:
    def __init__(self, payload: dict):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")


def load_dag_module():
    airflow_module = types.ModuleType("airflow")
    airflow_module.__path__ = []
    airflow_sdk_module = types.ModuleType("airflow.sdk")

    def fake_dag(*_args, **_kwargs):
        def decorate(_function):
            return lambda: None

        return decorate

    airflow_sdk_module.dag = fake_dag
    airflow_sdk_module.task = lambda *_args, **_kwargs: None
    pendulum_module = types.ModuleType("pendulum")
    pendulum_module.datetime = lambda *_args, **_kwargs: None

    with patch.dict(
        sys.modules,
        {
            "airflow": airflow_module,
            "airflow.sdk": airflow_sdk_module,
            "pendulum": pendulum_module,
        },
    ):
        spec = importlib.util.spec_from_file_location("asklake_etl_job_under_test", DAG_PATH)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module


def verify_active_spark_retry(module, conf: dict, spark_result: dict) -> None:
    spark_attempts = 0

    def active_then_success(request, timeout):
        nonlocal spark_attempts
        spark_attempts += 1
        if spark_attempts < 3:
            raise urllib.error.HTTPError(
                request.full_url,
                409,
                "Spark still active",
                hdrs=None,
                fp=io.BytesIO(b'{"error":{"code":"SPARK_RUN_ALREADY_EXECUTING"}}'),
            )
        return FakeResponse(spark_result)

    with patch.dict(
        os.environ,
        {
            "ASKLAKE_EXECUTION_API_BASE_URL": "http://asklake-backend:8080",
            "ASKLAKE_EXECUTION_API_TOKEN": "phase3-token",
            "ASKLAKE_SPARK_ACTIVE_RETRY_SECONDS": "1",
            "ASKLAKE_SPARK_RUN_TIMEOUT_SECONDS": "60",
        },
        clear=False,
    ), patch.object(module.urllib.request, "urlopen", side_effect=active_then_success), patch.object(
        module.time, "sleep"
    ) as sleep:
        resumed_result = module.execute_spark_run(conf)

    assert resumed_result == spark_result
    assert spark_attempts == 3
    assert sleep.call_count == 2


def verify_task_retry_configuration(dag_source: str) -> None:
    assert '''@task(
        task_id="spark_process_write",
        retries=4,
        retry_delay=timedelta(seconds=15),
        retry_exponential_backoff=True,
        max_retry_delay=timedelta(minutes=2),
    )''' in dag_source, "spark_process_write must survive transient backend DNS and restart windows."
    assert '''@task(
        task_id="publish_run_result",
        retries=2,
        retry_delay=timedelta(seconds=30),
    )''' in dag_source, "publish_run_result must retry Catalog reconciliation without rerunning Spark."


def main() -> None:
    module = load_dag_module()
    dag_source = DAG_PATH.read_text(encoding="utf-8")
    verify_task_retry_configuration(dag_source)
    source_boundary = {
        "broker": "boot.example.kafka-serverless.ap-northeast-2.amazonaws.com:9098",
        "checkpointPath": "s3a://asklake-output/eks-mvp/checkpoints/run-phase3",
        "consumerGroup": "asklake-eks-mvp-spark-v1",
        "expectedCount": 2,
        "fixtureBatchId": "fixture-batch-phase3",
        "kind": "kafka_snapshot",
        "outputPath": "s3a://asklake-output/eks-mvp/output/run-phase3",
        "snapshotId": "run-phase3",
        "topic": "asklake.eks-mvp.fixture.v1",
    }
    conf = {
        "executionMode": "spark",
        "jobId": "job-phase3",
        "runId": "run-phase3",
        "sourceBoundary": source_boundary,
    }
    spark_result = {
        "inputRows": 2,
        "outputPath": "s3a://asklake-output/phase3/run-phase3",
        "outputRows": 2,
        "runId": "run-phase3",
        "status": "success",
    }
    catalog_payload = {
        "dataset": {"id": "dataset-phase3", "name": "phase3"},
        "reconciledAt": "2026-07-11T00:00:00Z",
        "runId": "run-phase3",
        "status": "success",
    }
    captured = {}

    def spark_urlopen(request, timeout):
        captured["sparkBody"] = json.loads(request.data.decode("utf-8"))
        captured["sparkUrl"] = request.full_url
        return FakeResponse(spark_result)

    with patch.dict(
        os.environ,
        {
            "ASKLAKE_EXECUTION_API_BASE_URL": "http://asklake-backend:8080",
            "ASKLAKE_EXECUTION_API_TOKEN": "phase3-token",
        },
        clear=False,
    ), patch.object(module.urllib.request, "urlopen", side_effect=spark_urlopen):
        executed = module.execute_spark_run(conf)

    assert captured["sparkUrl"].endswith("/api/internal/airflow/spark-runs/run-phase3/execute")
    assert captured["sparkBody"] == {
        "command": "run",
        "jobId": "job-phase3",
        "sourceBoundary": source_boundary,
    }
    assert executed["runId"] == "run-phase3"

    def successful_urlopen(request, timeout):
        captured["body"] = json.loads(request.data.decode("utf-8"))
        captured["authorization"] = request.get_header("Authorization")
        captured["timeout"] = timeout
        captured["url"] = request.full_url
        return FakeResponse(catalog_payload)

    with patch.dict(
        os.environ,
        {
            "ASKLAKE_EXECUTION_API_BASE_URL": "http://asklake-backend:8080",
            "ASKLAKE_EXECUTION_API_TOKEN": "phase3-token",
            "ASKLAKE_EXECUTION_API_TIMEOUT_SECONDS": "45",
        },
        clear=False,
    ), patch.object(module.urllib.request, "urlopen", side_effect=successful_urlopen):
        published = module.publish_catalog_result(conf, spark_result)

    assert captured["url"].endswith("/api/internal/airflow/spark-runs/run-phase3/catalog")
    assert captured["body"] == {"jobId": "job-phase3"}
    assert captured["authorization"] == "Bearer phase3-token"
    assert captured["timeout"] == 45
    assert published["catalogDatasetId"] == "dataset-phase3"
    assert published["catalogReconciledAt"] == "2026-07-11T00:00:00Z"
    assert "dataset" not in published

    verify_active_spark_retry(module, conf, spark_result)

    smoke_conf = {**conf, "executionMode": "smoke"}
    with patch.object(module, "reconcile_catalog_run") as reconcile:
        smoke_published = module.publish_catalog_result(smoke_conf, spark_result)
    reconcile.assert_not_called()
    assert smoke_published["status"] == "success"
    assert "catalogDatasetId" not in smoke_published

    with patch.object(module, "reconcile_catalog_run") as reconcile:
        try:
            module.publish_catalog_result(conf, {**spark_result, "runId": "another-run"})
        except RuntimeError as exc:
            assert "does not match" in str(exc)
        else:
            raise AssertionError("A mismatched Spark result runId must fail publication.")
    reconcile.assert_not_called()

    http_error = urllib.error.HTTPError(
        captured["url"],
        500,
        "Catalog failed",
        hdrs=None,
        fp=io.BytesIO(b'{"error":{"code":"CATALOG_RECONCILIATION_FAILED"}}'),
    )
    with patch.dict(
        os.environ,
        {
            "ASKLAKE_EXECUTION_API_BASE_URL": "http://asklake-backend:8080",
            "ASKLAKE_EXECUTION_API_TOKEN": "phase3-token",
        },
        clear=False,
    ), patch.object(module.urllib.request, "urlopen", side_effect=http_error):
        try:
            module.publish_catalog_result(conf, spark_result)
        except RuntimeError as exc:
            assert "Catalog reconciliation API returned HTTP 500" in str(exc)
            assert "CATALOG_RECONCILIATION_FAILED" in str(exc)
        else:
            raise AssertionError("Catalog HTTP failure must fail publish_run_result.")

    print("verify-airflow-dag-catalog-wiring: ok")


if __name__ == "__main__":
    main()
