from __future__ import annotations

import hashlib
import json
import math
import os
from typing import Any, Mapping


SPARK_RESOURCE_PLAN_POLICY_VERSION = 2
SPARK_RESOURCE_PLAN_SUPPORTED_POLICY_VERSIONS = frozenset({1, 2})
SPARK_RESOURCE_PLANNER_MODES = frozenset({"off", "shadow", "enforce"})
SPARK_RESOURCE_POLICY_NAME = "balanced-v1"
SPARK_RESOURCE_POLICY_TARGET_COMPLETION_SECONDS = 30 * 60
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

    if normalized_bytes is None:
        estimated_partitions = None
        calculated_executors = minimum_executors
        recommended_executors = baseline
        decision_status = "fallback"
        reason = "input_size_unavailable"
        normalized_source = "unavailable"
    else:
        estimated_partitions = max(1, math.ceil(normalized_bytes / target_partition_bytes))
        calculated_executors = max(1, math.ceil(estimated_partitions / target_partitions_per_executor))
        normalized_source = str(input_size_source or "unknown").strip() or "unknown"
        if not profile_supported:
            recommended_executors = baseline
            decision_status = "fallback"
            reason = "executor_profile_unsupported"
        else:
            recommended_executors = next(
                (
                    tier
                    for tier in executor_candidates
                    if tier >= calculated_executors
                ),
                executor_candidates[-1],
            )
            decision_status = "planned"
            reason = (
                "capped_by_max_executor_tier"
                if calculated_executors > maximum_executors
                else "raised_to_min_executor_tier"
                if calculated_executors < minimum_executors
                else "rounded_to_supported_executor_tier"
                if calculated_executors not in executor_candidates
                else "balanced_partition_budget"
            )

    applied_executors = (
        recommended_executors
        if mode == "enforce" and decision_status == "planned"
        else baseline
    )
    plan: dict[str, Any] = {
        "policyVersion": SPARK_RESOURCE_PLAN_POLICY_VERSION,
        "policyName": SPARK_RESOURCE_POLICY_NAME,
        "policyTargetCompletionSeconds": SPARK_RESOURCE_POLICY_TARGET_COMPLETION_SECONDS,
        "mode": mode,
        "decisionStatus": decision_status,
        "inputBytes": normalized_bytes,
        "inputFileCount": normalized_file_count,
        "inputSizeSource": normalized_source,
        "targetPartitionBytes": target_partition_bytes,
        "targetPartitionsPerExecutor": target_partitions_per_executor,
        "executorCandidates": executor_candidates,
        **executor_profile,
        "estimatedPartitions": estimated_partitions,
        "calculatedExecutors": calculated_executors,
        "recommendedExecutors": recommended_executors,
        "baselineExecutors": baseline,
        "appliedExecutors": applied_executors,
        "minExecutors": minimum_executors,
        "maxExecutors": maximum_executors,
        "reason": reason,
    }
    plan["planHash"] = spark_resource_plan_hash(plan)
    return plan


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
    if policy_version == SPARK_RESOURCE_PLAN_POLICY_VERSION:
        _validate_v2_spark_resource_plan(normalized)
    expected_hash = spark_resource_plan_hash(normalized)
    if str(normalized.get("planHash") or "") != expected_hash:
        raise ValueError("Spark Resource Plan hash does not match its canonical payload")
    return normalized


def spark_resource_plan_hash(plan: Mapping[str, Any]) -> str:
    canonical = {key: value for key, value in plan.items() if key != "planHash"}
    payload = json.dumps(canonical, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _validate_v2_spark_resource_plan(plan: Mapping[str, Any]) -> None:
    if plan.get("policyName") != SPARK_RESOURCE_POLICY_NAME:
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
