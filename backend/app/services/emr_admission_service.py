from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
import hashlib
import math
import os
import re
from typing import Any, Mapping

from fastapi import status
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.models import EmrAdmissionReservationModel, ETLJobModel
from app.repositories import emr_admission_repository


WORKLOADS = frozenset({"batch", "continuous"})
REMOTE_QUEUE_STATES = frozenset({"QUEUED", "PENDING", "SCHEDULED"})
REMOTE_SUBMITTED_STATES = frozenset({"SUBMITTED", "STARTING"})
REMOTE_RUNNING_STATES = frozenset({"RUNNING"})
REMOTE_COMPLETED_STATES = frozenset({"SUCCESS", "COMPLETED"})
REMOTE_FAILED_STATES = frozenset({"FAILED", "FAILURE", "ERROR"})
REMOTE_CANCELED_STATES = frozenset({"CANCELLED", "CANCELED"})


@dataclass(frozen=True)
class AdmissionResources:
    vcpu: float
    memory_gb: float
    disk_gb: float
    max_executors: int


@dataclass(frozen=True)
class AdmissionPolicy:
    enabled: bool
    workload: str
    application_id: str
    project_key: str
    max_concurrent_runs: int
    max_queued_runs: int
    queue_timeout_minutes: int
    max_idle_minutes: int
    require_job_cost_allocation: bool
    max_vcpu: float
    max_memory_gb: float
    max_disk_gb: float
    actor_max_concurrent_runs: int
    actor_max_vcpu: float
    actor_max_memory_gb: float
    actor_max_disk_gb: float
    project_max_concurrent_runs: int
    project_max_vcpu: float
    project_max_memory_gb: float
    project_max_disk_gb: float
    priority: int


def admission_enabled(environment: Mapping[str, str] | None = None) -> bool:
    env = environment or os.environ
    return (
        str(env.get("ASKLAKE_SPARK_RUNTIME") or "").strip().lower() == "emr-serverless"
        and environment_flag(env.get("ASKLAKE_EMR_SERVERLESS_ADMISSION_ENABLED"), False)
    )


def admission_policy(workload: str, environment: Mapping[str, str] | None = None) -> AdmissionPolicy:
    normalized = str(workload or "").strip().lower()
    if normalized not in WORKLOADS:
        raise ValueError(f"Unsupported EMR admission workload: {normalized or '(empty)'}")
    env = environment or os.environ
    prefix = f"ASKLAKE_EMR_SERVERLESS_{normalized.upper()}"
    defaults = (
        {"concurrent": 5, "disk": 1000, "memory": 160, "queue": 20, "vcpu": 40, "priority": 100}
        if normalized == "continuous"
        else {"concurrent": 4, "disk": 2000, "memory": 320, "queue": 20, "vcpu": 80, "priority": 50}
    )
    max_concurrent = bounded_integer(env.get(f"{prefix}_MAX_CONCURRENT_RUNS"), defaults["concurrent"], 1, 1000)
    max_queue = bounded_integer(env.get(f"{prefix}_MAX_QUEUED_RUNS"), defaults["queue"], 0, 2000)
    max_vcpu = bounded_number(env.get(f"{prefix}_MAX_VCPU"), defaults["vcpu"], 1, 1_000_000)
    max_memory = bounded_number(env.get(f"{prefix}_MAX_MEMORY_GB"), defaults["memory"], 1, 1_000_000)
    max_disk = bounded_number(env.get(f"{prefix}_MAX_DISK_GB"), defaults["disk"], 1, 1_000_000)
    application_id = scoped_emr_value(env, normalized, "APPLICATION_ID")
    return AdmissionPolicy(
        enabled=admission_enabled(env),
        workload=normalized,
        application_id=application_id,
        project_key=str(env.get("ASKLAKE_EMR_SERVERLESS_PROJECT_KEY") or "default").strip() or "default",
        max_concurrent_runs=max_concurrent,
        max_queued_runs=max_queue,
        queue_timeout_minutes=bounded_integer(env.get(f"{prefix}_QUEUE_TIMEOUT_MINUTES"), 60, 15, 720),
        max_idle_minutes=bounded_integer(env.get(f"{prefix}_MAX_IDLE_MINUTES"), 15, 1, 10_080),
        require_job_cost_allocation=environment_flag(env.get("ASKLAKE_EMR_SERVERLESS_REQUIRE_JOB_COST_ALLOCATION"), True),
        max_vcpu=max_vcpu,
        max_memory_gb=max_memory,
        max_disk_gb=max_disk,
        actor_max_concurrent_runs=bounded_integer(env.get(f"{prefix}_ACTOR_MAX_CONCURRENT_RUNS"), max_concurrent + max_queue, 1, 3000),
        actor_max_vcpu=bounded_number(env.get(f"{prefix}_ACTOR_MAX_VCPU"), max_vcpu * 2, 1, 2_000_000),
        actor_max_memory_gb=bounded_number(env.get(f"{prefix}_ACTOR_MAX_MEMORY_GB"), max_memory * 2, 1, 2_000_000),
        actor_max_disk_gb=bounded_number(env.get(f"{prefix}_ACTOR_MAX_DISK_GB"), max_disk * 2, 1, 2_000_000),
        project_max_concurrent_runs=bounded_integer(env.get(f"{prefix}_PROJECT_MAX_CONCURRENT_RUNS"), max_concurrent + max_queue, 1, 3000),
        project_max_vcpu=bounded_number(env.get(f"{prefix}_PROJECT_MAX_VCPU"), max_vcpu * 2, 1, 2_000_000),
        project_max_memory_gb=bounded_number(env.get(f"{prefix}_PROJECT_MAX_MEMORY_GB"), max_memory * 2, 1, 2_000_000),
        project_max_disk_gb=bounded_number(env.get(f"{prefix}_PROJECT_MAX_DISK_GB"), max_disk * 2, 1, 2_000_000),
        priority=bounded_integer(env.get(f"{prefix}_QUEUE_PRIORITY"), defaults["priority"], -1000, 1000),
    )


