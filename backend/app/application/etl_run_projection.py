"""Airflow, Spark, and Kafka run-state projections."""

from typing import Any, Callable
from fastapi import status
from app.application.etl_airflow_projection import (
    airflow_task_observation,
    airflow_task_timing,
)
from app.application.etl_job_projection import (
    apply_job_command,
    continuous_config_from_request,
    continuous_runtime_from_job,
    dag_steps_from_command,
    dataset_sample_rows_from_request,
    dataset_schema_from_request,
    dataset_storage_key,
    fallback_lineage_graph,
    field_value,
    format_bytes,
    format_duration_ms,
    format_iso_duration,
    format_rows,
    initial_dag_steps,
    initial_job_stats,
    iso_now,
    kafka_field_value,
    lineage_node,
    make_dataset_id,
    make_job_id,
    normalize_column_name,
    normalize_lineage_id,
    normalize_optional_text,
    normalize_string_list,
    normalize_target_tags,
    parse_positive_integer,
    quality_status_label,
    quality_summary_from_request,
    run_from_command,
    source_metrics_from_request,
    source_unit_label,
    stable_id,
    stats_from_runs,
    target_dataset_description,
    target_dataset_tags,
    tuple_rows_to_lists,
)
from app.application.etl_schedule import (
    cron_matches,
    has_scheduled_execution,
    has_scheduled_label,
    job_schedule_kind,
    next_custom_cron_local,
    next_scheduled_run_utc_for_schedule,
    parse_cron_field,
    schedule_next_run_label,
    schedule_policy_from_request,
    schedule_timezone,
    trino_sql_job_next_run_utc,
    trino_sql_job_schedule_label,
    trino_sql_job_schedule_summary,
)
from app.core.errors import ApiError
from app.models import (
    CatalogDatasetModel,
    ETLJobModel,
    ETLRunModel,
    KafkaContinuousBatchModel,
    KafkaContinuousMaintenanceRunModel,
    KafkaContinuousRuntimeModel,
    KafkaContinuousSessionModel,
    KafkaSnapshotModel,
    PermissionGrantModel,
    ResourceLockModel,
)
from app.schemas.common import ErrorCode
from app.services.airflow_client import AirflowDagRun, AirflowTaskInstance, build_airflow_client

from app.application.etl_runtime_support import compact_storage_text, dag_step

TERMINAL_RUN_STATUSES = {"success", "failed", "canceled"}
AIRFLOW_MISSING_RUN_FAILURE_LIMIT = 3
AIRFLOW_TASK_TITLES = {
    "receive_asklake_run": "1. Airflow DAG Run 접수",
    "validate_spark_request": "2. Spark 실행 요청 검증",
    "spark_process_write": "3. Spark 처리/품질/Parquet 적재",
    "publish_run_result": "4. Spark 실행 결과 확정",
}

def run_from_airflow_submit(
    job: ETLJobModel,
    command: str,
    run_id: str,
    submitted_at: str,
    dag_run: AirflowDagRun,
    airflow_run_url: str | None,
) -> ETLRunModel:
    return ETLRunModel(
        run_id=run_id,
        job_id=job.id,
        status=dag_run.asklake_status,
        started_at=submitted_at,
        ended_at="-",
        duration="-",
        input_rows="-",
        output_rows="-",
        output_path=job.target_path,
        failed_stage="-",
        error_summary="-",
        airflow_dag_id=dag_run.dag_id,
        airflow_dag_run_id=dag_run.dag_run_id,
        airflow_run_url=airflow_run_url,
        airflow_state=dag_run.state,
        task_states=None,
        last_synced_at=submitted_at,
        sync_error=None,
    )

def run_from_spark_result(job: ETLJobModel, result: dict[str, Any]) -> ETLRunModel:
    success = result.get("status") == "success"
    return ETLRunModel(
        run_id=str(result.get("runId") or stable_id("run", f"{job.id}:spark:{iso_now()}")),
        job_id=job.id,
        status="success" if success else "failed",
        started_at=str(result.get("startedAt") or iso_now()),
        ended_at=str(result.get("endedAt") or iso_now()),
        duration=format_duration_ms(result.get("durationMs")),
        input_rows=format_rows(result.get("inputRows")),
        output_rows=format_rows(result.get("outputRows")),
        output_path=result.get("outputPath") or "-",
        failed_stage="-" if success else spark_failed_stage(result),
        error_summary="-" if success else spark_error_summary(result),
    )

