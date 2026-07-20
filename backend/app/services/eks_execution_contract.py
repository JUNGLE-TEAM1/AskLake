from __future__ import annotations

import os
import secrets
import threading
from typing import Any, Callable

from fastapi import status
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings
from app.core.errors import ApiError
from app.repositories import etl_repository


FASTAPI_EXECUTION_OWNER = f"{os.environ.get('HOSTNAME') or 'local'}:{os.getpid()}:{secrets.token_hex(8)}"
DEFAULT_SPARK_EXECUTION_LEASE_SECONDS = 60
SPARK_KUBERNETES_IMMUTABLE_IDENTITY_FIELDS = (
    "runId",
    "jobId",
    "namespace",
    "applicationName",
    "applicationUid",
    "imageDigest",
    "attemptGeneration",
    "driverPodName",
)
SPARK_KUBERNETES_TERMINAL_FAILURE_STATES = frozenset(
    {"FAILED", "SUBMISSION_FAILED"}
)


def external_continuous_control_plane_enabled() -> bool:
    return settings.asklake_continuous_control_plane == "external_ec2"


def continuous_runtime_reconciliation_enabled() -> bool:
    """Return whether this process owns Continuous runtime side effects.

    The EKS API persists commands while a dedicated worker reconciles them.  A
    read from an API process configured as ``disabled`` must therefore remain
    side-effect free; otherwise it can race the worker and record failures with
    an incomplete API-only runtime environment.
    """
    if settings.continuous_control_plane not in {"embedded", "worker"}:
        return False
    return (
        not external_continuous_control_plane_enabled()
        or settings.continuous_control_plane == "worker"
    )


def clickhouse_v2_continuous_job(continuous_config: Any | None) -> bool:
    return (
        isinstance(continuous_config, dict)
        and continuous_config.get("runtimeEngine") == "kafka_connect_clickhouse_v2"
    )


def job_visible_in_current_control_plane(
    execution_mode: str | None,
    continuous_config: Any | None = None,
) -> bool:
    return (
        not external_continuous_control_plane_enabled()
        or execution_mode != "continuous"
        or clickhouse_v2_continuous_job(continuous_config)
    )


def require_local_continuous_control_plane(
    continuous_config: Any | None = None,
) -> None:
    if (
        not external_continuous_control_plane_enabled()
        or clickhouse_v2_continuous_job(continuous_config)
    ):
        return
    raise ApiError(
        "CONTINUOUS_CONTROL_OWNED_BY_EC2",
        "Kafka Continuous control remains owned by the EC2 environment for the EKS MVP.",
        status.HTTP_409_CONFLICT,
        {"controlPlane": "external_ec2"},
    )


def run_execution_heartbeat_interval_seconds(lease_seconds: int) -> float:
    return max(1.0, min(float(lease_seconds) / 3, 30.0))


def spark_execution_lease_seconds() -> int:
    try:
        configured = int(
            os.environ.get("ASKLAKE_SPARK_EXECUTION_LEASE_SECONDS")
            or DEFAULT_SPARK_EXECUTION_LEASE_SECONDS
        )
    except ValueError:
        configured = DEFAULT_SPARK_EXECUTION_LEASE_SECONDS
    return max(10, min(configured, 3600))


def spark_kubernetes_max_attempts() -> int:
    try:
        configured = int(
            os.environ.get("ASKLAKE_SPARK_KUBERNETES_MAX_ATTEMPTS") or "2"
        )
    except ValueError:
        configured = 2
    return max(1, min(configured, 3))


def spark_kubernetes_terminal_failure(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and str(value.get("state") or "").strip().upper()
        in SPARK_KUBERNETES_TERMINAL_FAILURE_STATES
    )


def run_execution_lease_lost(job_id: str, run_id: str) -> ApiError:
    return ApiError(
        "SPARK_RUN_LEASE_LOST",
        "Spark Run execution lease was lost before the result could be persisted.",
        status.HTTP_409_CONFLICT,
        {"jobId": job_id, "runId": run_id},
    )


class RunExecutionLeaseHeartbeat:
    """Keep an RDS Run lease alive while an external Spark/Catalog call is in flight."""

    def __init__(self, db: Session, *, run_id: str, generation: int, lease_seconds: int) -> None:
        self._run_id = run_id
        self._generation = generation
        self._lease_seconds = lease_seconds
        self._interval_seconds = run_execution_heartbeat_interval_seconds(lease_seconds)
        self._session_factory = sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False, class_=Session)
        self._lost = threading.Event()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name=f"asklake-run-lease-{run_id}", daemon=True)

    @property
    def lost(self) -> bool:
        return self._lost.is_set()

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=1)

    def _run(self) -> None:
        while not self._stop.wait(self._interval_seconds):
            try:
                with self._session_factory() as lease_db:
                    renewed = etl_repository.renew_run_execution_lease(
                        lease_db,
                        self._run_id,
                        owner=FASTAPI_EXECUTION_OWNER,
                        generation=self._generation,
                        lease_seconds=self._lease_seconds,
                    )
                if not renewed:
                    self._lost.set()
                    return
            except Exception:
                self._lost.set()
                return