def estimate_job_resources(workload: str, environment: Mapping[str, str] | None = None) -> AdmissionResources:
    normalized = str(workload or "").strip().lower()
    if normalized not in WORKLOADS:
        raise ValueError(f"Unsupported EMR admission workload: {normalized or '(empty)'}")
    env = environment or os.environ

    def value(suffix: str, default: str) -> str:
        return scoped_emr_value(env, normalized, suffix) or default

    driver_cores = bounded_integer(value("DRIVER_CORES", "1"), 1, 1, 16)
    driver_disk = bounded_integer(value("DRIVER_DISK_GB", "20"), 20, 20, 200)
    driver_memory = spark_memory_gb(value("DRIVER_MEMORY", "4g"))
    executor_cores = bounded_integer(value("EXECUTOR_CORES", "2"), 2, 1, 16)
    executor_disk = bounded_integer(value("EXECUTOR_DISK_GB", "20"), 20, 20, 200)
    executor_memory = spark_memory_gb(value("EXECUTOR_MEMORY", "4g"))
    max_executors = bounded_integer(value("MAX_EXECUTORS", "10"), 10, 1, 10_000)
    overhead = bounded_number(value("MEMORY_OVERHEAD_FACTOR", "0.1"), 0.1, 0, 1)
    return AdmissionResources(
        vcpu=float(driver_cores + executor_cores * max_executors),
        memory_gb=round_up((driver_memory + executor_memory * max_executors) * (1 + overhead), 3),
        disk_gb=float(driver_disk + executor_disk * max_executors),
        max_executors=max_executors,
    )


