from __future__ import annotations

import hashlib
import json
import math
import os
from typing import Any, Mapping


SPARK_RESOURCE_PLAN_POLICY_VERSION = 1
SPARK_RESOURCE_PLANNER_MODES = frozenset({"off", "shadow", "enforce"})
DEFAULT_TARGET_PARTITION_BYTES = 128 * 1024 * 1024
DEFAULT_TARGET_PARTITIONS_PER_EXECUTOR = 96
DEFAULT_MIN_EXECUTORS = 1
DEFAULT_MAX_EXECUTORS = 6
MAX_SUPPORTED_EXECUTORS = 6


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
    baseline = _positive_int(baseline_executors, 1)
    target_partition_bytes = _configured_int(
        values,
        "ASKLAKE_SPARK_RESOURCE_TARGET_PARTITION_BYTES",
        DEFAULT_TARGET_PARTITION_BYTES,
        minimum=1024 * 1024,
    )
    target_partitions_per_executor = _configured_int(
        values,
        "ASKLAKE_SPARK_RESOURCE_TARGET_PARTITIONS_PER_EXECUTOR",
        DEFAULT_TARGET_PARTITIONS_PER_EXECUTOR,
        minimum=1,
    )
    minimum_executors = min(
        MAX_SUPPORTED_EXECUTORS,
        _configured_int(
            values,
            "ASKLAKE_SPARK_RESOURCE_MIN_EXECUTORS",
            DEFAULT_MIN_EXECUTORS,
            minimum=1,
        ),
    )
    maximum_executors = min(
        MAX_SUPPORTED_EXECUTORS,
        _configured_int(
            values,
            "ASKLAKE_SPARK_RESOURCE_MAX_EXECUTORS",
            DEFAULT_MAX_EXECUTORS,
            minimum=minimum_executors,
        ),
    )
    normalized_bytes = _optional_non_negative_int(input_bytes)
    normalized_file_count = _optional_non_negative_int(input_file_count)

    if normalized_bytes is None:
        estimated_partitions = None
        calculated_executors = minimum_executors
        recommended_executors = minimum_executors
        reason = "input_size_unavailable"
        normalized_source = "unavailable"
    else:
        estimated_partitions = max(1, math.ceil(normalized_bytes / target_partition_bytes))
        calculated_executors = max(1, math.ceil(estimated_partitions / target_partitions_per_executor))
        recommended_executors = max(minimum_executors, min(calculated_executors, maximum_executors))
        reason = (
            "capped_by_max_executors"
            if calculated_executors > maximum_executors
            else "raised_to_min_executors"
            if calculated_executors < minimum_executors
            else "within_policy"
        )
        normalized_source = str(input_size_source or "unknown").strip() or "unknown"

    applied_executors = recommended_executors if mode == "enforce" else baseline
    plan: dict[str, Any] = {
        "policyVersion": SPARK_RESOURCE_PLAN_POLICY_VERSION,
        "mode": mode,
        "inputBytes": normalized_bytes,
        "inputFileCount": normalized_file_count,
        "inputSizeSource": normalized_source,
        "targetPartitionBytes": target_partition_bytes,
        "targetPartitionsPerExecutor": target_partitions_per_executor,
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
    if normalized.get("policyVersion") != SPARK_RESOURCE_PLAN_POLICY_VERSION:
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
    expected_hash = spark_resource_plan_hash(normalized)
    if str(normalized.get("planHash") or "") != expected_hash:
        raise ValueError("Spark Resource Plan hash does not match its canonical payload")
    return normalized


def spark_resource_plan_hash(plan: Mapping[str, Any]) -> str:
    canonical = {key: value for key, value in plan.items() if key != "planHash"}
    payload = json.dumps(canonical, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


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