def spark_execution_identity_mismatch(message: str, *, job_id: str, run_id: str) -> ApiError:
    return ApiError(
        "SPARK_EXECUTION_IDENTITY_MISMATCH",
        message,
        status.HTTP_409_CONFLICT,
        {"jobId": job_id, "runId": run_id},
    )


def normalize_spark_kubernetes_execution(
    value: Any,
    *,
    job_id: str,
    run_id: str,
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise spark_execution_identity_mismatch(
            "Spark Kubernetes execution identity is missing.",
            job_id=job_id,
            run_id=run_id,
        )
    normalized: dict[str, Any] = {}
    for key in ("runId", "jobId", "namespace", "applicationName", "applicationUid", "imageDigest", "state"):
        item = str(value.get(key) or "").strip()
        if not item:
            raise spark_execution_identity_mismatch(
                f"Spark Kubernetes execution identity is missing {key}.",
                job_id=job_id,
                run_id=run_id,
            )
        normalized[key] = item
    attempt_generation = value.get("attemptGeneration", 1)
    if (
        not isinstance(attempt_generation, int)
        or isinstance(attempt_generation, bool)
        or attempt_generation < 1
        or attempt_generation > 3
    ):
        raise spark_execution_identity_mismatch(
            "Spark Kubernetes execution identity has an invalid attemptGeneration.",
            job_id=job_id,
            run_id=run_id,
        )
    normalized["attemptGeneration"] = attempt_generation
    if normalized["runId"] != run_id or normalized["jobId"] != job_id:
        raise spark_execution_identity_mismatch(
            "Spark Kubernetes run/job identity does not match the persisted AskLake Run.",
            job_id=job_id,
            run_id=run_id,
        )
    for key in ("driverPodName", "driverPodPhase", "driverTerminationReason", "driverFinishedAt", "observedAt"):
        item = str(value.get(key) or "").strip()
        if item:
            normalized[key] = item
    if isinstance(value.get("driverExitCode"), int) and not isinstance(value.get("driverExitCode"), bool):
        normalized["driverExitCode"] = value["driverExitCode"]
    if isinstance(value.get("recovered"), bool):
        normalized["recovered"] = value["recovered"]
    if isinstance(value.get("replacement"), bool):
        normalized["replacement"] = value["replacement"]
    if isinstance(value.get("resultMarkerFound"), bool):
        normalized["resultMarkerFound"] = value["resultMarkerFound"]
    return normalized


def merge_spark_kubernetes_execution(
    current: dict[str, Any],
    observed: dict[str, Any],
    *,
    job_id: str,
    run_id: str,
) -> dict[str, Any]:
    for key in SPARK_KUBERNETES_IMMUTABLE_IDENTITY_FIELDS:
        current_value = str(current.get(key) or "").strip()
        observed_value = str(observed.get(key) or "").strip()
        if current_value and observed_value and current_value != observed_value:
            raise spark_execution_identity_mismatch(
                f"Spark Kubernetes execution identity changed for {key}.",
                job_id=job_id,
                run_id=run_id,
            )
    return {**current, **observed}


def persist_spark_kubernetes_execution_progress(
    db: Session,
    *,
    job_id: str,
    run_id: str,
    generation: int,
    progress: dict[str, Any],
) -> None:
    run = etl_repository.get_run_for_execution_fence(
        db,
        run_id,
        owner=FASTAPI_EXECUTION_OWNER,
        generation=generation,
    )
    if run is None:
        raise run_execution_lease_lost(job_id, run_id)
    if run.job_id != job_id:
        raise spark_execution_identity_mismatch(
            "Spark progress jobId does not match the persisted AskLake Run.",
            job_id=job_id,
            run_id=run_id,
        )
    execution = (run.task_states or {}).get("sparkExecution")
    if not isinstance(execution, dict) or execution.get("generation") != generation:
        raise run_execution_lease_lost(job_id, run_id)
    observed = normalize_spark_kubernetes_execution(progress, job_id=job_id, run_id=run_id)
    current = execution.get("kubernetesExecution")
    if isinstance(current, dict):
        observed = merge_spark_kubernetes_execution(
            current,
            observed,
            job_id=job_id,
            run_id=run_id,
        )
    run.task_states = {
        **(run.task_states or {}),
        "sparkExecution": {
            **execution,
            "kubernetesExecution": observed,
        },
    }
    db.commit()


def spark_kubernetes_execution_progress_callback(
    db: Session,
    *,
    job_id: str,
    run_id: str,
    generation: int,
) -> Callable[[dict[str, Any]], None]:
    progress_sessions = sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False, class_=Session)

    def persist(progress: dict[str, Any]) -> None:
        with progress_sessions() as progress_db:
            persist_spark_kubernetes_execution_progress(
                progress_db,
                job_id=job_id,
                run_id=run_id,
                generation=generation,
                progress=progress,
            )

    return persist