def reserve_emr_capacity(
    db: Session,
    *,
    job: ETLJobModel,
    workload: str,
    run_reference: str,
    actor_key: str | None = None,
    environment: Mapping[str, str] | None = None,
) -> EmrAdmissionReservationModel | None:
    env = environment or os.environ
    policy = admission_policy(workload, env)
    if not policy.enabled:
        return None
    if not policy.application_id:
        raise admission_error(
            "EMR admission requires an application ID.",
            "EMR_ADMISSION_CONFIGURATION_INVALID",
            status.HTTP_500_INTERNAL_SERVER_ERROR,
        )
    resources = estimate_job_resources(workload, env)
    actor = str(actor_key or job.created_by or job.owner or "unknown").strip() or "unknown"
    reference = str(run_reference or "").strip()
    if not reference:
        raise admission_error("EMR admission run reference is required.", "EMR_ADMISSION_REQUEST_INVALID", status.HTTP_422_UNPROCESSABLE_ENTITY)
    reservation_id = stable_reservation_id(job.id, policy.workload, reference)

    emr_admission_repository.lock_application_scope(db, policy.application_id, policy.workload, job.id)
    cleanup_expired_reservations(db, now=datetime.now(UTC), commit=False)
    existing = emr_admission_repository.get_reservation(db, reservation_id)
    if existing is not None and (
        existing.status in emr_admission_repository.NON_TERMINAL_STATUSES
        or existing.status == "completed"
    ):
        db.commit()
        return existing
    if existing is not None:
        db.delete(existing)
        db.flush()

    assert_request_fits_policy(resources, policy)
    current = emr_admission_repository.list_non_terminal(
        db,
        application_id=policy.application_id,
        workload=policy.workload,
    )
    assert_quota("actor", actor, current, resources, policy)
    assert_quota("project", policy.project_key, current, resources, policy)

    active = [item for item in current if item.status in emr_admission_repository.ACTIVE_SLOT_STATUSES]
    queued = [item for item in current if item.status == "queued"]
    resource_slot_available = (
        sum(item.requested_vcpu for item in active) + resources.vcpu <= policy.max_vcpu
        and sum(item.requested_memory_gb for item in active) + resources.memory_gb <= policy.max_memory_gb
        and sum(item.requested_disk_gb for item in active) + resources.disk_gb <= policy.max_disk_gb
    )
    admit_now = len(active) < policy.max_concurrent_runs and resource_slot_available
    if not admit_now and len(queued) >= policy.max_queued_runs:
        raise admission_error(
            "EMR admission queue is full; retry after an active Job reaches a terminal state.",
            "EMR_ADMISSION_QUEUE_FULL",
            status.HTTP_429_TOO_MANY_REQUESTS,
            {
                "applicationId": policy.application_id,
                "workload": policy.workload,
                "activeRuns": len(active),
                "queuedRuns": len(queued),
                "maxConcurrentRuns": policy.max_concurrent_runs,
                "maxQueuedRuns": policy.max_queued_runs,
            },
        )

    now = datetime.now(UTC)
    decision = "admitted" if admit_now else "queued"
    reason = (
        "AskLake capacity slot reserved; EMR application preflight is still required."
        if admit_now
        else "AskLake capacity is full; submission is delegated to the EMR Serverless native FIFO queue."
    )
    rate_snapshot = cost_rate_snapshot(env, policy.workload)
    reservation = EmrAdmissionReservationModel(
        reservation_id=reservation_id,
        workload=policy.workload,
        application_id=policy.application_id,
        job_id=job.id,
        run_reference=reference,
        actor_key=actor,
        project_key=policy.project_key,
        status=decision,
        priority=policy.priority,
        requested_vcpu=resources.vcpu,
        requested_memory_gb=resources.memory_gb,
        requested_disk_gb=resources.disk_gb,
        estimated_cost_usd_per_hour=estimated_hourly_cost(resources, rate_snapshot),
        decision_reason=reason,
        lease_expires_at=now + timedelta(
            minutes=policy.queue_timeout_minutes if decision == "queued" else 5
        ),
        queued_at=now if decision == "queued" else None,
        admitted_at=now if decision == "admitted" else None,
        resource_snapshot={
            "requested": resources_dict(resources),
            "policy": policy_dict(policy),
            "costRatesUsd": rate_snapshot,
            "queueDiscipline": "emr-native-fifo",
            "priorityNote": "Priority is recorded for observability; EMR Serverless controls native FIFO dispatch order.",
        },
    )
    emr_admission_repository.add_reservation(db, reservation)
    db.commit()
    db.refresh(reservation)
    return reservation


