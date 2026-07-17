"""Finite Airflow Spark execution and Catalog publication commands.

The public functions in ``etl_service`` remain compatibility façades. This
module owns the persisted Run identity, execution lease, external Spark call,
result finalization, and Catalog reconciliation transaction order. Runtime
adapters and payload builders are injected as hooks so moving the sequence does
not change deployed behavior.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from fastapi import status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import ApiError
from app.models import ETLJobModel, ETLRunModel
from app.repositories import etl_repository
from app.schemas.common import ErrorCode
from app.schemas.etl import AirflowCatalogReconciliationResponse


@dataclass(frozen=True, slots=True)
class AirflowSparkExecutionHooks:
    compact_storage_text: Callable[..., str]
    format_duration_ms: Callable[[Any], str]
    format_rows: Callable[[Any], str]
    iso_now: Callable[[], str]
    make_attempt_id: Callable[[str], str]
    run_spark_job: Callable[[Session, ETLJobModel, str, str], dict[str, Any]]
    spark_error_summary: Callable[[dict[str, Any]], str]
    spark_execution_lease_is_active: Callable[[Any], bool]
    spark_failed_stage: Callable[[dict[str, Any]], str]
    spark_result_manifest: Callable[[dict[str, Any], str], dict[str, Any]]


@dataclass(frozen=True, slots=True)
class AirflowCatalogReconciliationHooks:
    catalog_reconciliation_error: Callable[..., ApiError]
    compact_storage_text: Callable[..., str]
    dataset_from_spark_result: Callable[..., Any]
    inspect_spark_output: Callable[[str], dict[str, Any]]
    is_kafka_job: Callable[[ETLJobModel], bool]
    iso_now: Callable[[], str]
    optional_string: Callable[[Any], str | None]
    parse_count_value: Callable[[Any], int]
    validate_catalog_output_identity: Callable[[ETLJobModel, str, str], None]
    verify_spark_iceberg_result: Callable[[ETLJobModel, str, dict[str, Any]], dict[str, Any]]


def execute_airflow_spark_run(
    db: Session,
    *,
    job_id: str,
    run_id: str,
    command: str,
    hooks: AirflowSparkExecutionHooks,
) -> dict[str, Any]:
    job = etl_repository.get_job_for_update(db, job_id)
    if job is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job_id}", status.HTTP_404_NOT_FOUND)
    run = etl_repository.get_run_model(db, run_id)
    if run is None or run.job_id != job.id or run.airflow_dag_run_id != run_id:
        raise ApiError(
            "AIRFLOW_RUN_MISMATCH",
            "Airflow Spark execution does not match a persisted AskLake Run.",
            status.HTTP_409_CONFLICT,
            {"jobId": job_id, "runId": run_id},
        )
    etl_repository.refresh_run_for_update(db, run)

    existing_result = (run.task_states or {}).get("sparkResult")
    if isinstance(existing_result, dict) and existing_result.get("status") == "success":
        db.rollback()
        return existing_result

    execution = (run.task_states or {}).get("sparkExecution")
    if hooks.spark_execution_lease_is_active(execution):
        db.rollback()
        raise ApiError(
            "SPARK_RUN_ALREADY_EXECUTING",
            "Spark execution is already active for this Airflow Run.",
            status.HTTP_409_CONFLICT,
            {"jobId": job_id, "runId": run_id},
        )

    attempt_id = hooks.make_attempt_id(run_id)
    run.task_states = {
        **(run.task_states or {}),
        "sparkExecution": {
            "attemptId": attempt_id,
            "startedAt": hooks.iso_now(),
            "status": "running",
        },
    }
    db.commit()
    job = etl_repository.get_job(db, job_id)
    if job is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found after Spark claim: {job_id}", status.HTTP_404_NOT_FOUND)

    try:
        result = hooks.run_spark_job(db, job, command, run_id)
    except Exception as exc:
        finalize_spark_execution_attempt(
            db,
            job_id=job_id,
            run_id=run_id,
            attempt_id=attempt_id,
            error=hooks.compact_storage_text(exc, limit=1000),
            hooks=hooks,
        )
        raise

    manifest = hooks.spark_result_manifest(result, run_id)
    job = etl_repository.get_job_for_update(db, job_id)
    if job is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found after Spark execution: {job_id}", status.HTTP_404_NOT_FOUND)
    run = etl_repository.get_run_model(db, run_id)
    if run is None or run.job_id != job.id:
        raise ApiError(ErrorCode.INVALID_JOB_STATE, "Spark Run disappeared during finalization", status.HTTP_409_CONFLICT)
    etl_repository.refresh_run_for_update(db, run)
    execution = (run.task_states or {}).get("sparkExecution")
    if not isinstance(execution, dict) or execution.get("attemptId") != attempt_id:
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            "Spark execution lease changed before finalization",
            status.HTTP_409_CONFLICT,
            {"jobId": job_id, "runId": run_id, "attemptId": attempt_id},
        )
    run.input_rows = hooks.format_rows(manifest.get("inputRows"))
    run.output_rows = hooks.format_rows(manifest.get("outputRows"))
    run.output_path = manifest.get("outputPath") or run.output_path
    run.duration = hooks.format_duration_ms(manifest.get("durationMs"))
    run.ended_at = str(manifest.get("endedAt") or run.ended_at)
    run.failed_stage = "-" if manifest.get("status") == "success" else hooks.spark_failed_stage(manifest)
    run.error_summary = "-" if manifest.get("status") == "success" else hooks.spark_error_summary(manifest)
    run.task_states = {
        **(run.task_states or {}),
        "sparkExecution": {
            **execution,
            "endedAt": str(manifest.get("endedAt") or hooks.iso_now()),
            "status": "success" if manifest.get("status") == "success" else "failed",
        },
        "sparkResult": manifest,
    }
    if manifest.get("status") == "success" and manifest.get("outputPath"):
        job.target_path = str(manifest["outputPath"])
    db.commit()
    return manifest


def finalize_spark_execution_attempt(
    db: Session,
    *,
    job_id: str,
    run_id: str,
    attempt_id: str,
    error: str,
    hooks: AirflowSparkExecutionHooks,
) -> None:
    job = etl_repository.get_job_for_update(db, job_id)
    if job is None:
        db.rollback()
        return
    run = etl_repository.get_run_model(db, run_id)
    if run is None or run.job_id != job.id:
        db.rollback()
        return
    etl_repository.refresh_run_for_update(db, run)
    execution = (run.task_states or {}).get("sparkExecution")
    if not isinstance(execution, dict) or execution.get("attemptId") != attempt_id:
        db.rollback()
        return
    run.task_states = {
        **(run.task_states or {}),
        "sparkExecution": {
            **execution,
            "endedAt": hooks.iso_now(),
            "error": error,
            "status": "failed",
        },
    }
    db.commit()


def reconcile_airflow_catalog(
    db: Session,
    *,
    job_id: str,
    run_id: str,
    hooks: AirflowCatalogReconciliationHooks,
) -> AirflowCatalogReconciliationResponse:
    job, run = airflow_catalog_identity(db, job_id, run_id)
    dataset_id = str(job.dataset_id or "").strip()
    if not dataset_id:
        error = hooks.catalog_reconciliation_error(
            "Persisted Job does not have a target dataset id.",
            {"jobId": job_id, "runId": run_id},
        )
        persist_catalog_reconciliation_failure(db, run_id, dataset_id, error.message, hooks=hooks)
        raise error

    task_states = dict(run.task_states or {})
    catalog_result = task_states.get("catalogResult")
    if (
        isinstance(catalog_result, dict)
        and catalog_result.get("status") == "success"
        and str(catalog_result.get("runId") or "") == run_id
        and str(catalog_result.get("datasetId") or "") == dataset_id
    ):
        dataset = etl_repository.get_dataset_schema_by_id(db, dataset_id)
        if dataset is not None:
            return AirflowCatalogReconciliationResponse(
                dataset=dataset,
                reconciled_at=str(catalog_result.get("reconciledAt") or hooks.iso_now()),
                run_id=run_id,
            )

    spark_result = task_states.get("sparkResult")
    if not isinstance(spark_result, dict) or spark_result.get("status") != "success":
        raise ApiError(
            "SPARK_RESULT_NOT_READY",
            "A persisted successful Spark result is required before Catalog reconciliation.",
            status.HTTP_409_CONFLICT,
            {"jobId": job_id, "runId": run_id},
        )
    if str(spark_result.get("runId") or run_id) != run_id:
        raise ApiError(
            "AIRFLOW_RUN_MISMATCH",
            "Persisted Spark result does not match the requested Airflow Run.",
            status.HTTP_409_CONFLICT,
            {"jobId": job_id, "runId": run_id, "sparkRunId": spark_result.get("runId")},
        )

    output_path = str(spark_result.get("outputPath") or "").strip()
    try:
        if job.iceberg_target and not hooks.is_kafka_job(job):
            enriched_result = hooks.verify_spark_iceberg_result(job, run_id, spark_result)
        else:
            hooks.validate_catalog_output_identity(job, run_id, output_path)
            physical = hooks.inspect_spark_output(output_path)
            enriched_result = {
                **spark_result,
                "parquetObjectCount": physical["parquetObjectCount"],
                "storageSizeBytes": physical["storageSizeBytes"],
            }
        return commit_airflow_catalog_reconciliation(
            db,
            job_id=job_id,
            run_id=run_id,
            result=enriched_result,
            retry_on_create_conflict=True,
            hooks=hooks,
        )
    except ApiError as exc:
        if str(exc.code) == "CATALOG_RECONCILIATION_FAILED":
            persist_catalog_reconciliation_failure(db, run_id, dataset_id, exc.message, hooks=hooks)
        raise
    except Exception as exc:
        message = hooks.compact_storage_text(exc, limit=1800)
        persist_catalog_reconciliation_failure(db, run_id, dataset_id, message, hooks=hooks)
        raise hooks.catalog_reconciliation_error(
            "Catalog reconciliation failed.",
            {"jobId": job_id, "runId": run_id, "reason": message},
        ) from exc


def airflow_catalog_identity(
    db: Session,
    job_id: str,
    run_id: str,
) -> tuple[ETLJobModel, ETLRunModel]:
    job = etl_repository.get_job(db, job_id)
    if job is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job_id}", status.HTTP_404_NOT_FOUND)
    run = etl_repository.get_run_model(db, run_id)
    if run is None or run.job_id != job.id or run.airflow_dag_run_id != run_id:
        raise ApiError(
            "AIRFLOW_RUN_MISMATCH",
            "Catalog reconciliation does not match a persisted AskLake Run.",
            status.HTTP_409_CONFLICT,
            {"jobId": job_id, "runId": run_id},
        )
    return job, run


def commit_airflow_catalog_reconciliation(
    db: Session,
    *,
    job_id: str,
    run_id: str,
    result: dict[str, Any],
    retry_on_create_conflict: bool,
    hooks: AirflowCatalogReconciliationHooks,
) -> AirflowCatalogReconciliationResponse:
    job, run = airflow_catalog_identity(db, job_id, run_id)
    dataset_id = str(job.dataset_id or "").strip()
    existing_dataset = etl_repository.get_dataset_by_id_for_update(db, dataset_id)
    name_match = etl_repository.get_dataset_by_name(db, job.target)
    if name_match is not None and name_match.id != dataset_id:
        raise hooks.catalog_reconciliation_error(
            "Target dataset name is already owned by another dataset id.",
            {"datasetId": dataset_id, "existingDatasetId": name_match.id, "runId": run_id},
        )

    reconciled_at = hooks.iso_now()
    dataset_model = hooks.dataset_from_spark_result(job, result, existing_dataset)
    iceberg_commit = result.get("icebergCommit") if isinstance(result.get("icebergCommit"), dict) else {}
    catalog_result = {
        "dataFileCount": hooks.parse_count_value(result.get("dataFileCount")),
        "datasetId": dataset_id,
        "icebergSnapshotId": hooks.optional_string(iceberg_commit.get("snapshotId")),
        "parquetObjectCount": hooks.parse_count_value(result.get("parquetObjectCount")),
        "reconciledAt": reconciled_at,
        "runId": run_id,
        "status": "success",
        "storageLocation": result.get("materializationOutputPath") or result.get("outputPath"),
        "storageSizeBytes": hooks.parse_count_value(result.get("storageSizeBytes")),
    }
    run.task_states = {
        **(run.task_states or {}),
        "sparkResult": result,
        "catalogResult": catalog_result,
    }

    try:
        _, _, dataset = etl_repository.save_command_result(db, job, run, dataset_model)
    except IntegrityError:
        db.rollback()
        if retry_on_create_conflict:
            return commit_airflow_catalog_reconciliation(
                db,
                job_id=job_id,
                run_id=run_id,
                result=result,
                retry_on_create_conflict=False,
                hooks=hooks,
            )
        raise

    if dataset is None:
        raise RuntimeError("Catalog reconciliation committed without a dataset response.")
    return AirflowCatalogReconciliationResponse(
        dataset=dataset,
        reconciled_at=reconciled_at,
        run_id=run_id,
    )


def persist_catalog_reconciliation_failure(
    db: Session,
    run_id: str,
    dataset_id: str,
    message: str,
    *,
    hooks: AirflowCatalogReconciliationHooks,
) -> None:
    try:
        db.rollback()
        run = etl_repository.get_run_model(db, run_id)
        if run is None:
            return
        failed_at = hooks.iso_now()
        compact_message = hooks.compact_storage_text(message, limit=1800)
        run.task_states = {
            **(run.task_states or {}),
            "catalogResult": {
                "datasetId": dataset_id,
                "error": compact_message,
                "failedAt": failed_at,
                "runId": run_id,
                "status": "failed",
            },
        }
        run.failed_stage = "Catalog reconciliation"
        run.error_summary = compact_message
        db.add(run)
        db.commit()
    except Exception:
        db.rollback()
