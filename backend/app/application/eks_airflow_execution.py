"""Kubernetes Spark execution with an RDS owner/generation fence.

The general Airflow command remains in :mod:`airflow_execution`.  This module
owns only the EKS/Kubernetes variant where a FastAPI replica can disappear
while the SparkApplication continues to run.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone
from time import perf_counter
from typing import Any

from fastapi import status
from sqlalchemy.orm import Session

from app.application.etl_job_projection import (
    format_duration_ms,
    format_rows,
    iso_now,
    stable_id,
)
from app.application.etl_run_projection import spark_error_summary, spark_failed_stage
from app.application.etl_runtime_support import compact_storage_text
from app.core.errors import ApiError
from app.models import ETLJobModel
from app.repositories import etl_repository
from app.schemas.common import ErrorCode
from app.services.eks_execution_contract import (
    FASTAPI_EXECUTION_OWNER,
    RunExecutionLeaseHeartbeat,
    merge_spark_kubernetes_execution,
    normalize_spark_kubernetes_execution,
    run_execution_lease_lost,
    spark_execution_identity_mismatch,
    spark_execution_lease_seconds,
    spark_kubernetes_max_attempts,
    spark_kubernetes_terminal_failure,
    spark_kubernetes_execution_progress_callback,
)
from app.services.etl.eks_fixture import (
    is_eks_mvp_bounded_fixture_job,
    persisted_eks_mvp_fixture_source_boundary,
    require_matching_airflow_source_boundary,
    validate_eks_mvp_fixture_spark_result,
)


SparkRunner = Callable[..., dict[str, Any]]
ManifestBuilder = Callable[[dict[str, Any], str], dict[str, Any]]


def record_eks_msk_authorization_fault(
    db: Session,
    *,
    acknowledged_records: int,
    attempted_records: int,
    category: str,
    evidence_sha256: str,
    job_id: str,
    run_id: str,
) -> dict[str, Any]:
    """Attach one deny-only MSK write attempt to an existing EKS fixture Run."""
    job = etl_repository.get_job(db, job_id)
    run = etl_repository.get_run_model(db, run_id)
    if (
        job is None
        or run is None
        or run.job_id != job.id
        or run.airflow_dag_run_id != run_id
    ):
        raise ApiError(
            "AIRFLOW_RUN_MISMATCH",
            "MSK fault evidence does not match a persisted AskLake Run.",
            status.HTTP_409_CONFLICT,
            {"jobId": job_id, "runId": run_id},
        )
    if not is_eks_mvp_bounded_fixture_job(job):
        raise ApiError(
            "MSK_FAULT_RUN_NOT_ISOLATED",
            "MSK fault evidence is accepted only for an isolated EKS fixture Run.",
            status.HTTP_409_CONFLICT,
            {"jobId": job_id, "runId": run_id},
        )
    if (
        category != "AUTHORIZATION"
        or attempted_records != 1
        or acknowledged_records != 0
    ):
        raise ApiError(
            "MSK_FAULT_EVIDENCE_INVALID",
            "MSK fault evidence must prove one denied write with zero acknowledgements.",
            status.HTTP_409_CONFLICT,
            {"jobId": job_id, "runId": run_id},
        )
    normalized_digest = str(evidence_sha256 or "").strip().lower()
    if (
        len(normalized_digest) != 64
        or any(character not in "0123456789abcdef" for character in normalized_digest)
    ):
        raise ApiError(
            "MSK_FAULT_EVIDENCE_INVALID",
            "MSK fault evidence SHA-256 is invalid.",
            status.HTTP_409_CONFLICT,
            {"jobId": job_id, "runId": run_id},
        )
    existing_attempts = (
        list((run.task_states or {}).get("faultAttempts") or [])
        if isinstance((run.task_states or {}).get("faultAttempts"), list)
        else []
    )
    if existing_attempts:
        existing = existing_attempts[0]
        if (
            isinstance(existing, dict)
            and existing.get("kind") == "msk_authorization"
            and existing.get("evidenceSha256") == normalized_digest
        ):
            return existing
        raise ApiError(
            "MSK_FAULT_ALREADY_RECORDED",
            "A different MSK fault attempt is already attached to this Run.",
            status.HTTP_409_CONFLICT,
            {"jobId": job_id, "runId": run_id},
        )
    if isinstance((run.task_states or {}).get("sparkResult"), dict):
        raise ApiError(
            "MSK_FAULT_AFTER_TERMINAL_RESULT",
            "MSK fault evidence cannot be attached after Spark terminal result.",
            status.HTTP_409_CONFLICT,
            {"jobId": job_id, "runId": run_id},
        )

    lease = etl_repository.claim_run_execution_lease(
        db,
        run_id,
        owner=FASTAPI_EXECUTION_OWNER,
        lease_seconds=spark_execution_lease_seconds(),
    )
    if lease is None:
        raise ApiError(
            "SPARK_RUN_ALREADY_EXECUTING",
            "The Run is already owned by an active execution.",
            status.HTTP_409_CONFLICT,
            {"jobId": job_id, "runId": run_id},
        )
    run = etl_repository.get_run_for_execution_fence(
        db,
        run_id,
        owner=FASTAPI_EXECUTION_OWNER,
        generation=lease.generation,
    )
    if run is None:
        raise run_execution_lease_lost(job_id, run_id)
    attempt = {
        "acknowledgedRecords": 0,
        "attemptedRecords": 1,
        "category": "AUTHORIZATION",
        "evidenceSha256": normalized_digest,
        "generation": lease.generation,
        "kind": "msk_authorization",
        "observedAt": datetime.now(timezone.utc).isoformat(),
        "owner": FASTAPI_EXECUTION_OWNER,
        "status": "failed",
    }
    run.task_states = {
        **(run.task_states or {}),
        "faultAttempts": [attempt],
    }
    run.execution_owner = None
    run.execution_lease_expires_at = None
    db.commit()
    return attempt


def execute_eks_airflow_spark_run(
    db: Session,
    *,
    job_id: str,
    run_id: str,
    command: str,
    airflow_source_boundary: dict[str, Any] | None,
    run_spark_job: SparkRunner,
    spark_result_manifest: ManifestBuilder,
) -> dict[str, Any]:
    job = etl_repository.get_job(db, job_id)
    run = etl_repository.get_run_model(db, run_id)
    if job is None:
        raise ApiError(
            ErrorCode.NOT_FOUND,
            f"Job not found: {job_id}",
            status.HTTP_404_NOT_FOUND,
        )
    if run is None or run.job_id != job.id or run.airflow_dag_run_id != run_id:
        raise ApiError(
            "AIRFLOW_RUN_MISMATCH",
            "Airflow Spark execution does not match a persisted AskLake Run.",
            status.HTTP_409_CONFLICT,
            {"jobId": job_id, "runId": run_id},
        )
    source_boundary = require_matching_airflow_source_boundary(
        run,
        airflow_source_boundary,
    )
    existing_result = (run.task_states or {}).get("sparkResult")
    if isinstance(existing_result, dict) and existing_result.get("status") == "success":
        return existing_result

    lease_seconds = spark_execution_lease_seconds()
    lease = etl_repository.claim_run_execution_lease(
        db,
        run_id,
        owner=FASTAPI_EXECUTION_OWNER,
        lease_seconds=lease_seconds,
    )
    if lease is None:
        raise ApiError(
            "SPARK_RUN_ALREADY_EXECUTING",
            "Spark execution is already active for this Airflow Run.",
            status.HTTP_409_CONFLICT,
            {"jobId": job_id, "runId": run_id},
        )

    attempt_id = stable_id(
        "spark-attempt",
        f"{run_id}:{lease.generation}:{FASTAPI_EXECUTION_OWNER}",
    )
    heartbeat = RunExecutionLeaseHeartbeat(
        db,
        run_id=run_id,
        generation=lease.generation,
        lease_seconds=lease_seconds,
    )

    run = etl_repository.get_run_for_execution_fence(
        db,
        run_id,
        owner=FASTAPI_EXECUTION_OWNER,
        generation=lease.generation,
    )
    if run is None:
        raise run_execution_lease_lost(job_id, run_id)
    try:
        previous_execution = (run.task_states or {}).get("sparkExecution")
        previous_kubernetes_execution = (
            previous_execution.get("kubernetesExecution")
            if isinstance(previous_execution, dict)
            and isinstance(previous_execution.get("kubernetesExecution"), dict)
            else None
        )
        if previous_kubernetes_execution is not None:
            previous_kubernetes_execution = normalize_spark_kubernetes_execution(
                previous_kubernetes_execution,
                job_id=job_id,
                run_id=run_id,
            )
        previous_attempts = (
            list(previous_execution.get("kubernetesAttempts") or [])
            if isinstance(previous_execution, dict)
            and isinstance(previous_execution.get("kubernetesAttempts"), list)
            else []
        )
        terminal_replacement = spark_kubernetes_terminal_failure(
            previous_kubernetes_execution
        )
        if terminal_replacement:
            previous_attempt_generation = int(
                previous_kubernetes_execution.get("attemptGeneration") or 1
            )
            spark_attempt_generation = previous_attempt_generation + 1
            if spark_attempt_generation > spark_kubernetes_max_attempts():
                raise ApiError(
                    "SPARK_TERMINAL_RETRY_EXHAUSTED",
                    "Spark terminal retry exceeded the configured bounded attempt limit.",
                    status.HTTP_409_CONFLICT,
                    {
                        "jobId": job_id,
                        "runId": run_id,
                        "attemptGeneration": previous_attempt_generation,
                    },
                )
            if not any(
                isinstance(item, dict)
                and item.get("attemptGeneration") == previous_attempt_generation
                for item in previous_attempts
            ):
                previous_attempts.append(previous_kubernetes_execution)
        else:
            spark_attempt_generation = int(
                (previous_kubernetes_execution or {}).get("attemptGeneration")
                or 1
            )
        run.task_states = {
            **(run.task_states or {}),
            "sparkExecution": {
                "attemptId": attempt_id,
                "generation": lease.generation,
                "startedAt": iso_now(),
                "status": "running",
                "kubernetesAttempts": previous_attempts,
                **(
                    {"kubernetesExecution": previous_kubernetes_execution}
                    if previous_kubernetes_execution is not None
                    and not terminal_replacement
                    else {}
                ),
            },
        }
        db.commit()
    except Exception:
        db.rollback()
        etl_repository.release_run_execution_lease(
            db,
            run_id,
            owner=FASTAPI_EXECUTION_OWNER,
            generation=lease.generation,
        )
        raise
    heartbeat.start()

    try:
        job = etl_repository.get_job(db, job_id)
        if job is None:
            raise ApiError(
                ErrorCode.NOT_FOUND,
                f"Job not found after Spark claim: {job_id}",
                status.HTTP_404_NOT_FOUND,
            )
        progress_callback = spark_kubernetes_execution_progress_callback(
            db,
            job_id=job_id,
            run_id=run_id,
            generation=lease.generation,
        )
        spark_kwargs: dict[str, Any] = {
            "spark_progress_callback": progress_callback,
        }
        if spark_attempt_generation > 1:
            spark_kwargs["spark_attempt_generation"] = spark_attempt_generation
        if source_boundary is not None:
            spark_kwargs["source_boundary"] = source_boundary
        if previous_kubernetes_execution is not None:
            spark_kwargs["expected_kubernetes_execution"] = (
                previous_kubernetes_execution
            )
        result = run_spark_job(
            db,
            job,
            command,
            run_id,
            **spark_kwargs,
        )
    except Exception as exc:
        heartbeat.stop()
        finalize_eks_spark_execution_attempt(
            db,
            job_id=job_id,
            run_id=run_id,
            generation=lease.generation,
            error=compact_storage_text(exc, limit=1000),
        )
        raise
    heartbeat.stop()
    if heartbeat.lost:
        raise run_execution_lease_lost(job_id, run_id)

    manifest = spark_result_manifest(result, run_id)
    if str(manifest.get("runId") or "") != run_id:
        mismatch = spark_execution_identity_mismatch(
            "Spark result runId does not match the persisted AskLake Run.",
            job_id=job_id,
            run_id=run_id,
        )
        finalize_eks_spark_execution_attempt(
            db,
            job_id=job_id,
            run_id=run_id,
            generation=lease.generation,
            error=mismatch.message,
        )
        raise mismatch
    try:
        validate_eks_mvp_fixture_spark_result(
            job,
            run_id,
            source_boundary,
            manifest,
        )
    except ApiError as exc:
        finalize_eks_spark_execution_attempt(
            db,
            job_id=job_id,
            run_id=run_id,
            generation=lease.generation,
            error=exc.message,
        )
        raise

    db.expire_all()
    run = etl_repository.get_run_for_execution_fence(
        db,
        run_id,
        owner=FASTAPI_EXECUTION_OWNER,
        generation=lease.generation,
    )
    if run is None:
        raise run_execution_lease_lost(job_id, run_id)
    job = etl_repository.get_job_for_update(db, job_id)
    if job is None:
        raise ApiError(
            ErrorCode.NOT_FOUND,
            f"Job not found after Spark execution: {job_id}",
            status.HTTP_404_NOT_FOUND,
        )
    if run.job_id != job.id:
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            "Spark Run disappeared during finalization",
            status.HTTP_409_CONFLICT,
        )
    execution = (run.task_states or {}).get("sparkExecution")
    if not isinstance(execution, dict) or execution.get("generation") != lease.generation:
        raise run_execution_lease_lost(job_id, run_id)

    try:
        terminal_kubernetes_execution = normalize_spark_kubernetes_execution(
            manifest.get("kubernetesExecution"),
            job_id=job_id,
            run_id=run_id,
        )
        persisted_kubernetes_execution = execution.get("kubernetesExecution")
        if not isinstance(persisted_kubernetes_execution, dict):
            raise spark_execution_identity_mismatch(
                "SparkApplication identity was not persisted before terminal result handling.",
                job_id=job_id,
                run_id=run_id,
            )
        terminal_kubernetes_execution = merge_spark_kubernetes_execution(
            persisted_kubernetes_execution,
            terminal_kubernetes_execution,
            job_id=job_id,
            run_id=run_id,
        )
        if (
            manifest.get("status") == "success"
            and terminal_kubernetes_execution.get("resultMarkerFound") is not True
        ):
            raise spark_execution_identity_mismatch(
                "Spark success result is missing the driver result marker.",
                job_id=job_id,
                run_id=run_id,
            )
        manifest["kubernetesExecution"] = terminal_kubernetes_execution
        execution = {
            **execution,
            "kubernetesExecution": terminal_kubernetes_execution,
        }
    except ApiError as exc:
        finalize_eks_spark_execution_attempt(
            db,
            job_id=job_id,
            run_id=run_id,
            generation=lease.generation,
            error=exc.message,
        )
        raise

    run.input_rows = format_rows(manifest.get("inputRows"))
    run.output_rows = format_rows(manifest.get("outputRows"))
    run.output_path = manifest.get("outputPath") or run.output_path
    run.duration = format_duration_ms(manifest.get("durationMs"))
    run.ended_at = str(manifest.get("endedAt") or run.ended_at)
    run.failed_stage = (
        "-" if manifest.get("status") == "success" else spark_failed_stage(manifest)
    )
    run.error_summary = (
        "-" if manifest.get("status") == "success" else spark_error_summary(manifest)
    )
    run.task_states = {
        **(run.task_states or {}),
        "sparkExecution": {
            **execution,
            "endedAt": str(manifest.get("endedAt") or iso_now()),
            "status": "success" if manifest.get("status") == "success" else "failed",
        },
        "sparkResult": manifest,
    }
    run.execution_owner = None
    run.execution_lease_expires_at = None
    if manifest.get("status") == "success" and manifest.get("outputPath"):
        job.target_path = str(manifest["outputPath"])
    db.commit()
    return manifest


def finalize_eks_spark_execution_attempt(
    db: Session,
    *,
    job_id: str,
    run_id: str,
    generation: int,
    error: str,
) -> None:
    # Progress is persisted through a separate session.  Expire the caller's
    # identity map so failure finalization cannot overwrite the application UID.
    db.expire_all()
    run = etl_repository.get_run_for_execution_fence(
        db,
        run_id,
        owner=FASTAPI_EXECUTION_OWNER,
        generation=generation,
    )
    if run is None:
        return
    job = etl_repository.get_job_for_update(db, job_id)
    if job is None or run.job_id != job.id:
        db.rollback()
        return
    execution = (run.task_states or {}).get("sparkExecution")
    if not isinstance(execution, dict) or execution.get("generation") != generation:
        db.rollback()
        return
    run.task_states = {
        **(run.task_states or {}),
        "sparkExecution": {
            **execution,
            "endedAt": iso_now(),
            "error": error,
            "status": "failed",
        },
    }
    run.execution_owner = None
    run.execution_lease_expires_at = None
    db.commit()


def reconcile_eks_airflow_catalog(
    db: Session,
    *,
    job_id: str,
    run_id: str,
    hooks: Any,
) -> Any:
    """Publish one Kubernetes Spark result under a fresh RDS generation."""
    from app.application.airflow_execution import (
        airflow_catalog_identity,
        commit_airflow_catalog_reconciliation,
        persist_catalog_reconciliation_failure,
    )

    job, run = airflow_catalog_identity(db, job_id, run_id)
    dataset_id = str(job.dataset_id or "").strip()
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
            from app.schemas.etl import AirflowCatalogReconciliationResponse

            return AirflowCatalogReconciliationResponse(
                dataset=dataset,
                reconciled_at=str(
                    catalog_result.get("reconciledAt") or hooks.iso_now(),
                ),
                run_id=run_id,
            )

    catalog_started_at = hooks.iso_now()
    catalog_started_monotonic = perf_counter()
    lease_seconds = spark_execution_lease_seconds()
    lease = etl_repository.claim_run_execution_lease(
        db,
        run_id,
        owner=FASTAPI_EXECUTION_OWNER,
        lease_seconds=lease_seconds,
    )
    if lease is None:
        raise ApiError(
            "SPARK_RUN_ALREADY_EXECUTING",
            "Spark Run submission or Catalog reconciliation is already active.",
            status.HTTP_409_CONFLICT,
            {"jobId": job_id, "runId": run_id},
        )
    heartbeat = RunExecutionLeaseHeartbeat(
        db,
        run_id=run_id,
        generation=lease.generation,
        lease_seconds=lease_seconds,
    )
    heartbeat.start()
    completed = False

    try:
        if not dataset_id:
            raise hooks.catalog_reconciliation_error(
                "Persisted Job does not have a target dataset id.",
                {"jobId": job_id, "runId": run_id},
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
                {
                    "jobId": job_id,
                    "runId": run_id,
                    "sparkRunId": spark_result.get("runId"),
                },
            )

        fixture_job = is_eks_mvp_bounded_fixture_job(job)
        if job.iceberg_target and (not hooks.is_kafka_job(job) or fixture_job):
            expected_run_row_count = None
            if fixture_job:
                source_boundary = persisted_eks_mvp_fixture_source_boundary(run)
                if source_boundary is None:
                    raise hooks.catalog_reconciliation_error(
                        "Persisted EKS fixture boundary is required for Catalog reconciliation.",
                        {"jobId": job.id, "runId": run.run_id},
                    )
                expected_run_row_count = source_boundary["expectedCount"]
            enriched_result = hooks.verify_spark_iceberg_result(
                job,
                run_id,
                spark_result,
                expected_run_row_count=expected_run_row_count,
            )
        else:
            output_path = str(spark_result.get("outputPath") or "").strip()
            hooks.validate_catalog_output_identity(job, run_id, output_path)
            physical = hooks.inspect_spark_output(output_path)
            enriched_result = {
                **spark_result,
                "parquetObjectCount": physical["parquetObjectCount"],
                "storageSizeBytes": physical["storageSizeBytes"],
            }
        if heartbeat.lost:
            raise run_execution_lease_lost(job_id, run_id)
        response = commit_airflow_catalog_reconciliation(
            db,
            job_id=job_id,
            run_id=run_id,
            result=enriched_result,
            retry_on_create_conflict=True,
            hooks=hooks,
            owner=FASTAPI_EXECUTION_OWNER,
            generation=lease.generation,
            timing_started_at=catalog_started_at,
            timing_started_monotonic=catalog_started_monotonic,
        )
        completed = True
        return response
    except ApiError as exc:
        if str(exc.code) == "CATALOG_RECONCILIATION_FAILED":
            persist_catalog_reconciliation_failure(
                db,
                run_id,
                dataset_id,
                exc.message,
                hooks=hooks,
                owner=FASTAPI_EXECUTION_OWNER,
                generation=lease.generation,
                timing_started_at=catalog_started_at,
                timing_started_monotonic=catalog_started_monotonic,
            )
        raise
    except Exception as exc:
        message = compact_storage_text(exc, limit=1800)
        persist_catalog_reconciliation_failure(
            db,
            run_id,
            dataset_id,
            message,
            hooks=hooks,
            owner=FASTAPI_EXECUTION_OWNER,
            generation=lease.generation,
            timing_started_at=catalog_started_at,
            timing_started_monotonic=catalog_started_monotonic,
        )
        raise hooks.catalog_reconciliation_error(
            "Catalog reconciliation failed.",
            {"jobId": job_id, "runId": run_id, "reason": message},
        ) from exc
    finally:
        heartbeat.stop()
        if not completed:
            db.rollback()
            etl_repository.release_run_execution_lease(
                db,
                run_id,
                owner=FASTAPI_EXECUTION_OWNER,
                generation=lease.generation,
            )
