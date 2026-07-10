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


def execute_spark_run(conf: dict[str, Any]) -> dict[str, Any]:
    base_url = os.environ.get("ASKLAKE_EXECUTION_API_BASE_URL", "").rstrip("/")
    token = os.environ.get("ASKLAKE_EXECUTION_API_TOKEN", "")
    if not base_url or not token:
        raise RuntimeError(
            "Spark execution requires ASKLAKE_EXECUTION_API_BASE_URL and "
            "ASKLAKE_EXECUTION_API_TOKEN in the Airflow runtime."
        )

    run_id = str(conf["runId"])
    url = f"{base_url}/api/internal/airflow/spark-runs/{quote(run_id, safe='')}/execute"
    body = json.dumps(
        {
            "command": str(conf.get("command") or "run"),
            "jobId": str(conf["jobId"]),
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
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
            f"AskLake Spark execution API returned HTTP {exc.code}: {response_body}"
        ) from exc
    except (TimeoutError, urllib.error.URLError) as exc:
        raise RuntimeError(f"AskLake Spark execution API request failed: {exc}") from exc

    if not isinstance(payload, dict):
        raise RuntimeError("AskLake Spark execution API returned an invalid response.")
    return payload


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
    def publish_run_result(result: dict[str, Any]) -> dict[str, Any]:
        time.sleep(sleep_seconds(result, "smokeCatalogSeconds", 0))
        if result.get("status") != "success" or not result.get("outputPath"):
            raise RuntimeError("Successful Spark result must include outputPath.")
        return {
            "inputRows": result.get("inputRows"),
            "outputPath": result.get("outputPath"),
            "outputRows": result.get("outputRows"),
            "runId": result.get("runId"),
            "status": "success",
        }

    publish_run_result(spark_process_write(validate_spark_request(receive_asklake_run())))


asklake_etl_job()
