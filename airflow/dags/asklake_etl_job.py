from __future__ import annotations

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
    base_url = os.environ.get("ASKLAKE_EXECUTION_API_BASE_URL", "").rstrip("/")
    token = os.environ.get("ASKLAKE_EXECUTION_API_TOKEN", "")
    if not base_url or not token:
        raise RuntimeError(
            f"{operation} requires ASKLAKE_EXECUTION_API_BASE_URL and "
            "ASKLAKE_EXECUTION_API_TOKEN in the Airflow runtime."
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
        int(os.environ.get("ASKLAKE_EXECUTION_API_TIMEOUT_SECONDS", "930")),
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            payload = json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        response_body = exc.read().decode("utf-8", errors="replace")[-2000:]
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
    return post_asklake_execution_api(
        f"/api/internal/airflow/spark-runs/{quote(run_id, safe='')}/execute",
        {
            "command": str(conf.get("command") or "run"),
            "jobId": str(conf["jobId"]),
        },
        operation="Spark execution",
    )


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
    tags=["asklake", "spark", "batch"],
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
        if conf.get("executionMode") != "smoke":
            job = conf.get("job")
            if not isinstance(job, dict):
                raise ValueError("AskLake Spark DAG Run conf must include job metadata.")
            missing = [key for key in ("sourceType", "target") if not job.get(key)]
            if missing:
                raise ValueError(f"AskLake Spark job metadata is missing: {', '.join(missing)}")
        return conf

    @task(task_id="spark_process_write")
    def spark_process_write(conf: dict[str, Any]) -> dict[str, Any]:
        if conf.get("executionMode") == "smoke":
            time.sleep(sleep_seconds(conf, "smokeProcessSeconds", 0))
            if conf.get("forceFail"):
                raise RuntimeError("AskLake smoke forced failure from dag_run.conf.forceFail.")
            input_rows = len(conf.get("job", {}).get("schemaSampleRows") or []) or 10
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

    @task(task_id="publish_run_result")
    def publish_run_result(conf: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
        return publish_catalog_result(conf, result)

    validated_conf = validate_spark_request(receive_asklake_run())
    spark_result = spark_process_write(validated_conf)
    publish_run_result(validated_conf, spark_result)


asklake_etl_job()
