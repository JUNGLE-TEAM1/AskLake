"""Persist isolated deny-only MSK fault evidence for one EKS fixture Run."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import status
from sqlalchemy.orm import Session

from app.core.errors import ApiError
from app.repositories import etl_repository
from app.services.eks_execution_contract import (
    FASTAPI_EXECUTION_OWNER,
    run_execution_lease_lost,
    spark_execution_lease_seconds,
)
from app.services.etl.eks_fixture import is_eks_mvp_bounded_fixture_job


def _require_fault_target(db: Session, job_id: str, run_id: str) -> Any:
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
    return run


def _normalize_fault_evidence(
    *,
    acknowledged_records: int,
    attempted_records: int,
    category: str,
    evidence_sha256: str,
    job_id: str,
    run_id: str,
) -> str:
    normalized_digest = str(evidence_sha256 or "").strip().lower()
    valid_digest = len(normalized_digest) == 64 and all(
        character in "0123456789abcdef" for character in normalized_digest
    )
    if (
        category != "AUTHORIZATION"
        or attempted_records != 1
        or acknowledged_records != 0
        or not valid_digest
    ):
        raise ApiError(
            "MSK_FAULT_EVIDENCE_INVALID",
            "MSK fault evidence must prove one denied write with zero acknowledgements and a valid SHA-256.",
            status.HTTP_409_CONFLICT,
            {"jobId": job_id, "runId": run_id},
        )
    return normalized_digest


def _existing_fault_attempt(
    run: Any,
    *,
    normalized_digest: str,
    job_id: str,
    run_id: str,
) -> dict[str, Any] | None:
    attempts = (run.task_states or {}).get("faultAttempts")
    existing_attempts = list(attempts) if isinstance(attempts, list) else []
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
    return None


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
    run = _require_fault_target(db, job_id, run_id)
    normalized_digest = _normalize_fault_evidence(
        acknowledged_records=acknowledged_records,
        attempted_records=attempted_records,
        category=category,
        evidence_sha256=evidence_sha256,
        job_id=job_id,
        run_id=run_id,
    )
    existing = _existing_fault_attempt(
        run,
        normalized_digest=normalized_digest,
        job_id=job_id,
        run_id=run_id,
    )
    if existing is not None:
        return existing

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
    run.task_states = {**(run.task_states or {}), "faultAttempts": [attempt]}
    run.execution_owner = None
    run.execution_lease_expires_at = None
    db.commit()
    return attempt