def run_from_kafka_result(job: ETLJobModel, result: dict[str, Any]) -> ETLRunModel:
    success = result.get("status") == "success"
    started_at = str(result.get("startedAt") or iso_now())
    ended_at = str(result.get("endedAt") or iso_now())
    return ETLRunModel(
        run_id=str(result.get("runId") or stable_id("run", f"{job.id}:kafka:{iso_now()}")),
        job_id=job.id,
        status="success" if success else "failed",
        started_at=started_at,
        ended_at=ended_at,
        duration=format_iso_duration(started_at, ended_at),
        input_rows=format_rows(result.get("consumedCount")),
        output_rows=format_rows(result.get("storedCount")),
        output_path=result.get("storageLocation") or "-",
        failed_stage="-" if success else str(result.get("failedStage") or "Kafka ingest"),
        error_summary="-" if success else str(result.get("error") or "Kafka ingest failed."),
        task_states={
            "catalogDataset": result.get("catalogDataset"),
            "icebergCommit": result.get("icebergCommit"),
            "kafkaSnapshot": result.get("snapshot"),
            "metadataUpdate": result.get("metadataUpdate"),
            "offsetCommit": result.get("offsetCommit"),
            "transform": result.get("transform"),
            "quality": result.get("quality"),
            "queryEngineTable": result.get("queryEngineTable"),
        } if result.get("snapshot") else None,
    )

def kafka_run_reservation(job: ETLJobModel, run_id: str) -> ETLRunModel:
    reserved_at = iso_now()
    return ETLRunModel(
        run_id=run_id,
        job_id=job.id,
        status="running",
        started_at=reserved_at,
        ended_at="-",
        duration="-",
        input_rows="0 rows",
        output_rows="0 rows",
        output_path=job.target_path or "-",
        failed_stage="-",
        error_summary="-",
        task_states={
            "kafkaReservation": {
                "reservedAt": reserved_at,
                "status": "running",
            },
        },
    )

def apply_kafka_run_reservation_job_state(
    job: ETLJobModel,
    command: str,
    run: ETLRunModel,
) -> None:
    job.last_run = run.started_at
    job.last_state = f"Kafka snapshot {command} reserved"
    job.next_run = "-"
    job.progress = {"label": "Kafka snapshot running", "value": 5}
    job.status = "running"

def apply_kafka_result_to_reserved_run(
    reserved_run: ETLRunModel,
    completed_run: ETLRunModel,
) -> None:
    if reserved_run.run_id != completed_run.run_id or reserved_run.job_id != completed_run.job_id:
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            "Kafka result does not match its reserved run",
            status.HTTP_409_CONFLICT,
            {
                "reservedRunId": reserved_run.run_id,
                "resultRunId": completed_run.run_id,
            },
        )
    reserved_run.status = completed_run.status
    reserved_run.started_at = completed_run.started_at
    reserved_run.ended_at = completed_run.ended_at
    reserved_run.duration = completed_run.duration
    reserved_run.input_rows = completed_run.input_rows
    reserved_run.output_rows = completed_run.output_rows
    reserved_run.output_path = completed_run.output_path
    reserved_run.failed_stage = completed_run.failed_stage
    reserved_run.error_summary = completed_run.error_summary
    reserved_run.task_states = completed_run.task_states

def apply_airflow_result_to_reserved_run(
    reserved_run: ETLRunModel,
    submitted_run: ETLRunModel,
) -> None:
    if reserved_run.run_id != submitted_run.run_id or reserved_run.job_id != submitted_run.job_id:
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            "Airflow result does not match its reserved run",
            status.HTTP_409_CONFLICT,
            {
                "reservedRunId": reserved_run.run_id,
                "resultRunId": submitted_run.run_id,
            },
        )
    for field in (
        "airflow_dag_id",
        "airflow_dag_run_id",
        "airflow_run_url",
    ):
        setattr(reserved_run, field, getattr(submitted_run, field))

    should_replace_execution = (
        reserved_run.status == "queued"
        or submitted_run.status in TERMINAL_RUN_STATUSES
    ) and reserved_run.status not in TERMINAL_RUN_STATUSES
    if not should_replace_execution:
        return

    for field in (
        "status",
        "started_at",
        "ended_at",
        "duration",
        "input_rows",
        "output_rows",
        "output_path",
        "failed_stage",
        "error_summary",
        "airflow_state",
        "last_synced_at",
        "sync_error",
    ):
        setattr(reserved_run, field, getattr(submitted_run, field))
    if submitted_run.task_states is not None:
        reserved_run.task_states = {
            **(reserved_run.task_states or {}),
            **submitted_run.task_states,
        }

