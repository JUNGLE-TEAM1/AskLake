"""Background selection loop for durable Kafka Continuous runtime reconciliation."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import hashlib
import json
import logging
from typing import Any

from app.core.config import settings
from app.domain.continuous_runtime import runtime_contract_projection
from app.repositories import etl_repository


@dataclass(frozen=True, slots=True)
class ContinuousRuntimeSyncHooks:
    reconcile_stale_maintenance: Callable[..., None]
    refresh_runtime: Callable[..., None]
    report_has_unacknowledged_publication: Callable[..., bool]
    has_pending_replay_catalog: Callable[..., bool]


def sync_active_kafka_continuous_jobs(hooks: ContinuousRuntimeSyncHooks) -> None:
    """Persist worker progress without depending on UI polling."""
    from app.core.database import SessionLocal

    active_statuses = {"starting", "running", "pausing", "stopping"}
    terminal_statuses = {"paused", "stopped", "failed"}
    strict_owner = strict_owner_claim_required()
    with SessionLocal() as db:
        jobs = [job for job in etl_repository.list_job_models(db) if job.execution_mode == "continuous"]
        foreign_claim_present = any(
            runtime_claim_owner(etl_repository.get_kafka_continuous_runtime(db, job.id))
            not in {None, "ec2-continuous-worker"}
            for job in jobs
        )
        if not strict_owner and not foreign_claim_present:
            try:
                hooks.reconcile_stale_maintenance(db)
            except Exception:
                db.rollback()
                logging.getLogger(__name__).exception(
                    "Kafka continuous maintenance reconciliation failed before runtime synchronization"
                )
        job_ids = [job.id for job in jobs]
    for job_id in job_ids:
        _sync_job(job_id, active_statuses, terminal_statuses, hooks, strict_owner=strict_owner)


def strict_owner_claim_required() -> bool:
    return (
        settings.continuous_worker_owner != "ec2-continuous-worker"
        or settings.continuous_worker_generation is not None
    )


def runtime_identity_fingerprint(runtime: Any) -> str:
    identity = {
        "brokerIdentity": str(runtime.broker),
        "topic": str(runtime.topic),
        "consumerGroup": str(runtime.consumer_group_id),
        "checkpointIdentity": str(runtime.checkpoint_path),
    }
    payload = json.dumps(identity, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def build_runtime_owner_claim(
    runtime: Any,
    *,
    owner: str,
    generation: str,
    fencing_token: str,
    state_revision: int,
) -> dict[str, Any]:
    if owner not in {"ec2-continuous-worker", "eks-continuous-worker-v1"}:
        raise ValueError("unsupported Continuous runtime owner")
    if not generation or not fencing_token or state_revision < 1:
        raise ValueError("owner claim requires generation, fencing token, and positive state revision")
    return {
        "owner": owner,
        "generation": generation,
        "brokerIdentity": str(runtime.broker),
        "topic": str(runtime.topic),
        "consumerGroup": str(runtime.consumer_group_id),
        "checkpointIdentity": str(runtime.checkpoint_path),
        "identityFingerprint": runtime_identity_fingerprint(runtime),
        "fencingToken": fencing_token,
        "stateRevision": state_revision,
    }


def assign_runtime_owner_claim(
    runtime: Any,
    *,
    owner: str,
    generation: str,
    fencing_token: str,
    state_revision: int,
) -> dict[str, Any]:
    if str(runtime.status) not in {"stopped", "paused"}:
        raise ValueError("Continuous runtime owner may transfer only after the previous owner is stopped or paused")
    metrics = dict(runtime.metrics) if isinstance(runtime.metrics, dict) else {}
    metrics["ownerClaim"] = build_runtime_owner_claim(
        runtime,
        owner=owner,
        generation=generation,
        fencing_token=fencing_token,
        state_revision=state_revision,
    )
    runtime.metrics = metrics
    return metrics["ownerClaim"]


def runtime_matches_owner_claim(runtime: Any) -> bool:
    metrics = runtime.metrics if isinstance(runtime.metrics, dict) else {}
    claim = metrics.get("ownerClaim")
    if not isinstance(claim, dict):
        return False
    expected = {
        "owner": settings.continuous_worker_owner,
        "generation": settings.continuous_worker_generation,
        "brokerIdentity": str(runtime.broker),
        "topic": str(runtime.topic),
        "consumerGroup": str(runtime.consumer_group_id),
        "checkpointIdentity": str(runtime.checkpoint_path),
        "identityFingerprint": runtime_identity_fingerprint(runtime),
    }
    return (
        all(claim.get(key) == value for key, value in expected.items())
        and isinstance(claim.get("fencingToken"), str)
        and bool(claim["fencingToken"].strip())
        and isinstance(claim.get("stateRevision"), int)
        and claim["stateRevision"] >= 1
    )


def runtime_allowed_for_worker(runtime: Any, *, strict_owner: bool) -> bool:
    if strict_owner:
        return runtime_matches_owner_claim(runtime)
    metrics = runtime.metrics if isinstance(runtime.metrics, dict) else {}
    claim = metrics.get("ownerClaim")
    if not isinstance(claim, dict):
        return True
    return claim.get("owner") == "ec2-continuous-worker"


def runtime_claim_owner(runtime: Any | None) -> str | None:
    if runtime is None or not isinstance(runtime.metrics, dict):
        return None
    claim = runtime.metrics.get("ownerClaim")
    owner = claim.get("owner") if isinstance(claim, dict) else None
    return owner if isinstance(owner, str) and owner else None


def _sync_job(
    job_id: str,
    active_statuses: set[str],
    terminal_statuses: set[str],
    hooks: ContinuousRuntimeSyncHooks,
    *,
    strict_owner: bool,
) -> None:
    from app.core.database import SessionLocal

    with SessionLocal() as db:
        try:
            job = etl_repository.get_job(db, job_id)
            if job is None or job.execution_mode != "continuous":
                return
            runtime = etl_repository.get_kafka_continuous_runtime(db, job.id)
            if (
                runtime is not None
                and runtime_allowed_for_worker(runtime, strict_owner=strict_owner)
                and _requires_refresh(db, job, runtime, active_statuses, terminal_statuses, hooks)
            ):
                hooks.refresh_runtime(db, job)
        except Exception:
            db.rollback()
            logging.getLogger(__name__).exception(
                "Kafka continuous runtime synchronization failed for job_id=%s",
                job_id,
            )


def _requires_refresh(
    db: Any,
    job: Any,
    runtime: Any,
    active_statuses: set[str],
    terminal_statuses: set[str],
    hooks: ContinuousRuntimeSyncHooks,
) -> bool:
    metrics = runtime.metrics or {}
    recovery_state = metrics.get("publicationRecoveryPending")
    contract = runtime_contract_projection(
        metrics,
        public_status=runtime.status,
        legacy_error=getattr(runtime, "last_error", None),
    )
    return (
        runtime.status in active_statuses
        or contract.get("desiredState") == "running"
        or (runtime.status in terminal_statuses and recovery_state is not False)
        or recovery_state is True
        or hooks.report_has_unacknowledged_publication(job.id, runtime)
        or hooks.has_pending_replay_catalog(db, job.id)
    )
