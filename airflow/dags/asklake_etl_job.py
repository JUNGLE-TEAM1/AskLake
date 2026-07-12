from __future__ import annotations

import time
from typing import Any

import pendulum

try:
    from airflow.sdk import dag, task
except ImportError:  # pragma: no cover - Airflow 2 local fallback.
    from airflow.decorators import dag, task


TASK_IDS = (
    "validate_run_conf",
    "prepare_source_input",
    "submit_spark_job",
    "collect_spark_result",
    "run_quality_checks",
    "publish_output_dataset",
    "update_catalog",
    "record_lineage",
)


def sleep_seconds(conf: dict[str, Any], key: str, default: int) -> int:
    try:
        return max(0, min(int(conf.get(key, default)), 60))
    except (TypeError, ValueError):
        return default


def force_fail_if_requested(conf: dict[str, Any], task_id: str) -> None:
    force_fail_task = conf.get("forceFailTask")
    if force_fail_task == task_id or (
        conf.get("forceFail") and task_id == "run_quality_checks"
    ):
        raise RuntimeError(f"AskLake smoke forced failure at {task_id}.")


def required_string(conf: dict[str, Any], key: str) -> str:
    value = conf.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"AskLake DAG Run conf must include non-empty {key}.")
    return value.strip()


def job_metadata(conf: dict[str, Any]) -> dict[str, Any]:
    job = conf.get("job")
    if not isinstance(job, dict):
        raise ValueError("AskLake DAG Run conf must include job object.")
    return job


@dag(
    dag_id="asklake_etl_job",
    schedule=None,
    start_date=pendulum.datetime(2026, 1, 1, tz="UTC"),
    catchup=False,
    tags=["asklake", "etl", "smoke"],
    is_paused_upon_creation=False,
)
def asklake_etl_job() -> None:
    @task(task_id="validate_run_conf")
    def validate_run_conf(**context: Any) -> dict[str, Any]:
        conf = dict(context["dag_run"].conf or {})
        job = job_metadata(conf)
        run_id = required_string(conf, "runId")
        job_id = required_string(conf, "jobId")
        command = required_string(conf, "command")
        if str(job.get("id") or job_id) != job_id:
            raise ValueError("AskLake DAG Run conf job.id must match jobId.")
        force_fail_if_requested(conf, "validate_run_conf")
        time.sleep(sleep_seconds(conf, "smokeValidateSeconds", 1))
        return {
            "command": command,
            "conf": conf,
            "job": job,
            "jobId": job_id,
            "runId": run_id,
            "submittedAt": conf.get("submittedAt"),
        }

    @task(task_id="prepare_source_input")
    def prepare_source_input(payload: dict[str, Any]) -> dict[str, Any]:
        conf = payload["conf"]
        job = payload["job"]
        force_fail_if_requested(conf, "prepare_source_input")
        time.sleep(sleep_seconds(conf, "smokePrepareSeconds", 2))
        sample_rows = job.get("schemaSampleRows")
        input_rows = (
            len(sample_rows)
            if isinstance(sample_rows, list) and sample_rows
            else 10
        )
        return {
            **payload,
            "input": {
                "rowCount": input_rows,
                "source": job.get("source") or "unknown",
                "sourceType": job.get("sourceType") or "unknown",
                "stagingPath": (
                    f"airflow-smoke://{payload['jobId']}/"
                    f"{payload['runId']}/source.jsonl"
                ),
            },
        }

    @task(task_id="submit_spark_job")
    def submit_spark_job(payload: dict[str, Any]) -> dict[str, Any]:
        conf = payload["conf"]
        job = payload["job"]
        force_fail_if_requested(conf, "submit_spark_job")
        time.sleep(sleep_seconds(conf, "smokeSubmitSeconds", 2))
        return {
            **payload,
            "spark": {
                "applicationId": f"asklake-smoke-{payload['runId']}",
                "state": "submitted",
                "transformSteps": len(job.get("transformSteps") or []),
            },
        }

    @task(task_id="collect_spark_result")
    def collect_spark_result(payload: dict[str, Any]) -> dict[str, Any]:
        conf = payload["conf"]
        force_fail_if_requested(conf, "collect_spark_result")
        time.sleep(sleep_seconds(conf, "smokeCollectSeconds", 3))
        input_rows = int(payload["input"].get("rowCount") or 0)
        return {
            **payload,
            "spark": {
                **payload["spark"],
                "state": "success",
            },
            "result": {
                "inputRows": input_rows,
                "outputRows": input_rows,
                "schemaColumns": len(payload["job"].get("schemaColumns") or []),
            },
        }

    @task(task_id="run_quality_checks")
    def run_quality_checks(payload: dict[str, Any]) -> dict[str, Any]:
        conf = payload["conf"]
        job = payload["job"]
        force_fail_if_requested(conf, "run_quality_checks")
        time.sleep(sleep_seconds(conf, "smokeQualitySeconds", 2))
        quality_rules = job.get("qualityRules") or []
        return {
            **payload,
            "quality": {
                "invalidRows": len(job.get("qualityInvalidRows") or []),
                "ruleCount": len(quality_rules),
                "status": "passed",
            },
        }

    @task(task_id="publish_output_dataset")
    def publish_output_dataset(payload: dict[str, Any]) -> dict[str, Any]:
        conf = payload["conf"]
        job = payload["job"]
        force_fail_if_requested(conf, "publish_output_dataset")
        time.sleep(sleep_seconds(conf, "smokePublishSeconds", 2))
        output_path = job.get("targetPath") or (
            f"airflow-smoke://{payload['jobId']}/"
            f"{payload['runId']}/dataset.parquet"
        )
        return {
            **payload,
            "output": {
                "format": job.get("targetFormat") or "parquet",
                "path": output_path,
                "rows": payload["result"].get("outputRows", 0),
                "target": job.get("target") or "unknown",
            },
        }

    @task(task_id="update_catalog")
    def update_catalog(payload: dict[str, Any]) -> dict[str, Any]:
        conf = payload["conf"]
        force_fail_if_requested(conf, "update_catalog")
        time.sleep(sleep_seconds(conf, "smokeCatalogSeconds", 1))
        return {
            **payload,
            "catalog": {
                "datasetId": payload["job"].get("target") or payload["jobId"],
                "outputPath": payload["output"].get("path"),
                "status": "updated",
            },
        }

    @task(task_id="record_lineage")
    def record_lineage(payload: dict[str, Any]) -> dict[str, Any]:
        conf = payload["conf"]
        force_fail_if_requested(conf, "record_lineage")
        time.sleep(sleep_seconds(conf, "smokeLineageSeconds", 1))
        return {
            "catalog": payload.get("catalog"),
            "inputRows": payload["result"].get("inputRows"),
            "jobId": payload["jobId"],
            "lineage": {
                "runId": payload["runId"],
                "source": payload["input"].get("source"),
                "target": payload["output"].get("target"),
            },
            "outputPath": payload["output"].get("path"),
            "outputRows": payload["result"].get("outputRows"),
            "runId": payload["runId"],
            "status": "success",
            "taskIds": TASK_IDS,
        }

    validated = validate_run_conf()
    prepared = prepare_source_input(validated)
    submitted = submit_spark_job(prepared)
    collected = collect_spark_result(submitted)
    checked = run_quality_checks(collected)
    published = publish_output_dataset(checked)
    cataloged = update_catalog(published)
    record_lineage(cataloged)


asklake_etl_job()
