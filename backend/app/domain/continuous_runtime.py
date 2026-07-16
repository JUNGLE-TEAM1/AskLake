"""Canonical state and error contract for Kafka Continuous runtimes.

The production persistence model intentionally remains unchanged in this
refactor step.  The contract is stored inside the existing ``metrics`` JSON so
older jobs, checkpoints, and API clients continue to hydrate without a data
migration.  Application services own commands; worker reports are observations.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Mapping


RUNTIME_CONTRACT_VERSION = "1.0"
RUNTIME_CONTRACT_KEY = "runtimeContract"


class ContinuousDesiredState(StrEnum):
    RUNNING = "running"
    PAUSED = "paused"
    STOPPED = "stopped"


class ContinuousObservedState(StrEnum):
    UNKNOWN = "unknown"
    STARTING = "starting"
    RUNNING = "running"
    STOPPING = "stopping"
    STOPPED = "stopped"
    FAILED = "failed"


class ContinuousPublicStatus(StrEnum):
    STARTING = "starting"
    RUNNING = "running"
    PAUSING = "pausing"
    PAUSED = "paused"
    STOPPING = "stopping"
    STOPPED = "stopped"
    FAILED = "failed"


class ContinuousErrorStage(StrEnum):
    VALIDATION = "validation"
    RUNTIME_STORAGE = "runtime_storage"
    SUBMISSION = "submission"
    EXECUTION = "execution"
    REPORT = "report"
    CHECKPOINT = "checkpoint"
    MATERIALIZATION = "materialization"
    CATALOG = "catalog"
    DASHBOARD_PUBLICATION = "dashboard_publication"
    RECONCILIATION = "reconciliation"


CONTINUOUS_COMMANDS = frozenset({
    "startContinuous",
    "pauseContinuous",
    "resumeContinuous",
    "stopContinuous",
})
ACTIVE_PUBLIC_STATUSES = frozenset({"starting", "running", "pausing", "stopping"})
VALID_PUBLIC_STATUSES = frozenset(status.value for status in ContinuousPublicStatus)


@dataclass(frozen=True, slots=True)
class ContinuousCommandTransition:
    command: str
    current_status: str
    allowed: bool
    desired_state: ContinuousDesiredState
    next_status: ContinuousPublicStatus
    rejection: str | None = None


@dataclass(frozen=True, slots=True)
class ContinuousRuntimeError:
    stage: ContinuousErrorStage
    code: str
    message: str
    retryable: bool
    context: dict[str, Any] | None = None

    def as_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "stage": self.stage.value,
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
        }
        if self.context:
            payload["context"] = dict(self.context)
        return payload


def command_transition(current_status: str, command: str) -> ContinuousCommandTransition:
    """Return the current command policy without performing side effects."""

    normalized = str(current_status or "stopped").strip().casefold()
    if command in {"startContinuous", "resumeContinuous"}:
        allowed = normalized in {"paused", "stopped", "failed"}
        rejection = "already_active" if normalized in ACTIVE_PUBLIC_STATUSES else "invalid_state"
        return ContinuousCommandTransition(
            command=command,
            current_status=normalized,
            allowed=allowed,
            desired_state=ContinuousDesiredState.RUNNING,
            next_status=ContinuousPublicStatus.STARTING,
            rejection=None if allowed else rejection,
        )
    if command == "pauseContinuous":
        allowed = normalized in {"starting", "running"}
        return ContinuousCommandTransition(
            command=command,
            current_status=normalized,
            allowed=allowed,
            desired_state=ContinuousDesiredState.PAUSED,
            next_status=ContinuousPublicStatus.PAUSING,
            rejection=None if allowed else "invalid_state",
        )
    if command == "stopContinuous":
        allowed = normalized in {"starting", "running", "pausing", "paused", "failed"}
        return ContinuousCommandTransition(
            command=command,
            current_status=normalized,
            allowed=allowed,
            desired_state=ContinuousDesiredState.STOPPED,
            next_status=ContinuousPublicStatus.STOPPING,
            rejection=None if allowed else "invalid_state",
        )
    return ContinuousCommandTransition(
        command=command,
        current_status=normalized,
        allowed=False,
        desired_state=desired_state_from_public_status(normalized),
        next_status=public_status_or_stopped(normalized),
        rejection="unsupported_command",
    )


def derive_public_status(
    desired_state: ContinuousDesiredState | str,
    observed_state: ContinuousObservedState | str,
) -> ContinuousPublicStatus:
    """Derive the API status from control-plane intent and worker evidence."""

    desired = ContinuousDesiredState(str(desired_state))
    observed = ContinuousObservedState(str(observed_state))
    if observed is ContinuousObservedState.FAILED:
        return ContinuousPublicStatus.FAILED
    if desired is ContinuousDesiredState.RUNNING:
        if observed is ContinuousObservedState.RUNNING:
            return ContinuousPublicStatus.RUNNING
        return ContinuousPublicStatus.STARTING
    if desired is ContinuousDesiredState.PAUSED:
        if observed is ContinuousObservedState.STOPPED:
            return ContinuousPublicStatus.PAUSED
        return ContinuousPublicStatus.PAUSING
    if observed is ContinuousObservedState.STOPPED:
        return ContinuousPublicStatus.STOPPED
    return ContinuousPublicStatus.STOPPING


def observed_state_from_evidence(
    report_status: str | None,
    container_state: str | None,
) -> ContinuousObservedState:
    report = str(report_status or "").strip().casefold()
    if report == "failed":
        return ContinuousObservedState.FAILED
    if report == "starting":
        return ContinuousObservedState.STARTING
    if report in {"running", "pausing"}:
        return ContinuousObservedState.RUNNING
    if report == "stopping":
        return ContinuousObservedState.STOPPING
    if report in {"paused", "stopped"}:
        return ContinuousObservedState.STOPPED

    container = str(container_state or "").strip().casefold()
    if container in {"running", "healthy"}:
        return ContinuousObservedState.RUNNING
    if container in {"created", "restarting", "starting"}:
        return ContinuousObservedState.STARTING
    if container in {"exited", "missing", "stopped", "dead"}:
        return ContinuousObservedState.STOPPED
    return ContinuousObservedState.UNKNOWN


def desired_state_from_public_status(status: str | ContinuousPublicStatus) -> ContinuousDesiredState:
    normalized = str(status).strip().casefold()
    if normalized in {"starting", "running"}:
        return ContinuousDesiredState.RUNNING
    if normalized in {"pausing", "paused"}:
        return ContinuousDesiredState.PAUSED
    return ContinuousDesiredState.STOPPED


def public_status_or_stopped(status: str) -> ContinuousPublicStatus:
    normalized = str(status or "").strip().casefold()
    if normalized in VALID_PUBLIC_STATUSES:
        return ContinuousPublicStatus(normalized)
    return ContinuousPublicStatus.STOPPED


def runtime_contract_initialized(metrics: Mapping[str, Any] | None) -> bool:
    contract = _contract(metrics)
    return contract.get("version") == RUNTIME_CONTRACT_VERSION and bool(contract.get("desiredState"))


def record_runtime_command(
    metrics: Mapping[str, Any] | None,
    transition: ContinuousCommandTransition,
    *,
    worker_attempt_id: str | None = None,
) -> dict[str, Any]:
    if not transition.allowed:
        raise ValueError(f"Cannot record rejected Continuous command: {transition.rejection}")
    next_metrics = dict(metrics or {})
    previous = _contract(metrics)
    fencing_token = worker_attempt_id or _fencing_token(previous, metrics)
    contract: dict[str, Any] = {
        **previous,
        "version": RUNTIME_CONTRACT_VERSION,
        "desiredState": transition.desired_state.value,
        "observedState": previous.get("observedState")
        or observed_state_from_evidence(transition.current_status, None).value,
        "stateRevision": _nonnegative_int(previous.get("stateRevision")) + 1,
        "lastCommand": transition.command,
        "lastError": None,
    }
    if fencing_token:
        contract["activeWorkerAttemptId"] = fencing_token
        next_metrics["currentWorkerAttemptId"] = fencing_token
    next_metrics[RUNTIME_CONTRACT_KEY] = contract
    return next_metrics


def bind_worker_attempt(metrics: Mapping[str, Any] | None, worker_attempt_id: str | None) -> dict[str, Any]:
    next_metrics = dict(metrics or {})
    if not worker_attempt_id:
        return next_metrics
    contract = {
        **_contract(metrics),
        "version": RUNTIME_CONTRACT_VERSION,
        "activeWorkerAttemptId": worker_attempt_id,
    }
    next_metrics["currentWorkerAttemptId"] = worker_attempt_id
    next_metrics[RUNTIME_CONTRACT_KEY] = contract
    return next_metrics


def record_runtime_observation(
    metrics: Mapping[str, Any] | None,
    observed_state: ContinuousObservedState | str,
    *,
    default_public_status: str,
    worker_attempt_id: str | None = None,
) -> dict[str, Any]:
    next_metrics = dict(metrics or {})
    previous = _contract(metrics)
    observed = ContinuousObservedState(str(observed_state))
    contract: dict[str, Any] = {
        **previous,
        "version": RUNTIME_CONTRACT_VERSION,
        "desiredState": previous.get("desiredState")
        or desired_state_from_public_status(default_public_status).value,
        "observedState": observed.value,
        "stateRevision": _nonnegative_int(previous.get("stateRevision")),
    }
    fencing_token = worker_attempt_id or _fencing_token(previous, metrics)
    if fencing_token:
        contract["activeWorkerAttemptId"] = fencing_token
        next_metrics["currentWorkerAttemptId"] = fencing_token
    next_metrics[RUNTIME_CONTRACT_KEY] = contract
    return next_metrics


def record_runtime_error(
    metrics: Mapping[str, Any] | None,
    *,
    stage: ContinuousErrorStage | str,
    code: str,
    message: str,
    retryable: bool,
    context: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    next_metrics = dict(metrics or {})
    previous = _contract(metrics)
    detail = ContinuousRuntimeError(
        stage=ContinuousErrorStage(str(stage)),
        code=str(code),
        message=str(message),
        retryable=bool(retryable),
        context=dict(context) if context else None,
    )
    next_metrics[RUNTIME_CONTRACT_KEY] = {
        **previous,
        "version": RUNTIME_CONTRACT_VERSION,
        "lastError": detail.as_dict(),
    }
    return next_metrics


def clear_runtime_error(metrics: Mapping[str, Any] | None) -> dict[str, Any]:
    next_metrics = dict(metrics or {})
    previous = _contract(metrics)
    next_metrics[RUNTIME_CONTRACT_KEY] = {
        **previous,
        "version": RUNTIME_CONTRACT_VERSION,
        "lastError": None,
    }
    return next_metrics


def observation_is_current(metrics: Mapping[str, Any] | None, worker_attempt_id: str | None) -> bool:
    """Use the active worker attempt as a fencing token.

    Missing tokens are accepted for compatibility with reports created before
    contract version 1.0.  Once both sides provide a token they must match.
    """

    expected = _fencing_token(_contract(metrics), metrics)
    observed = str(worker_attempt_id or "").strip()
    return not expected or not observed or expected == observed


def runtime_contract_projection(
    metrics: Mapping[str, Any] | None,
    *,
    public_status: str,
    legacy_error: str | None,
) -> dict[str, Any]:
    contract = _contract(metrics)
    desired = _enum_value(
        ContinuousDesiredState,
        contract.get("desiredState"),
        desired_state_from_public_status(public_status).value,
    )
    observed = _enum_value(
        ContinuousObservedState,
        contract.get("observedState"),
        observed_state_from_evidence(public_status, None).value,
    )
    error_detail = _structured_error(contract.get("lastError"))
    if error_detail is None and legacy_error:
        error_detail = classify_legacy_error(legacy_error).as_dict()
    return {
        "desiredState": desired,
        "observedState": observed,
        "stateRevision": _nonnegative_int(contract.get("stateRevision")),
        "fencingToken": _fencing_token(contract, metrics),
        "errorDetail": error_detail,
    }


def classify_legacy_error(message: str) -> ContinuousRuntimeError:
    normalized = str(message or "").strip()
    lowered = normalized.casefold()
    if "dashboard" in lowered:
        stage, code, retryable = ContinuousErrorStage.DASHBOARD_PUBLICATION, "dashboard_publication_failed", True
    elif "catalog" in lowered:
        stage, code, retryable = ContinuousErrorStage.CATALOG, "catalog_materialization_pending", True
    elif "checkpoint" in lowered or "fingerprint" in lowered:
        stage, code, retryable = ContinuousErrorStage.CHECKPOINT, "checkpoint_contract_failed", False
    elif "report" in lowered:
        stage, code, retryable = ContinuousErrorStage.REPORT, "runtime_report_failed", True
    elif any(token in lowered for token in ("permission", "storage", "read-only", "path")):
        stage, code, retryable = ContinuousErrorStage.RUNTIME_STORAGE, "runtime_storage_failed", True
    elif any(token in lowered for token in ("submit", "submission", "start failed", "시작 실패")):
        stage, code, retryable = ContinuousErrorStage.SUBMISSION, "worker_submission_failed", True
    elif any(token in lowered for token in ("materialization", "manifest", "output")):
        stage, code, retryable = ContinuousErrorStage.MATERIALIZATION, "materialization_failed", True
    else:
        stage, code, retryable = ContinuousErrorStage.EXECUTION, "continuous_execution_failed", True
    return ContinuousRuntimeError(stage=stage, code=code, message=normalized, retryable=retryable)


def _contract(metrics: Mapping[str, Any] | None) -> dict[str, Any]:
    if not isinstance(metrics, Mapping):
        return {}
    value = metrics.get(RUNTIME_CONTRACT_KEY)
    return dict(value) if isinstance(value, Mapping) else {}


def _fencing_token(contract: Mapping[str, Any], metrics: Mapping[str, Any] | None) -> str | None:
    candidate = contract.get("activeWorkerAttemptId")
    if not candidate and isinstance(metrics, Mapping):
        candidate = metrics.get("currentWorkerAttemptId")
    normalized = str(candidate or "").strip()
    return normalized or None


def _structured_error(value: object) -> dict[str, Any] | None:
    if not isinstance(value, Mapping):
        return None
    stage = _enum_value(ContinuousErrorStage, value.get("stage"), "")
    code = str(value.get("code") or "").strip()
    message = str(value.get("message") or "").strip()
    if not stage or not code or not message:
        return None
    payload: dict[str, Any] = {
        "stage": stage,
        "code": code,
        "message": message,
        "retryable": bool(value.get("retryable")),
    }
    if isinstance(value.get("context"), Mapping):
        payload["context"] = dict(value["context"])
    return payload


def _enum_value(enum_type: type[StrEnum], value: object, fallback: str) -> str:
    normalized = str(value or "").strip().casefold()
    try:
        return enum_type(normalized).value
    except ValueError:
        return fallback


def _nonnegative_int(value: object) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0
