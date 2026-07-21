from __future__ import annotations

import hashlib
import json
import math
import os
from typing import Any, Mapping, Sequence

from app.domain.spark_resource_history import (
    DEFAULT_HISTORY_LIMIT,
    DEFAULT_SCALING_EXPONENT,
    build_history_candidate_evaluations,
    select_history_candidate,
    unavailable_candidate_evaluations,
)


SPARK_RESOURCE_PLAN_POLICY_VERSION = 3
SPARK_RESOURCE_PLAN_SUPPORTED_POLICY_VERSIONS = frozenset({1, 2, 3})
SPARK_RESOURCE_PLANNER_MODES = frozenset({"off", "shadow", "enforce"})
SPARK_RESOURCE_POLICY_NAME = "history-sla-cost-v1"
LEGACY_BALANCED_POLICY_NAME = "balanced-v1"
SPARK_RESOURCE_POLICY_TARGET_COMPLETION_SECONDS = 30 * 60
SPARK_RESOURCE_COST_PROXY = "executor_seconds"
SPARK_RESOURCE_SLA_METRIC = "spark_duration_ms"
DEFAULT_TARGET_PARTITION_BYTES = 128 * 1024 * 1024
DEFAULT_TARGET_PARTITIONS_PER_EXECUTOR = 384
DEFAULT_MIN_EXECUTORS = 1
DEFAULT_MAX_EXECUTORS = 4
SUPPORTED_EXECUTOR_TIERS = (1, 2, 4)
MAX_SUPPORTED_EXECUTORS = SUPPORTED_EXECUTOR_TIERS[-1]
STANDARD_EXECUTOR_PROFILE = {
    "executorProfileName": "standard-v1",
    "executorCores": 2,
    "executorCpuRequest": "2",
    "executorCpuLimit": "3",
    "executorMemory": "4g",
    "executorMemoryOverhead": "1g",
}


def spark_resource_planner_mode(environment: Mapping[str, str] | None = None) -> str:
    values = environment if environment is not None else os.environ
    mode = str(values.get("ASKLAKE_SPARK_RESOURCE_PLANNER_MODE") or "off").strip().casefold()
    return mode if mode in SPARK_RESOURCE_PLANNER_MODES else "off"


