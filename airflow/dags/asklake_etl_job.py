from __future__ import annotations

from datetime import timedelta
import json
import os
import time
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import quote

import pendulum

try:
    from airflow.sdk import dag, task
except ImportError:  # Airflow 2 compatibility for local fallback environments.
    from airflow.decorators import dag, task


class SparkExecutionAlreadyActive(RuntimeError):
    """The backend still owns this Run and Airflow must wait for its result."""


def sleep_seconds(conf: dict[str, Any], key: str, default: int) -> int:
    try:
        return max(0, min(int(conf.get(key, default)), 60))
    except (TypeError, ValueError):
        return default


def post_asklake_execution_api(
    route: str,
    body: dict[str, Any],
    *,
    operation: str,
) -> dict[str, Any]:
    base_url = str(
        os.environ.get("ASKLAKE_EXECUTION_API_BASE_URL")
        or os.environ.get("AIRFLOW_INTERNAL_BASE_URL")
        or ""
    ).rstrip("/")
    token = str(
        os.environ.get("ASKLAKE_EXECUTION_API_TOKEN")
        or os.environ.get("AIRFLOW_INTERNAL_TOKEN")
        or ""
    )
    if not base_url or not token:
        raise RuntimeError(
            f"{operation} requires an AskLake internal base URL and token "
            "in the Airflow runtime."
        )

    url = f"{base_url}{route}"
    encoded_body = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=encoded_body,
        method="POST",
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    timeout_seconds = max(
        30,
        int(
            os.environ.get("ASKLAKE_EXECUTION_API_TIMEOUT_SECONDS")
            or os.environ.get("AIRFLOW_INTERNAL_TIMEOUT_SECONDS")
            or "930"
        ),
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            payload = json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        response_body = exc.read().decode("utf-8", errors="replace")[-2000:]
        try:
            error_code = str(json.loads(response_body).get("error", {}).get("code") or "")
        except (AttributeError, json.JSONDecodeError):
            error_code = ""
        if exc.code == 409 and error_code == "SPARK_RUN_ALREADY_EXECUTING":
            raise SparkExecutionAlreadyActive(response_body) from exc
        raise RuntimeError(
            f"AskLake {operation} API returned HTTP {exc.code}: {response_body}"
        ) from exc
    except (TimeoutError, urllib.error.URLError) as exc:
        raise RuntimeError(f"AskLake {operation} API request failed: {exc}") from exc

    if not isinstance(payload, dict):
        raise RuntimeError(f"AskLake {operation} API returned an invalid response.")
    return payload


def execute_spark_run(conf: dict[str, Any]) -> dict[str, Any]:
    run_id = str(conf["runId"])
    source_boundary = conf.get("sourceBoundary")
    wait_seconds = max(
        60,
        int(os.environ.get("ASKLAKE_SPARK_RUN_TIMEOUT_SECONDS") or "7200"),
    )
    retry_seconds = max(
        1,
        min(int(os.environ.get("ASKLAKE_SPARK_ACTIVE_RETRY_SECONDS") or "5"), 60),
    )
    deadline = time.monotonic() + wait_seconds
    while True:
        try:
            return post_asklake_execution_api(
                f"/api/internal/airflow/spark-runs/{quote(run_id, safe='')}/execute",
                {
                    "command": str(conf.get("command") or "run"),
                    "jobId": str(conf["jobId"]),
                    **({"sourceBoundary": source_boundary} if isinstance(source_boundary, dict) else {}),
                },
                operation="Spark execution",
            )
        except SparkExecutionAlreadyActive as exc:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError(
                    f"Spark execution for {run_id} remained active for {wait_seconds}s."
                ) from exc
            time.sleep(min(retry_seconds, remaining))


def reconcile_catalog_run(conf: dict[str, Any]) -> dict[str, Any]:
    run_id = str(conf["runId"])
    payload = post_asklake_execution_api(
        f"/api/internal/airflow/spark-runs/{quote(run_id, safe='')}/catalog",
        {"jobId": str(conf["jobId"])},
        operation="Catalog reconciliation",
    )
    if payload.get("status") != "success" or str(payload.get("runId") or "") != run_id:
        raise RuntimeError("AskLake Catalog reconciliation API returned an invalid success response.")
    dataset = payload.get("dataset")
    if not isinstance(dataset, dict) or not dataset.get("id"):
        raise RuntimeError("AskLake Catalog reconciliation response did not include dataset.id.")
    return payload


def publish_catalog_result(conf: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    time.sleep(sleep_seconds(conf, "smokeCatalogSeconds", 0))
    if result.get("status") != "success" or not result.get("outputPath"):
        raise RuntimeError("Successful Spark result must include outputPath.")

    run_id = str(conf["runId"])
    if str(result.get("runId") or "") != run_id:
        raise RuntimeError("Spark result runId does not match the Airflow DAG Run configuration.")

    published = {
        "inputRows": result.get("inputRows"),
        "outputPath": result.get("outputPath"),
        "outputRows": result.get("outputRows"),
        "runId": run_id,
        "status": "success",
    }
    if conf.get("executionMode") == "smoke":
        return published

    catalog = reconcile_catalog_run(conf)
    return {
        **published,
        "catalogDatasetId": catalog["dataset"]["id"],
        "catalogReconciledAt": catalog.get("reconciledAt"),
    }
@dag(
    dag_id="asklake_etl_job",
    schedule=None,
    start_date=pendulum.datetime(2026, 1, 1, tz="UTC"),
    catchup=False,
    tags=["asklake", "etl", "spark", "batch"],
    is_paused_upon_creation=False,
)
def asklake_etl_job() -> None:
    @task(task_id="receive_asklake_run")
    def receive_asklake_run(**context: Any) -> dict[str, Any]:
        conf = dict(context["dag_run"].conf or {})
        if not conf.get("runId") or not conf.get("jobId"):
            raise ValueError("AskLake DAG Run conf must include jobId and runId.")
        time.sleep(sleep_seconds(conf, "smokeReceiveSeconds", 0))
        return conf

    @task(task_id="validate_spark_request")
    def validate_spark_request(conf: dict[str, Any]) -> dict[str, Any]:
        time.sleep(sleep_seconds(conf, "smokeReadSeconds", 0))
        return conf

    @task(
        task_id="spark_process_write",
        retries=4,
        retry_delay=timedelta(seconds=15),
        retry_exponential_backoff=True,
        max_retry_delay=timedelta(minutes=2),
    )
    def spark_process_write(conf: dict[str, Any]) -> dict[str, Any]:
        if conf.get("executionMode") == "smoke":
            time.sleep(sleep_seconds(conf, "smokeProcessSeconds", 0))
            if conf.get("forceFail"):
                raise RuntimeError("AskLake smoke forced failure from dag_run.conf.forceFail.")
            input_rows = int(conf.get("smokeInputRows") or 10)
            result = {
                "inputRows": input_rows,
                "outputPath": f"airflow-smoke://{conf.get('jobId')}/{conf.get('runId')}",
                "outputRows": input_rows,
                "runId": conf.get("runId"),
                "smokeCatalogSeconds": conf.get("smokeCatalogSeconds", 0),
                "status": "success",
            }
        else:
            result = execute_spark_run(conf)

        if result.get("status") != "success":
            failed_stage = result.get("failedStage") or "Spark batch"
            error = result.get("error") or "Spark execution failed."
            raise RuntimeError(f"{failed_stage}: {error}")
        return result
    @task(
        task_id="publish_run_result",
        retries=2,
        retry_delay=timedelta(seconds=30),
    )
    def publish_run_result(conf: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
        return publish_catalog_result(conf, result)

    validated_conf = validate_spark_request(receive_asklake_run())
    spark_result = spark_process_write(validated_conf)
    publish_run_result(validated_conf, spark_result)


asklake_etl_job()