def sync_emr_reservation(
    db: Session,
    reservation: EmrAdmissionReservationModel | None,
    worker_result: Mapping[str, Any] | None,
    *,
    commit: bool = True,
) -> EmrAdmissionReservationModel | None:
    if reservation is None:
        return None
    result = worker_result or {}
    nested_runtime = result.get("runtime") if isinstance(result.get("runtime"), Mapping) else {}
    runtime_job_id = first_text(result.get("runtimeJobId"), result.get("jobRunId"), result.get("containerId"), nested_runtime.get("jobRunId"))
    remote_state = first_text(result.get("driverState"), result.get("runtimeState"), nested_runtime.get("state"), result.get("status"))
    normalized = remote_state.upper() if remote_state else ""
    now = datetime.now(UTC)
    if runtime_job_id:
        reservation.runtime_job_id = runtime_job_id
        reservation.submitted_at = reservation.submitted_at or now
    if normalized in REMOTE_QUEUE_STATES:
        reservation.status = "queued"
        reservation.queued_at = reservation.queued_at or now
    elif normalized in REMOTE_SUBMITTED_STATES:
        reservation.status = "submitted"
    elif normalized in REMOTE_RUNNING_STATES:
        reservation.status = "running"
        reservation.started_at = reservation.started_at or now
    elif normalized in REMOTE_COMPLETED_STATES:
        reservation.status = "completed"
    elif normalized in REMOTE_FAILED_STATES:
        reservation.status = "failed"
    elif normalized in REMOTE_CANCELED_STATES:
        reservation.status = "canceled"
    if reservation.status in emr_admission_repository.TERMINAL_STATUSES:
        reservation.ended_at = reservation.ended_at or now
        reservation.lease_expires_at = None
    elif runtime_job_id:
        reservation.lease_expires_at = None
    if commit:
        db.commit()
        db.refresh(reservation)
    return reservation


def fail_emr_reservation(
    db: Session,
    reservation: EmrAdmissionReservationModel | None,
    reason: str,
) -> None:
    if reservation is None:
        return
    reservation.status = "failed"
    reservation.decision_reason = str(reason or "EMR execution failed")[:2000]
    reservation.ended_at = datetime.now(UTC)
    reservation.lease_expires_at = None
    db.commit()


def cleanup_expired_reservations(
    db: Session,
    *,
    now: datetime | None = None,
    commit: bool = True,
) -> int:
    current = now or datetime.now(UTC)
    expired = 0
    for reservation in emr_admission_repository.list_non_terminal(db):
        lease = aware_datetime(reservation.lease_expires_at)
        if (
            reservation.runtime_job_id is None
            and reservation.status in {"admitted", "queued"}
            and lease is not None
            and lease <= current
        ):
            reservation.status = "expired"
            reservation.ended_at = current
            reservation.decision_reason = "Admission lease expired before a runtime Job ID was persisted."
            reservation.lease_expires_at = None
            expired += 1
    if commit and expired:
        db.commit()
    return expired


def runtime_capacity_overview(db: Session, actor: ActorContext, limit: int = 100) -> dict[str, Any]:
    if not actor.is_admin:
        raise ApiError("FORBIDDEN", "Admin role is required", status.HTTP_403_FORBIDDEN)
    cleanup_expired_reservations(db)
    policies = [admission_policy(workload) for workload in ("batch", "continuous")]
    reservations = emr_admission_repository.list_reservations(db, limit=limit)
    return {
        "enabled": admission_enabled(),
        "queueDiscipline": "emr-native-fifo",
        "policies": [policy_dict(policy) for policy in policies],
        "reservations": [reservation_to_dict(item) for item in reservations],
        "usage": [capacity_usage(policy, reservations) for policy in policies],
    }


def reservation_to_dict(reservation: EmrAdmissionReservationModel | None) -> dict[str, Any] | None:
    if reservation is None:
        return None
    return {
        "reservationId": reservation.reservation_id,
        "workload": reservation.workload,
        "applicationId": reservation.application_id,
        "jobId": reservation.job_id,
        "runReference": reservation.run_reference,
        "actorKey": reservation.actor_key,
        "projectKey": reservation.project_key,
        "status": reservation.status,
        "priority": reservation.priority,
        "requestedVcpu": reservation.requested_vcpu,
        "requestedMemoryGb": reservation.requested_memory_gb,
        "requestedDiskGb": reservation.requested_disk_gb,
        "estimatedCostUsdPerHour": reservation.estimated_cost_usd_per_hour,
        "decisionReason": reservation.decision_reason,
        "runtimeJobId": reservation.runtime_job_id,
        "leaseExpiresAt": iso_datetime(reservation.lease_expires_at),
        "queuedAt": iso_datetime(reservation.queued_at),
        "admittedAt": iso_datetime(reservation.admitted_at),
        "submittedAt": iso_datetime(reservation.submitted_at),
        "startedAt": iso_datetime(reservation.started_at),
        "endedAt": iso_datetime(reservation.ended_at),
        "resourceSnapshot": reservation.resource_snapshot or {},
        "createdAt": iso_datetime(reservation.created_at),
        "updatedAt": iso_datetime(reservation.updated_at),
    }