def build_spark_resource_plan(
    *,
    input_bytes: int | None,
    input_file_count: int | None,
    input_size_source: str,
    baseline_executors: int,
    historical_observations: Sequence[Mapping[str, Any]] = (),
    environment: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    values = environment if environment is not None else os.environ
    mode = spark_resource_planner_mode(values)
    configuration = _balanced_v1_configuration(values, baseline_executors)
    baseline = configuration["baselineExecutors"]
    target_partition_bytes = configuration["targetPartitionBytes"]
    target_partitions_per_executor = configuration["targetPartitionsPerExecutor"]
    minimum_executors = configuration["minExecutors"]
    maximum_executors = configuration["maxExecutors"]
    executor_candidates = configuration["executorCandidates"]
    executor_profile = configuration["executorProfile"]
    profile_supported = executor_profile == STANDARD_EXECUTOR_PROFILE
    normalized_bytes = _optional_non_negative_int(input_bytes)
    normalized_file_count = _optional_non_negative_int(input_file_count)

    bounded_history = list(historical_observations[:DEFAULT_HISTORY_LIMIT])
    history_evidence_count = len(bounded_history)
    history_run_ids = [str(item.get("runId") or "").strip() for item in bounded_history]
    decision = _calculate_resource_decision(
        normalized_bytes=normalized_bytes,
        input_size_source=input_size_source,
        baseline=baseline,
        target_partition_bytes=target_partition_bytes,
        target_partitions_per_executor=target_partitions_per_executor,
        minimum_executors=minimum_executors,
        maximum_executors=maximum_executors,
        executor_candidates=executor_candidates,
        profile_supported=profile_supported,
        historical_observations=bounded_history,
    )

    applied_executors = (
        decision["recommendedExecutors"]
        if mode == "enforce" and decision["decisionStatus"] == "planned"
        else baseline
    )
    plan: dict[str, Any] = {
        "policyVersion": SPARK_RESOURCE_PLAN_POLICY_VERSION,
        "policyName": SPARK_RESOURCE_POLICY_NAME,
        "policyTargetCompletionSeconds": SPARK_RESOURCE_POLICY_TARGET_COMPLETION_SECONDS,
        "mode": mode,
        "inputBytes": normalized_bytes,
        "inputFileCount": normalized_file_count,
        "targetPartitionBytes": target_partition_bytes,
        "targetPartitionsPerExecutor": target_partitions_per_executor,
        "executorCandidates": executor_candidates,
        **executor_profile,
        **decision,
        "baselineExecutors": baseline,
        "appliedExecutors": applied_executors,
        "minExecutors": minimum_executors,
        "maxExecutors": maximum_executors,
        "historyEvidenceCount": history_evidence_count,
        "historyRunIds": history_run_ids,
        "costProxy": SPARK_RESOURCE_COST_PROXY,
        "slaMetric": SPARK_RESOURCE_SLA_METRIC,
        "modelScalingExponent": DEFAULT_SCALING_EXPONENT,
    }
    plan["planHash"] = spark_resource_plan_hash(plan)
    return plan


def _calculate_resource_decision(
    *,
    normalized_bytes: int | None,
    input_size_source: str,
    baseline: int,
    target_partition_bytes: int,
    target_partitions_per_executor: int,
    minimum_executors: int,
    maximum_executors: int,
    executor_candidates: list[int],
    profile_supported: bool,
    historical_observations: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    unavailable = unavailable_candidate_evaluations(executor_candidates)
    if normalized_bytes is None:
        return {
            "decisionStatus": "fallback",
            "decisionBasis": "fallback",
            "inputSizeSource": "unavailable",
            "estimatedPartitions": None,
            "calculatedExecutors": minimum_executors,
            "recommendedExecutors": baseline,
            "historyComparableCount": 0,
            "candidateEvaluations": unavailable,
            "reason": "input_size_unavailable",
        }
    estimated_partitions = max(1, math.ceil(normalized_bytes / target_partition_bytes))
    calculated_executors = max(1, math.ceil(estimated_partitions / target_partitions_per_executor))
    normalized_source = str(input_size_source or "unknown").strip() or "unknown"
    if not profile_supported:
        return {
            "decisionStatus": "fallback",
            "decisionBasis": "fallback",
            "inputSizeSource": normalized_source,
            "estimatedPartitions": estimated_partitions,
            "calculatedExecutors": calculated_executors,
            "recommendedExecutors": baseline,
            "historyComparableCount": 0,
            "candidateEvaluations": unavailable,
            "reason": "executor_profile_unsupported",
        }
    seed = next((tier for tier in executor_candidates if tier >= calculated_executors), executor_candidates[-1])
    seed_reason = (
        "capped_by_max_executor_tier" if calculated_executors > maximum_executors
        else "raised_to_min_executor_tier" if calculated_executors < minimum_executors
        else "rounded_to_supported_executor_tier" if calculated_executors not in executor_candidates
        else "balanced_partition_budget"
    )
    evaluations, comparable_count = (unavailable, 0)
    if normalized_bytes > 0:
        evaluations, comparable_count = build_history_candidate_evaluations(
            input_bytes=normalized_bytes,
            observations=historical_observations,
            executor_candidates=executor_candidates,
            target_completion_seconds=SPARK_RESOURCE_POLICY_TARGET_COMPLETION_SECONDS,
        )
    recommendation, history_reason = select_history_candidate(evaluations)
    return {
        "decisionStatus": "planned",
        "decisionBasis": "history_sla_cost" if recommendation is not None else "size_seed",
        "inputSizeSource": normalized_source,
        "estimatedPartitions": estimated_partitions,
        "calculatedExecutors": calculated_executors,
        "recommendedExecutors": recommendation if recommendation is not None else seed,
        "historyComparableCount": comparable_count,
        "candidateEvaluations": evaluations,
        "reason": str(history_reason) if history_reason is not None else seed_reason,
    }


def normalize_spark_resource_plan(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Spark Resource Plan must be an object")
    normalized = dict(value)
    policy_version = normalized.get("policyVersion")
    if policy_version not in SPARK_RESOURCE_PLAN_SUPPORTED_POLICY_VERSIONS:
        raise ValueError("Spark Resource Plan policyVersion is unsupported")
    if normalized.get("mode") not in SPARK_RESOURCE_PLANNER_MODES:
        raise ValueError("Spark Resource Plan mode is invalid")
    for key in (
        "calculatedExecutors",
        "recommendedExecutors",
        "baselineExecutors",
        "appliedExecutors",
        "minExecutors",
        "maxExecutors",
        "targetPartitionBytes",
        "targetPartitionsPerExecutor",
    ):
        if isinstance(normalized.get(key), bool) or not isinstance(normalized.get(key), int) or normalized[key] < 1:
            raise ValueError(f"Spark Resource Plan {key} is invalid")
    for key in ("inputBytes", "inputFileCount", "estimatedPartitions"):
        item = normalized.get(key)
        if item is not None and (isinstance(item, bool) or not isinstance(item, int) or item < 0):
            raise ValueError(f"Spark Resource Plan {key} is invalid")
    if policy_version == 2:
        _validate_v2_spark_resource_plan(normalized)
    elif policy_version == SPARK_RESOURCE_PLAN_POLICY_VERSION:
        _validate_v3_spark_resource_plan(normalized)
    expected_hash = spark_resource_plan_hash(normalized)
    if str(normalized.get("planHash") or "") != expected_hash:
        raise ValueError("Spark Resource Plan hash does not match its canonical payload")
    return normalized


def spark_resource_plan_hash(plan: Mapping[str, Any]) -> str:
    canonical = {key: value for key, value in plan.items() if key != "planHash"}
    payload = json.dumps(canonical, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _validate_v2_spark_resource_plan(plan: Mapping[str, Any]) -> None:
    if plan.get("policyName") != LEGACY_BALANCED_POLICY_NAME:
        raise ValueError("Spark Resource Plan policyName is invalid")
    if plan.get("policyTargetCompletionSeconds") != SPARK_RESOURCE_POLICY_TARGET_COMPLETION_SECONDS:
        raise ValueError("Spark Resource Plan policy target is invalid")
    if plan.get("decisionStatus") not in {"planned", "fallback"}:
        raise ValueError("Spark Resource Plan decisionStatus is invalid")
    if plan.get("targetPartitionBytes") != DEFAULT_TARGET_PARTITION_BYTES:
        raise ValueError("Spark Resource Plan targetPartitionBytes is invalid")
    if plan.get("targetPartitionsPerExecutor") != DEFAULT_TARGET_PARTITIONS_PER_EXECUTOR:
        raise ValueError("Spark Resource Plan targetPartitionsPerExecutor is invalid")
    candidates = plan.get("executorCandidates")
    if candidates != list(SUPPORTED_EXECUTOR_TIERS):
        raise ValueError("Spark Resource Plan executorCandidates are invalid")
    for key in (
        "executorProfileName",
        "executorCpuRequest",
        "executorCpuLimit",
        "executorMemory",
        "executorMemoryOverhead",
    ):
        if not isinstance(plan.get(key), str) or not str(plan[key]).strip():
            raise ValueError(f"Spark Resource Plan {key} is invalid")
    if (
        isinstance(plan.get("executorCores"), bool)
        or not isinstance(plan.get("executorCores"), int)
        or plan["executorCores"] < 1
    ):
        raise ValueError("Spark Resource Plan executorCores is invalid")
    if (
        plan.get("minExecutors") != DEFAULT_MIN_EXECUTORS
        or plan.get("maxExecutors") != DEFAULT_MAX_EXECUTORS
    ):
        raise ValueError("Spark Resource Plan executor bounds are invalid")
    if any(
        plan.get(key) > MAX_SUPPORTED_EXECUTORS
        for key in ("recommendedExecutors", "baselineExecutors", "appliedExecutors")
    ):
        raise ValueError("Spark Resource Plan executor count exceeds the V1 maximum")
    if plan.get("decisionStatus") == "planned":
        if plan.get("executorProfileName") != STANDARD_EXECUTOR_PROFILE["executorProfileName"]:
            raise ValueError("Planned Spark Resource Plan must use the standard executor profile")
        if any(plan.get(key) != value for key, value in STANDARD_EXECUTOR_PROFILE.items()):
            raise ValueError("Planned Spark Resource Plan executor profile is invalid")
        if plan.get("recommendedExecutors") not in candidates:
            raise ValueError("Spark Resource Plan recommendation is outside executorCandidates")
    else:
        if plan.get("recommendedExecutors") != plan.get("baselineExecutors"):
            raise ValueError("Fallback Spark Resource Plan must preserve its baseline recommendation")
    expected_applied = (
        plan["recommendedExecutors"]
        if plan.get("mode") == "enforce" and plan.get("decisionStatus") == "planned"
        else plan["baselineExecutors"]
    )
    if plan.get("appliedExecutors") != expected_applied:
        raise ValueError("Spark Resource Plan appliedExecutors violates its mode")


def _validate_v3_spark_resource_plan(plan: Mapping[str, Any]) -> None:
    if plan.get("policyName") != SPARK_RESOURCE_POLICY_NAME:
        raise ValueError("Spark Resource Plan policyName is invalid")
    if plan.get("policyTargetCompletionSeconds") != SPARK_RESOURCE_POLICY_TARGET_COMPLETION_SECONDS:
        raise ValueError("Spark Resource Plan policy target is invalid")
    if plan.get("decisionStatus") not in {"planned", "fallback"}:
        raise ValueError("Spark Resource Plan decisionStatus is invalid")
    if plan.get("decisionBasis") not in {"history_sla_cost", "size_seed", "fallback"}:
        raise ValueError("Spark Resource Plan decisionBasis is invalid")
    if plan.get("costProxy") != SPARK_RESOURCE_COST_PROXY:
        raise ValueError("Spark Resource Plan costProxy is invalid")
    if plan.get("slaMetric") != SPARK_RESOURCE_SLA_METRIC:
        raise ValueError("Spark Resource Plan slaMetric is invalid")
    if plan.get("modelScalingExponent") != DEFAULT_SCALING_EXPONENT:
        raise ValueError("Spark Resource Plan scaling exponent is invalid")
    if plan.get("targetPartitionBytes") != DEFAULT_TARGET_PARTITION_BYTES:
        raise ValueError("Spark Resource Plan targetPartitionBytes is invalid")
    if plan.get("targetPartitionsPerExecutor") != DEFAULT_TARGET_PARTITIONS_PER_EXECUTOR:
        raise ValueError("Spark Resource Plan targetPartitionsPerExecutor is invalid")
    candidates = plan.get("executorCandidates")
    if candidates != list(SUPPORTED_EXECUTOR_TIERS):
        raise ValueError("Spark Resource Plan executorCandidates are invalid")
    if (
        plan.get("minExecutors") != DEFAULT_MIN_EXECUTORS
        or plan.get("maxExecutors") != DEFAULT_MAX_EXECUTORS
    ):
        raise ValueError("Spark Resource Plan executor bounds are invalid")
    for key in ("historyEvidenceCount", "historyComparableCount"):
        if (
            isinstance(plan.get(key), bool)
            or not isinstance(plan.get(key), int)
            or plan[key] < 0
            or plan[key] > DEFAULT_HISTORY_LIMIT
        ):
            raise ValueError(f"Spark Resource Plan {key} is invalid")
    if plan["historyComparableCount"] > plan["historyEvidenceCount"]:
        raise ValueError("Spark Resource Plan comparable history exceeds its evidence")
    history_run_ids = plan.get("historyRunIds")
    if (
        not isinstance(history_run_ids, list)
        or len(history_run_ids) != plan["historyEvidenceCount"]
        or len(set(history_run_ids)) != len(history_run_ids)
        or any(not isinstance(run_id, str) or not run_id.strip() for run_id in history_run_ids)
    ):
        raise ValueError("Spark Resource Plan historyRunIds are invalid")
    _validate_executor_profile(plan)
    _validate_candidate_evaluations(plan, candidates)
    if plan.get("decisionStatus") == "planned":
        if plan.get("executorProfileName") != STANDARD_EXECUTOR_PROFILE["executorProfileName"]:
            raise ValueError("Planned Spark Resource Plan must use the standard executor profile")
        if plan.get("recommendedExecutors") not in candidates:
            raise ValueError("Spark Resource Plan recommendation is outside executorCandidates")
        if plan.get("decisionBasis") == "history_sla_cost":
            selected, _ = select_history_candidate(plan["candidateEvaluations"])
            if selected != plan.get("recommendedExecutors"):
                raise ValueError("Spark Resource Plan history recommendation is inconsistent")
            if plan.get("historyComparableCount", 0) < 1:
                raise ValueError("Spark Resource Plan history decision lacks comparable evidence")
        elif plan.get("decisionBasis") != "size_seed":
            raise ValueError("Planned Spark Resource Plan decisionBasis is invalid")
    else:
        if plan.get("recommendedExecutors") != plan.get("baselineExecutors"):
            raise ValueError("Fallback Spark Resource Plan must preserve its baseline recommendation")
        if plan.get("decisionBasis") != "fallback":
            raise ValueError("Fallback Spark Resource Plan decisionBasis is invalid")
    expected_applied = (
        plan["recommendedExecutors"]
        if plan.get("mode") == "enforce" and plan.get("decisionStatus") == "planned"
        else plan["baselineExecutors"]
    )
    if plan.get("appliedExecutors") != expected_applied:
        raise ValueError("Spark Resource Plan appliedExecutors violates its mode")


def _validate_executor_profile(plan: Mapping[str, Any]) -> None:
    for key in (
        "executorProfileName",
        "executorCpuRequest",
        "executorCpuLimit",
        "executorMemory",
        "executorMemoryOverhead",
    ):
        if not isinstance(plan.get(key), str) or not str(plan[key]).strip():
            raise ValueError(f"Spark Resource Plan {key} is invalid")
    if (
        isinstance(plan.get("executorCores"), bool)
        or not isinstance(plan.get("executorCores"), int)
        or plan["executorCores"] < 1
    ):
        raise ValueError("Spark Resource Plan executorCores is invalid")
    if any(
        plan.get(key) > MAX_SUPPORTED_EXECUTORS
        for key in ("recommendedExecutors", "baselineExecutors", "appliedExecutors")
    ):
        raise ValueError("Spark Resource Plan executor count exceeds the V1 maximum")
    if plan.get("decisionStatus") == "planned" and any(
        plan.get(key) != value for key, value in STANDARD_EXECUTOR_PROFILE.items()
    ):
        raise ValueError("Planned Spark Resource Plan executor profile is invalid")


def _validate_candidate_evaluations(
    plan: Mapping[str, Any],
    candidates: list[int],
) -> None:
    evaluations = plan.get("candidateEvaluations")
    if not isinstance(evaluations, list) or len(evaluations) != len(candidates):
        raise ValueError("Spark Resource Plan candidateEvaluations are invalid")
    for candidate, evaluation in zip(candidates, evaluations, strict=True):
        if not isinstance(evaluation, dict) or evaluation.get("executors") != candidate:
            raise ValueError("Spark Resource Plan candidate evaluation executor is invalid")
        if evaluation.get("estimateSource") not in {"measured", "modeled", "unavailable"}:
            raise ValueError("Spark Resource Plan candidate estimateSource is invalid")
        evidence_count = evaluation.get("evidenceCount")
        if isinstance(evidence_count, bool) or not isinstance(evidence_count, int) or evidence_count < 0:
            raise ValueError("Spark Resource Plan candidate evidenceCount is invalid")
        duration = evaluation.get("estimatedDurationMs")
        cost = evaluation.get("estimatedExecutorSeconds")
        meets_target = evaluation.get("meetsTarget")
        if duration is None or cost is None:
            if not (
                duration is None
                and cost is None
                and meets_target is None
                and evidence_count == 0
                and evaluation.get("estimateSource") == "unavailable"
            ):
                raise ValueError("Spark Resource Plan unavailable candidate is invalid")
            continue
        if isinstance(duration, bool) or not isinstance(duration, int) or duration < 1:
            raise ValueError("Spark Resource Plan candidate duration is invalid")
        if isinstance(cost, bool) or not isinstance(cost, (int, float)) or cost <= 0:
            raise ValueError("Spark Resource Plan candidate cost is invalid")
        if meets_target is not (duration <= SPARK_RESOURCE_POLICY_TARGET_COMPLETION_SECONDS * 1000):
            raise ValueError("Spark Resource Plan candidate SLA verdict is invalid")


def _configured_int(
    environment: Mapping[str, str],
    name: str,
    default: int,
    *,
    minimum: int,
) -> int:
    try:
        configured = int(str(environment.get(name) or default).strip())
    except (TypeError, ValueError):
        configured = default
    return max(minimum, configured)


def _balanced_v1_configuration(
    environment: Mapping[str, str],
    baseline_executors: int,
) -> dict[str, Any]:
    baseline = _positive_int(baseline_executors, DEFAULT_MIN_EXECUTORS)
    if baseline > MAX_SUPPORTED_EXECUTORS:
        raise ValueError(
            f"Spark Resource Planner baseline must be at most {MAX_SUPPORTED_EXECUTORS}"
        )
    return {
        "baselineExecutors": baseline,
        "targetPartitionBytes": _configured_policy_int(
            environment,
            "ASKLAKE_SPARK_RESOURCE_TARGET_PARTITION_BYTES",
            DEFAULT_TARGET_PARTITION_BYTES,
            minimum=1024 * 1024,
        ),
        "targetPartitionsPerExecutor": _configured_policy_int(
            environment,
            "ASKLAKE_SPARK_RESOURCE_TARGET_PARTITIONS_PER_EXECUTOR",
            DEFAULT_TARGET_PARTITIONS_PER_EXECUTOR,
            minimum=1,
        ),
        "minExecutors": _configured_policy_int(
            environment,
            "ASKLAKE_SPARK_RESOURCE_MIN_EXECUTORS",
            DEFAULT_MIN_EXECUTORS,
            minimum=1,
        ),
        "maxExecutors": _configured_policy_int(
            environment,
            "ASKLAKE_SPARK_RESOURCE_MAX_EXECUTORS",
            DEFAULT_MAX_EXECUTORS,
            minimum=1,
        ),
        "executorCandidates": list(SUPPORTED_EXECUTOR_TIERS),
        "executorProfile": _executor_profile(environment),
    }


def _configured_policy_int(
    environment: Mapping[str, str],
    name: str,
    expected: int,
    *,
    minimum: int,
) -> int:
    try:
        configured = int(str(environment.get(name) or expected).strip())
    except (TypeError, ValueError):
        configured = 0
    if configured < minimum or configured != expected:
        raise ValueError(
            f"{name} must be {expected} for {SPARK_RESOURCE_POLICY_NAME}"
        )
    return configured


def _executor_profile(environment: Mapping[str, str]) -> dict[str, Any]:
    cores = _configured_int(
        environment,
        "ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORES",
        STANDARD_EXECUTOR_PROFILE["executorCores"],
        minimum=1,
    )
    cpu_request = str(
        environment.get("ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_REQUEST")
        or cores
    ).strip()
    cpu_limit = str(
        environment.get("ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_LIMIT")
        or cores
    ).strip()
    memory = str(
        environment.get("ASKLAKE_SPARK_KUBERNETES_EXECUTOR_MEMORY")
        or STANDARD_EXECUTOR_PROFILE["executorMemory"]
    ).strip()
    memory_overhead = str(
        environment.get("ASKLAKE_SPARK_KUBERNETES_EXECUTOR_MEMORY_OVERHEAD")
        or STANDARD_EXECUTOR_PROFILE["executorMemoryOverhead"]
    ).strip()
    profile = {
        "executorProfileName": STANDARD_EXECUTOR_PROFILE["executorProfileName"],
        "executorCores": cores,
        "executorCpuRequest": cpu_request,
        "executorCpuLimit": cpu_limit,
        "executorMemory": memory,
        "executorMemoryOverhead": memory_overhead,
    }
    if profile != STANDARD_EXECUTOR_PROFILE:
        profile["executorProfileName"] = "custom"
    return profile


def _positive_int(value: Any, default: int) -> int:
    if isinstance(value, bool):
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def _optional_non_negative_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None
