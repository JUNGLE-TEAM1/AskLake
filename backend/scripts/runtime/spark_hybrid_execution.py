"""Fail-closed choice between direct source cache and durable Parquet staging."""

from __future__ import annotations

from dataclasses import dataclass
import sys


class DirectCacheInitializationError(RuntimeError):
    failed_stage = "Direct Cache Initialization"


@dataclass(frozen=True, slots=True)
class HybridExecutionDecision:
    use_direct_cache: bool
    reason: str


def hybrid_execution_decision(
    source_bytes: int | None,
    max_bytes: int,
) -> HybridExecutionDecision:
    if max_bytes <= 0:
        return HybridExecutionDecision(False, "disabled")
    if source_bytes is None:
        return HybridExecutionDecision(False, "source_size_unavailable")
    if source_bytes <= 0:
        return HybridExecutionDecision(False, "empty_source")
    if source_bytes > max_bytes:
        return HybridExecutionDecision(False, "above_threshold")
    return HybridExecutionDecision(True, "within_threshold")


def apply_hybrid_execution_manifest(
    spark_resources: dict[str, object],
    decision: HybridExecutionDecision,
    max_bytes: int,
) -> None:
    spark_resources.update({
        "directCacheDecisionReason": decision.reason,
        "directCacheEligible": decision.use_direct_cache,
        "directCacheFailureMode": "fail_run",
        "directCacheFallbackCount": 0,
        "directCacheMaxSourceBytes": max_bytes,
        "executionStrategyPolicy": "max_source_bytes",
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


def initialize_direct_cache(
    frame,
    cached_frames,
    spark_resources,
    storage_level,
    summarize,
):
    try:
        frame = frame.persist(storage_level)
        cached_frames.append(frame)
        spark_resources["cacheStorageLevel"] = "MEMORY_AND_DISK"
        spark_resources["directCacheInitializationStatus"] = "started"
        spark_resources["materializationBytes"] = None
        spark_resources["materializationCleanupStatus"] = "not_required"
        spark_resources["materializationFileCount"] = 0
        spark_resources["materializationMode"] = "direct_source_cache"
        spark_resources["materializationSizeStatus"] = "not_applicable"
        spark_resources["outputFrameCacheMode"] = "direct_source_memory_and_disk"
        input_rows, null_required = summarize(frame)
        spark_resources["directCacheInitializationStatus"] = "success"
        return frame, input_rows, null_required
    except Exception as cache_error:
        release_cached_frame(frame, cached_frames)
        spark_resources["cacheStorageLevel"] = "NONE"
        spark_resources["directCacheInitializationStatus"] = "failed"
        spark_resources["directCacheFailureReason"] = "cache_initialization_failed"
        spark_resources["outputFrameCacheMode"] = "direct_source_cache_failed"
        print(
            f"Spark direct cache initialization failed; refusing a hidden source rescan: {cache_error}",
            file=sys.stderr,
        )
        raise DirectCacheInitializationError(
            "Spark direct cache initialization failed; the Run was stopped before fallback."
        ) from cache_error


def prepare_hybrid_frame(
    source_bytes,
    max_source_bytes,
    source_frame,
    cached_frames,
    spark_resources,
    storage_level,
    summarize,
    materialize,
):
    decision = hybrid_execution_decision(source_bytes, max_source_bytes)
    apply_hybrid_execution_manifest(spark_resources, decision, max_source_bytes)
    if decision.use_direct_cache:
        return initialize_direct_cache(
            source_frame,
            cached_frames,
            spark_resources,
            storage_level,
            summarize,
        )

    spark_resources["materializationMode"] = "run_scoped_parquet_staging"
    spark_resources["outputFrameCacheMode"] = "staged_parquet_reuse"
    staged_frame = materialize(source_frame)
    input_rows, null_required = summarize(staged_frame)
    return staged_frame, input_rows, null_required