def mark_airflow_submission_unknown(reserved_run: ETLRunModel, error: Exception | None) -> None:
    checked_at = iso_now()
    reason = compact_storage_text(error or "Airflow trigger outcome is unknown", limit=1000)
    definitive = airflow_submission_error_is_definitive(error)
    current_status = reserved_run.status
    reserved_run.last_synced_at = checked_at
    reserved_run.sync_error = reason
    reserved_run.task_states = {
        **(reserved_run.task_states or {}),
        "airflowReservation": {
            "error": reason,
            "reservedAt": reserved_run.started_at,
            "status": "failed" if definitive and current_status == "queued" else "unknown",
            "updatedAt": checked_at,
        },
    }
    if current_status != "queued":
        return

    reserved_run.status = "failed" if definitive else "queued"
    reserved_run.airflow_state = "failed" if definitive else "queued"
    if definitive:
        reserved_run.ended_at = checked_at
        reserved_run.duration = format_iso_duration(reserved_run.started_at, checked_at)
        reserved_run.failed_stage = "Airflow submission"
        reserved_run.error_summary = reason

def airflow_submission_error_is_definitive(error: Exception | None) -> bool:
    if not isinstance(error, ApiError):
        return False
    details = error.details if isinstance(error.details, dict) else {}
    try:
        airflow_status = int(details.get("airflowStatus"))
    except (TypeError, ValueError):
        airflow_status = 0
    return airflow_status in {400, 401, 403, 404, 405, 422}

def bind_kafka_result_to_reservation(result: Any, run_id: str) -> dict[str, Any]:
    if not isinstance(result, dict):
        raise ApiError(
            "KAFKA_INGEST_BAD_RESPONSE",
            "Kafka ingest response must be an object",
            status.HTTP_502_BAD_GATEWAY,
        )
    response_run_id = str(result.get("runId") or "").strip()
    if response_run_id and response_run_id != run_id:
        raise ApiError(
            "KAFKA_RUN_MISMATCH",
            "Kafka ingest response does not match its reserved run",
            status.HTTP_502_BAD_GATEWAY,
            {"expectedRunId": run_id, "responseRunId": response_run_id},
        )
    return {**result, "runId": run_id}

def apply_airflow_submit_job_state(job: ETLJobModel, command: str, run: ETLRunModel) -> None:
    action_label = "재실행" if command == "retry" else "실행"
    state_label = run.airflow_state or run.status
    job.last_run = run.started_at
    job.last_state = f"Airflow {action_label} 접수 · {state_label}"
    job.next_run = "-"
    if run.status == "failed":
        job.progress = None
        job.status = "failed"
        return
    if run.status == "success":
        job.progress = None
        job.status = "scheduled"
        return
    job.progress = {
        "label": f"Airflow DAG Run {state_label}",
        "value": 10 if run.status == "queued" else 20,
    }
    job.status = "running"

def record_airflow_sync_error(run: ETLRunModel, error: ApiError, synced_at: str) -> None:
    run.sync_error = error.message
    run.last_synced_at = synced_at
    details = error.details if isinstance(error.details, dict) else {}
    try:
        airflow_status = int(details.get("airflowStatus"))
    except (TypeError, ValueError):
        airflow_status = 0
    if airflow_status != status.HTTP_404_NOT_FOUND:
        return

    task_states = dict(run.task_states or {})
    reservation = dict(task_states.get("airflowReservation") or {})
    try:
        missing_count = int(reservation.get("missingCount") or 0) + 1
    except (TypeError, ValueError):
        missing_count = 1
    reservation.update({
        "lastMissingAt": synced_at,
        "missingCount": missing_count,
        "status": "missing",
    })
    task_states["airflowReservation"] = reservation
    run.task_states = task_states
    if missing_count < AIRFLOW_MISSING_RUN_FAILURE_LIMIT:
        return

    run.status = "failed"
    run.airflow_state = "failed"
    run.ended_at = synced_at
    run.duration = format_iso_duration(run.started_at, synced_at)
    run.failed_stage = "Airflow submission"
    run.error_summary = "Reserved Airflow DAG Run was not found after repeated reconciliation."

def repair_incomplete_airflow_successes(
    runs: list[ETLRunModel],
    dataset: CatalogDatasetModel | None,
) -> bool:
    repaired = False
    for run in runs:
        if run.status != "success" or not run.airflow_dag_run_id:
            continue
        catalog_result = (run.task_states or {}).get("catalogResult")
        if isinstance(catalog_result, dict) and catalog_result.get("status") == "failed":
            mark_airflow_catalog_reconciliation_failure(run, catalog_result)
            repaired = True
        elif (
            not (isinstance(catalog_result, dict) and catalog_result.get("status") == "success")
            and not airflow_run_has_materialization(run, dataset)
        ):
            mark_airflow_success_without_catalog_reconciliation(run)
            repaired = True
    return repaired

