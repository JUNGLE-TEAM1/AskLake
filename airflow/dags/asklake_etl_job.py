from __future__ import annotations

import time
from typing import Any

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


@dag(
    dag_id="asklake_etl_job",
    schedule=None,
    start_date=pendulum.datetime(2026, 1, 1, tz="UTC"),
    catchup=False,
    tags=["asklake", "smoke"],
    is_paused_upon_creation=False,
)
def asklake_etl_job() -> None:
    @task(task_id="receive_asklake_run")
    def receive_asklake_run(**context: Any) -> dict[str, Any]:
        conf = dict(context["dag_run"].conf or {})
        run_id = conf.get("runId")
        job_id = conf.get("jobId")
        if not run_id or not job_id:
            raise ValueError("AskLake DAG Run conf must include jobId and runId.")
        time.sleep(sleep_seconds(conf, "smokeReceiveSeconds", 2))
        return conf

    @task(task_id="spark_source_read")
    def spark_source_read(conf: dict[str, Any]) -> dict[str, Any]:
        time.sleep(sleep_seconds(conf, "smokeReadSeconds", 6))
        return {
            "conf": conf,
            "inputRows": len(conf.get("job", {}).get("schemaSampleRows") or []) or 10,
        }

    @task(task_id="transform_quality_write")
    def transform_quality_write(payload: dict[str, Any]) -> dict[str, Any]:
        conf = payload["conf"]
        time.sleep(sleep_seconds(conf, "smokeProcessSeconds", 8))
        if conf.get("forceFail"):
            raise RuntimeError("AskLake smoke forced failure from dag_run.conf.forceFail.")
        return {
            **payload,
            "outputRows": payload.get("inputRows", 0),
            "outputPath": f"airflow-smoke://{conf.get('jobId')}/{conf.get('runId')}",
        }

    @task(task_id="catalog_update")
    def catalog_update(payload: dict[str, Any]) -> dict[str, Any]:
        conf = payload["conf"]
        time.sleep(sleep_seconds(conf, "smokeCatalogSeconds", 3))
        return {
            "jobId": conf.get("jobId"),
            "runId": conf.get("runId"),
            "status": "success",
            "outputPath": payload.get("outputPath"),
            "inputRows": payload.get("inputRows"),
            "outputRows": payload.get("outputRows"),
        }

    catalog_update(transform_quality_write(spark_source_read(receive_asklake_run())))


asklake_etl_job()
