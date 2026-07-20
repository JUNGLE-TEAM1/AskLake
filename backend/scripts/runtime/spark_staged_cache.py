"""Fail-closed policy for reusing run-scoped Parquet staging in executor cache."""

from __future__ import annotations

from dataclasses import dataclass
import sys


@dataclass(frozen=True, slots=True)
class StagedCacheDecision:
    eligible: bool
    reason: str


def staged_cache_decision(
    materialization_bytes: int | None,
    max_bytes: int,
) -> StagedCacheDecision:
    if max_bytes <= 0:
        return StagedCacheDecision(False, "disabled")
    if materialization_bytes is None:
        return StagedCacheDecision(False, "size_unavailable")
    if materialization_bytes <= 0:
        return StagedCacheDecision(False, "empty_materialization")
    if materialization_bytes > max_bytes:
        return StagedCacheDecision(False, "above_threshold")
    return StagedCacheDecision(True, "within_threshold")


def apply_staged_cache_manifest(
    spark_resources: dict[str, object],
    decision: StagedCacheDecision,
    max_bytes: int,
) -> None:
    spark_resources.update({
        "stagedCacheDecisionReason": decision.reason,
        "stagedCacheEligible": decision.eligible,
        "stagedCacheFallbackCount": 0,
        "stagedCacheMaxBytes": max_bytes,
        "stagedCachePolicy": "max_materialization_bytes",
    })


def release_cached_frame(frame, cached_frames):
    if frame is None:
        return
    for index, cached in enumerate(cached_frames):
        if cached is frame:
            cached_frames.pop(index)
            try:
                cached.unpersist(blocking=False)
            except Exception as exc:
                print(f"Spark cache cleanup failed: {exc}", file=sys.stderr)
            return


def release_all_cached_frames(cached_frames):
    while cached_frames:
        cached = cached_frames.pop()
        try:
            cached.unpersist(blocking=False)
        except Exception as exc:
            print(f"Spark cache cleanup failed: {exc}", file=sys.stderr)


def initialize_staged_frame(
    spark,
    staged_frame,
    materialization_path,
    staged_cache_max_bytes,
    cached_frames,
    spark_resources,
    storage_level,
    summarize,
):
    decision = staged_cache_decision(
        spark_resources.get("materializationBytes"),
        staged_cache_max_bytes,
    )
    apply_staged_cache_manifest(
        spark_resources,
        decision,
        staged_cache_max_bytes,
    )
    if not decision.eligible:
        input_rows, null_required = summarize(staged_frame)
        return staged_frame, input_rows, null_required

    try:
        staged_frame = staged_frame.persist(storage_level)
        cached_frames.append(staged_frame)
        spark_resources["cacheStorageLevel"] = "MEMORY_AND_DISK"
        spark_resources["outputFrameCacheMode"] = "staged_parquet_memory_and_disk"
        input_rows, null_required = summarize(staged_frame)
        return staged_frame, input_rows, null_required
    except Exception as cache_error:
        release_cached_frame(staged_frame, cached_frames)
        spark_resources["cacheStorageLevel"] = "NONE"
        spark_resources["outputFrameCacheMode"] = "staged_parquet_reuse"
        spark_resources["stagedCacheFallbackCount"] = 1
        spark_resources["stagedCacheFallbackReason"] = "cache_initialization_failed"
        print(
            f"Spark staged cache initialization failed; retrying from Parquet staging: {cache_error}",
            file=sys.stderr,
        )
        fallback_frame = spark.read.parquet(materialization_path)
        input_rows, null_required = summarize(fallback_frame)
        return fallback_frame, input_rows, null_required