def airflow_run_has_materialization(
    run: ETLRunModel,
    dataset: CatalogDatasetModel | None,
) -> bool:
    if dataset is None or not isinstance(dataset.payload, dict):
        return False
    materialization_runs = dataset.payload.get("materializationRuns")
    if not isinstance(materialization_runs, list):
        return False
    return any(
        isinstance(item, dict)
        and str(item.get("runId") or "") == run.run_id
        and item.get("status") == "success"
        for item in materialization_runs
    )

def mark_airflow_catalog_reconciliation_failure(run: ETLRunModel, catalog_result: dict[str, Any]) -> None:
    run.status = "failed"
    run.failed_stage = "Catalog reconciliation"
    run.error_summary = str(catalog_result.get("error") or "Catalog reconciliation failed.")

def mark_airflow_success_without_catalog_reconciliation(run: ETLRunModel) -> None:
    run.status = "failed"
    run.failed_stage = "Catalog reconciliation"
    run.error_summary = "Airflow completed without a successful Catalog reconciliation."

def apply_job_state_from_latest_run(job: ETLJobModel, latest_run: ETLRunModel) -> None:
    job.last_run = latest_run.ended_at if latest_run.status in TERMINAL_RUN_STATUSES else latest_run.started_at
    job.next_run = "-" if job.schedule in {"수동 실행", "manual"} else job.schedule

    if latest_run.status == "success":
        job.status = "scheduled"
        job.progress = None
        job.last_state = "최근 실행 성공 · 다음 실행 대기"
        return
    if latest_run.status == "failed":
        job.status = "failed"
        job.progress = None
        job.last_state = f"최근 실행 실패 · {latest_run.failed_stage}"
        return
    if latest_run.status == "canceled":
        job.status = "canceled"
        job.progress = None
        job.last_state = "최근 실행 취소"
        return

    state_label = latest_run.airflow_state or latest_run.status
    job.status = "running"
    job.progress = {
        "label": f"Airflow DAG Run {state_label}",
        "value": 10 if latest_run.status == "queued" else 55,
    }
    job.last_state = f"Airflow 실행 중 · {state_label}"
    job.next_run = "-"

def task_state_snapshot(task_instances: list[AirflowTaskInstance]) -> dict[str, dict[str, Any]]:
    return {
        task.task_id: {
            "airflowState": task.state,
            "dagId": task.dag_id,
            "dagRunId": task.dag_run_id,
            "status": task.asklake_status,
            "taskId": task.task_id,
        }
        for task in task_instances
        if task.task_id
    }

def first_problem_task(task_instances: list[AirflowTaskInstance]) -> AirflowTaskInstance | None:
    for task in task_instances:
        if task.asklake_status in {"failed", "blocked"}:
            return task
    return None

def task_title(task_id: str) -> str:
    if task_id in AIRFLOW_TASK_TITLES:
        return AIRFLOW_TASK_TITLES[task_id]
    return str(task_id or "Airflow task").replace("_", " ").strip().title()

def dag_steps_from_airflow_submit(job: ETLJobModel, command: str, run: dict[str, Any]) -> list[dict[str, Any]]:
    action_label = "재실행" if command == "retry" else "실행"
    state_label = str(run.get("airflowState") or run.get("status") or "queued")
    return [
        dag_step("airflow-submit", "Airflow DAG Run 접수", state_label, "running", [
            ["Job", job.name],
            ["Run ID", run.get("runId", "-")],
            ["DAG Run ID", run.get("airflowDagRunId", "-")],
        ], [f"AskLake {action_label} 명령이 Airflow에 접수되었습니다."]),
        *[
            dag_step(task_id, title, "대기", "pending", [
                ["Airflow task", task_id],
            ], ["Airflow Task Instance 상태 polling 대기 중입니다."])
            for task_id, title in AIRFLOW_TASK_TITLES.items()
        ],
    ]