def actor_key(actor: ActorContext | None, job: ETLJobModel) -> str:
    if actor is not None:
        return str(actor.id or actor.email or actor.name or "unknown")
    return str(getattr(job, "created_by", None) or getattr(job, "owner", None) or "unknown")


def assert_request_fits_policy(resources: AdmissionResources, policy: AdmissionPolicy) -> None:
    violations = resource_violations(resources, policy.max_vcpu, policy.max_memory_gb, policy.max_disk_gb)
    if violations:
        raise admission_error(
            f"EMR Job resource request exceeds the application policy: {'; '.join(violations)}.",
            "EMR_ADMISSION_RESOURCE_LIMIT_EXCEEDED",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            {"requested": resources_dict(resources), "policy": policy_dict(policy)},
        )


def assert_quota(
    quota_kind: str,
    quota_key: str,
    reservations: list[EmrAdmissionReservationModel],
    resources: AdmissionResources,
    policy: AdmissionPolicy,
) -> None:
    if quota_kind == "actor":
        current = [item for item in reservations if item.actor_key == quota_key]
        maximums = (
            policy.actor_max_concurrent_runs,
            policy.actor_max_vcpu,
            policy.actor_max_memory_gb,
            policy.actor_max_disk_gb,
        )
    else:
        current = [item for item in reservations if item.project_key == quota_key]
        maximums = (
            policy.project_max_concurrent_runs,
            policy.project_max_vcpu,
            policy.project_max_memory_gb,
            policy.project_max_disk_gb,
        )
    violations = []
    if len(current) >= maximums[0]:
        violations.append(f"concurrent reservations {len(current) + 1}>{maximums[0]}")
    aggregate = AdmissionResources(
        vcpu=sum(item.requested_vcpu for item in current) + resources.vcpu,
        memory_gb=sum(item.requested_memory_gb for item in current) + resources.memory_gb,
        disk_gb=sum(item.requested_disk_gb for item in current) + resources.disk_gb,
        max_executors=resources.max_executors,
    )
    violations.extend(resource_violations(aggregate, maximums[1], maximums[2], maximums[3]))
    if violations:
        raise admission_error(
            f"EMR {quota_kind} quota rejected the Job: {'; '.join(violations)}.",
            "EMR_ADMISSION_QUOTA_EXCEEDED",
            status.HTTP_429_TOO_MANY_REQUESTS,
            {"quotaKind": quota_kind, "quotaKey": quota_key, "violations": violations},
        )


def capacity_usage(policy: AdmissionPolicy, reservations: list[EmrAdmissionReservationModel]) -> dict[str, Any]:
    scoped = [
        item for item in reservations
        if item.application_id == policy.application_id
        and item.workload == policy.workload
        and item.status in emr_admission_repository.NON_TERMINAL_STATUSES
    ]
    active = [item for item in scoped if item.status in emr_admission_repository.ACTIVE_SLOT_STATUSES]
    return {
        "workload": policy.workload,
        "applicationId": policy.application_id,
        "activeRuns": len(active),
        "queuedRuns": sum(item.status == "queued" for item in scoped),
        "reservedVcpu": sum(item.requested_vcpu for item in active),
        "reservedMemoryGb": sum(item.requested_memory_gb for item in active),
        "reservedDiskGb": sum(item.requested_disk_gb for item in active),
        "maxConcurrentRuns": policy.max_concurrent_runs,
        "maxQueuedRuns": policy.max_queued_runs,
        "maxVcpu": policy.max_vcpu,
        "maxMemoryGb": policy.max_memory_gb,
        "maxDiskGb": policy.max_disk_gb,
    }


def policy_dict(policy: AdmissionPolicy) -> dict[str, Any]:
    value = asdict(policy)
    return {
        "enabled": value["enabled"],
        "workload": value["workload"],
        "applicationId": value["application_id"],
        "projectKey": value["project_key"],
        "maxConcurrentRuns": value["max_concurrent_runs"],
        "maxQueuedRuns": value["max_queued_runs"],
        "queueTimeoutMinutes": value["queue_timeout_minutes"],
        "maxIdleMinutes": value["max_idle_minutes"],
        "requireJobCostAllocation": value["require_job_cost_allocation"],
        "maxVcpu": value["max_vcpu"],
        "maxMemoryGb": value["max_memory_gb"],
        "maxDiskGb": value["max_disk_gb"],
        "actorMaxConcurrentRuns": value["actor_max_concurrent_runs"],
        "projectMaxConcurrentRuns": value["project_max_concurrent_runs"],
        "priority": value["priority"],
    }


