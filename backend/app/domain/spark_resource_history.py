from __future__ import annotations

import math
from statistics import median
from typing import Any, Iterable, Mapping, Sequence


DEFAULT_HISTORY_LIMIT = 20
DEFAULT_INPUT_RATIO_MIN = 0.5
DEFAULT_INPUT_RATIO_MAX = 2.0
DEFAULT_SCALING_EXPONENT = 0.8


def normalize_spark_resource_history(
    runs: Iterable[Any],
    *,
    current_run_id: str,
    supported_executors: Sequence[int],
    normalize_plan: Any,
    history_limit: int = DEFAULT_HISTORY_LIMIT,
) -> list[dict[str, Any]]:
    """Return bounded, successful, profile-compatible observations.

    Runs are expected newest-first. Invalid or incomplete historical evidence is
    ignored rather than weakening the current Run's execution contract.
    """
    observations: list[dict[str, Any]] = []
    supported = set(supported_executors)
    for run in runs:
        if len(observations) >= history_limit:
            break
        run_id = str(_value(run, "run_id") or "").strip()
        if not run_id or run_id == current_run_id:
            continue
        if str(_value(run, "status") or "").strip().casefold() != "success":
            continue
        task_states = _value(run, "task_states")
        if not isinstance(task_states, Mapping):
            continue
        spark_result = task_states.get("sparkResult")
        execution = task_states.get("sparkExecution")
        if not isinstance(spark_result, Mapping) or not isinstance(execution, Mapping):
            continue
        if str(spark_result.get("status") or "").strip().casefold() != "success":
            continue
        try:
            resource_plan = normalize_plan(execution.get("resourcePlan"))
        except (TypeError, ValueError):
            continue
        if resource_plan.get("executorProfileName") != "standard-v1":
            continue
        spark_resources = spark_result.get("sparkResources")
        if not isinstance(spark_resources, Mapping):
            continue
        executor_instances = _positive_int(spark_resources.get("executorInstances"))
        executor_cores = _positive_int(spark_resources.get("executorCores"))
        input_bytes = _positive_int(spark_result.get("inputBytes"))
        duration_ms = _positive_int(spark_result.get("durationMs"))
        planned_input_bytes = _positive_int(resource_plan.get("inputBytes"))
        if (
            executor_instances not in supported
            or executor_cores != 2
            or input_bytes is None
            or duration_ms is None
            or planned_input_bytes != input_bytes
            or resource_plan.get("appliedExecutors") != executor_instances
        ):
            continue
        observations.append({
            "runId": run_id,
            "inputBytes": input_bytes,
            "durationMs": duration_ms,
            "executorInstances": executor_instances,
            "planHash": resource_plan["planHash"],
        })
    return observations


def build_history_candidate_evaluations(
    *,
    input_bytes: int,
    observations: Sequence[Mapping[str, Any]],
    executor_candidates: Sequence[int],
    target_completion_seconds: int,
    scaling_exponent: float = DEFAULT_SCALING_EXPONENT,
) -> tuple[list[dict[str, Any]], int]:
    comparable = [
        observation
        for observation in observations
        if _is_comparable_input(input_bytes, observation.get("inputBytes"))
    ]
    target_ms = target_completion_seconds * 1000
    evaluations: list[dict[str, Any]] = []
    for candidate in executor_candidates:
        exact = [
            observation
            for observation in comparable
            if observation.get("executorInstances") == candidate
        ]
        evidence = exact or comparable
        estimates = [
            _normalized_duration_ms(
                input_bytes=input_bytes,
                observation=observation,
                candidate_executors=candidate,
                scaling_exponent=0.0 if exact else scaling_exponent,
            )
            for observation in evidence
        ]
        estimates = [estimate for estimate in estimates if estimate is not None]
        if estimates:
            estimated_duration_ms = max(1, round(median(estimates)))
            estimated_executor_seconds = round(
                candidate * estimated_duration_ms / 1000,
                3,
            )
            evaluations.append({
                "executors": candidate,
                "estimatedDurationMs": estimated_duration_ms,
                "estimatedExecutorSeconds": estimated_executor_seconds,
                "meetsTarget": estimated_duration_ms <= target_ms,
                "evidenceCount": len(evidence),
                "estimateSource": "measured" if exact else "modeled",
            })
        else:
            evaluations.append(unavailable_candidate_evaluation(candidate))
    return evaluations, len(comparable)


def unavailable_candidate_evaluations(
    executor_candidates: Sequence[int],
) -> list[dict[str, Any]]:
    return [unavailable_candidate_evaluation(candidate) for candidate in executor_candidates]


def select_history_candidate(
    evaluations: Sequence[Mapping[str, Any]],
) -> tuple[int | None, str | None]:
    available = [
        evaluation
        for evaluation in evaluations
        if evaluation.get("estimatedDurationMs") is not None
        and evaluation.get("estimatedExecutorSeconds") is not None
    ]
    if not available:
        return None, None
    meeting_target = [evaluation for evaluation in available if evaluation.get("meetsTarget") is True]
    if meeting_target:
        selected = min(
            meeting_target,
            key=lambda item: (item["estimatedExecutorSeconds"], item["executors"]),
        )
        return int(selected["executors"]), "history_min_cost_meets_sla"
    selected = max(available, key=lambda item: item["executors"])
    return int(selected["executors"]), "history_no_candidate_meets_sla"


def unavailable_candidate_evaluation(executors: int) -> dict[str, Any]:
    return {
        "executors": executors,
        "estimatedDurationMs": None,
        "estimatedExecutorSeconds": None,
        "meetsTarget": None,
        "evidenceCount": 0,
        "estimateSource": "unavailable",
    }


def _normalized_duration_ms(
    *,
    input_bytes: int,
    observation: Mapping[str, Any],
    candidate_executors: int,
    scaling_exponent: float,
) -> float | None:
    observed_bytes = _positive_int(observation.get("inputBytes"))
    observed_duration_ms = _positive_int(observation.get("durationMs"))
    observed_executors = _positive_int(observation.get("executorInstances"))
    if observed_bytes is None or observed_duration_ms is None or observed_executors is None:
        return None
    size_scaled = observed_duration_ms * input_bytes / observed_bytes
    if scaling_exponent == 0.0:
        return size_scaled
    return size_scaled * math.pow(observed_executors / candidate_executors, scaling_exponent)


def _is_comparable_input(input_bytes: int, observed_bytes: Any) -> bool:
    normalized = _positive_int(observed_bytes)
    if normalized is None:
        return False
    ratio = normalized / input_bytes
    return DEFAULT_INPUT_RATIO_MIN <= ratio <= DEFAULT_INPUT_RATIO_MAX


def _positive_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _value(item: Any, name: str) -> Any:
    if isinstance(item, Mapping):
        return item.get(name)
    return getattr(item, name, None)
