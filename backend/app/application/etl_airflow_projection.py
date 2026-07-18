"""Airflow task timing and Spark/Catalog observation projections."""

from typing import Any

from app.application.etl_job_projection import (
    format_duration_ms,
    format_iso_duration,
    format_rows,
)
from app.services.airflow_client import AirflowTaskInstance


def airflow_task_timing(
    task: AirflowTaskInstance | None,
) -> tuple[str | None, str | None]:
    if task is None:
        return None, None
    completed_at = str(task.raw.get("end_date") or "").strip() or None
    raw_duration = task.raw.get("duration")
    if raw_duration is not None:
        try:
            return format_duration_ms(round(float(raw_duration) * 1000)), completed_at
        except (TypeError, ValueError):
            pass
    started_at = str(task.raw.get("start_date") or "").strip() or None
    if started_at and completed_at:
        return format_iso_duration(started_at, completed_at), completed_at
    return None, completed_at


def airflow_task_observation(
    task_id: str,
    task: AirflowTaskInstance | None,
    spark_result: dict[str, Any],
    catalog_result: dict[str, Any],
) -> tuple[list[list[str]], str | None, str | None]:
    airflow_state = task.state if task and task.state else "not_started"
    details = [
        ["Airflow task", task_id],
        ["Airflow state", airflow_state],
    ]
    duration, completed_at = airflow_task_timing(task)
    if task_id == "spark_process_write" and spark_result:
        duration = format_duration_ms(spark_result.get("durationMs"))
        completed_at = (
            str(spark_result.get("endedAt") or "").strip()
            or completed_at
        )
        details.extend(_spark_phase_timing_rows(spark_result))
        resources = spark_result.get("sparkResources")
        resources = resources if isinstance(resources, dict) else {}
        details.extend([
            ["Executors", str(resources.get("executorInstances") or 1)],
            ["Input rows", format_rows(spark_result.get("inputRows"))],
            ["Output rows", format_rows(spark_result.get("outputRows"))],
            ["Snapshot data files", str(spark_result.get("outputFileCount") or 0)],
        ])
    elif task_id == "publish_run_result" and catalog_result:
        duration = format_duration_ms(catalog_result.get("durationMs"))
        completed_at = (
            str(catalog_result.get("endedAt") or "").strip()
            or str(catalog_result.get("reconciledAt") or "").strip()
            or completed_at
        )
        details.extend([
            ["Catalog reconciliation", duration],
            ["Snapshot data files", str(catalog_result.get("dataFileCount") or 0)],
            ["Storage bytes", str(catalog_result.get("storageSizeBytes") or 0)],
        ])
    return details, duration, completed_at


def _spark_phase_timing_rows(result: dict[str, Any]) -> list[list[str]]:
    timings = result.get("phaseTimings")
    if not isinstance(timings, dict):
        return []
    labels = {
        "sourceValidation": "Source validation/read",
        "ruleEvaluation": "Transform/rule evaluation",
        "qualityAggregation": "Quality/output aggregation",
        "sourcePostValidation": "Source post-validation",
        "targetPublish": "Iceberg/target publish",
    }
    return [
        [label, format_duration_ms(timing.get("durationMs"))]
        for key, label in labels.items()
        if isinstance((timing := timings.get(key)), dict)
    ]