def resources_dict(resources: AdmissionResources) -> dict[str, Any]:
    return {
        "vcpu": resources.vcpu,
        "memoryGb": resources.memory_gb,
        "diskGb": resources.disk_gb,
        "maxExecutors": resources.max_executors,
    }


def resource_violations(resources: AdmissionResources, max_vcpu: float, max_memory: float, max_disk: float) -> list[str]:
    violations = []
    if resources.vcpu > max_vcpu:
        violations.append(f"vCPU {resources.vcpu:g}>{max_vcpu:g}")
    if resources.memory_gb > max_memory:
        violations.append(f"memoryGB {resources.memory_gb:g}>{max_memory:g}")
    if resources.disk_gb > max_disk:
        violations.append(f"diskGB {resources.disk_gb:g}>{max_disk:g}")
    return violations


def cost_rate_snapshot(environment: Mapping[str, str], workload: str) -> dict[str, float]:
    prefix = f"ASKLAKE_EMR_SERVERLESS_{workload.upper()}"
    return {
        "vcpuHour": bounded_number(environment.get(f"{prefix}_VCPU_HOUR_USD") or environment.get("ASKLAKE_EMR_SERVERLESS_VCPU_HOUR_USD"), 0, 0, 1000),
        "memoryGbHour": bounded_number(environment.get(f"{prefix}_MEMORY_GB_HOUR_USD") or environment.get("ASKLAKE_EMR_SERVERLESS_MEMORY_GB_HOUR_USD"), 0, 0, 1000),
        "diskGbHour": bounded_number(environment.get(f"{prefix}_DISK_GB_HOUR_USD") or environment.get("ASKLAKE_EMR_SERVERLESS_DISK_GB_HOUR_USD"), 0, 0, 1000),
    }


def estimated_hourly_cost(resources: AdmissionResources, rates: dict[str, float]) -> float | None:
    if not any(rates.values()):
        return None
    return round(
        resources.vcpu * rates["vcpuHour"]
        + resources.memory_gb * rates["memoryGbHour"]
        + resources.disk_gb * rates["diskGbHour"],
        6,
    )


def scoped_emr_value(environment: Mapping[str, str], workload: str, suffix: str) -> str:
    scoped = environment.get(f"ASKLAKE_EMR_SERVERLESS_CONTINUOUS_{suffix}") if workload == "continuous" else None
    return str(scoped or environment.get(f"ASKLAKE_EMR_SERVERLESS_{suffix}") or "").strip()


def stable_reservation_id(job_id: str, workload: str, reference: str) -> str:
    digest = hashlib.sha256(f"{workload}:{job_id}:{reference}".encode("utf-8")).hexdigest()[:24]
    return f"emr-admission-{digest}"


def spark_memory_gb(value: str) -> float:
    match = re.fullmatch(r"([1-9][0-9]*)([gGmM])", str(value or "").strip())
    if not match:
        raise ValueError(f"Invalid Spark memory value: {value or '(empty)'}")
    amount = float(match.group(1))
    return amount / 1024 if match.group(2).lower() == "m" else amount


def bounded_integer(value: Any, default: int, minimum: int, maximum: int) -> int:
    parsed = default if value is None or str(value).strip() == "" else int(value)
    if parsed < minimum or parsed > maximum:
        raise ValueError(f"Expected integer between {minimum} and {maximum}")
    return parsed


def bounded_number(value: Any, default: float, minimum: float, maximum: float) -> float:
    parsed = default if value is None or str(value).strip() == "" else float(value)
    if not math.isfinite(parsed) or parsed < minimum or parsed > maximum:
        raise ValueError(f"Expected number between {minimum} and {maximum}")
    return parsed


def environment_flag(value: Any, default: bool) -> bool:
    if value is None or str(value).strip() == "":
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def round_up(value: float, digits: int) -> float:
    factor = 10 ** digits
    return math.ceil(value * factor - 1e-9) / factor


def first_text(*values: Any) -> str | None:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return None


def aware_datetime(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def iso_datetime(value: datetime | None) -> str | None:
    aware = aware_datetime(value)
    return aware.isoformat().replace("+00:00", "Z") if aware else None


def admission_error(code_message: str, code: str, status_code: int, details: dict[str, Any] | None = None) -> ApiError:
    return ApiError(code, code_message, status_code, details)