def dag_steps_from_airflow_sync(
    job: ETLJobModel,
    run: dict[str, Any],
    task_instances: list[AirflowTaskInstance],
) -> list[dict[str, Any]]:
    task_by_id = {task.task_id: task for task in task_instances if task.task_id}
    task_states = run.get("taskStates") if isinstance(run.get("taskStates"), dict) else {}
    spark_result = task_states.get("sparkResult") if isinstance(task_states.get("sparkResult"), dict) else {}
    catalog_result = task_states.get("catalogResult") if isinstance(task_states.get("catalogResult"), dict) else {}
    run_status = str(run.get("status") or "running")
    run_state = str(run.get("airflowState") or run_status)
    submit_status = "success" if run_status in TERMINAL_RUN_STATUSES else "running"
    if run_status == "failed":
        submit_status = "failed"

    steps = [
        dag_step("airflow-submit", "Airflow DAG Run 상태", run_state, submit_status, [
            ["Job", job.name],
            ["Run ID", run.get("runId", "-")],
            ["DAG Run ID", run.get("airflowDagRunId", "-")],
            ["Airflow state", run_state],
        ], [f"Airflow DAG Run 상태: {run_state}"]),
    ]

    for task_id, title in AIRFLOW_TASK_TITLES.items():
        task = task_by_id.get(task_id)
        status_value = task.asklake_status if task else "pending"
        airflow_state = task.state if task and task.state else "not_started"
        logs = [f"Airflow Task Instance state: {airflow_state}"]
        if task and task.raw.get("try_number") is not None:
            logs.append(f"try_number={task.raw.get('try_number')}")
        details, duration, completed_at = airflow_task_observation(
            task_id,
            task,
            spark_result,
            catalog_result,
        )
        steps.append(dag_step(
            task_id,
            title,
            airflow_state,
            status_value,
            details,
            logs,
            duration=duration,
            completed_at=completed_at,
        ))

    extra_tasks = [
        task for task in task_instances
        if task.task_id and task.task_id not in AIRFLOW_TASK_TITLES
    ]
    for task in extra_tasks:
        duration, completed_at = airflow_task_timing(task)
        steps.append(dag_step(
            task.task_id,
            task_title(task.task_id),
            task.state or "-",
            task.asklake_status,
            [
                ["Airflow task", task.task_id],
                ["Airflow state", task.state or "-"],
            ],
            [f"Airflow Task Instance state: {task.state or '-'}"],
            duration=duration,
            completed_at=completed_at,
        ))

    return steps


def finalize_job_from_spark_result(job: ETLJobModel, command: str, result: dict[str, Any]) -> None:
    success = result.get("status") == "success"
    job.last_run = str(result.get("endedAt") or iso_now())
    job.last_state = (
        f"{'재실행' if command == 'retry' else '실행'} 완료 · Spark Parquet 적재"
        if success
        else f"Spark 실행 실패 · {spark_error_summary(result, limit=180)}"
    )
    job.next_run = schedule_next_run_label(job.schedule, job.next_run)
    job.progress = None
    job.status = "scheduled"
    job.target_path = result.get("outputPath") or job.target_path

def spark_failed_stage(result: dict[str, Any]) -> str:
    return compact_storage_text(result.get("failedStage") or "Spark ETL", limit=500)

def spark_error_summary(result: dict[str, Any], *, limit: int = 1800) -> str:
    return compact_storage_text(result.get("error") or result.get("stderr") or result.get("stdout") or "Spark job failed.", limit=limit)

def finalize_job_from_kafka_result(job: ETLJobModel, command: str, result: dict[str, Any]) -> None:
    success = result.get("status") == "success"
    stored_count = int(result.get("storedCount") or 0)
    failed_count = int(result.get("failedCount") or 0)
    snapshot_id = str((result.get("snapshot") or {}).get("snapshotId") or "-")
    job.last_run = str(result.get("endedAt") or iso_now())
    job.last_state = (
        f"{'재실행' if command == 'retry' else '실행'} 완료 · Kafka snapshot {snapshot_id} · {stored_count:,}건 target 저장"
        if success
        else f"Kafka 실행 실패 · {result.get('error') or '원인 확인 필요'}"
    )
    job.next_run = schedule_next_run_label(job.schedule, job.next_run)
    job.progress = None
    job.status = "scheduled" if success else "failed"
    job.target_path = result.get("storageLocation") or job.target_path
    job.stats = {
        **(job.stats or {}),
        "currentStage": "Kafka snapshot target 저장 완료" if success else "Kafka snapshot target 저장 실패",
        "inputRows": format_rows(result.get("consumedCount")),
        "lastSuccess": str(result.get("endedAt") or iso_now()) if success else job.stats.get("lastSuccess", "-"),
        "outputPath": result.get("storageLocation") or job.target_path,
        "outputRows": format_rows(result.get("storedCount")),
        "sampleScope": f"{result.get('topic') or 'Kafka'} batch",
        "sourceUnits": "Kafka topic",
        "successRate": "100%" if success and failed_count == 0 else "확인 필요",
    }
