from __future__ import annotations

import json
from pathlib import Path
from statistics import median
from typing import Any


def percentile(values: list[int], percentile_value: float) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int((len(ordered) - 1) * percentile_value + 0.999999)))
    return ordered[index]


def summarize_receipts(receipt_dir: Path, campaign_id: str) -> dict[str, Any]:
    receipts = [
        json.loads(path.read_text(encoding="utf-8"))
        for path in sorted(receipt_dir.glob(f"{campaign_id}-*.json"))
    ]
    if not receipts:
        raise ValueError("campaign has no receipts")
    successful = [item for item in receipts if item.get("status") == "succeeded" and item.get("correctness") == "passed"]
    elapsed = [int(item["execution_stats"]["wall_ms"]) for item in successful if item.get("execution_stats", {}).get("wall_ms") is not None]
    processed = [int(item["execution_stats"]["processed_bytes"]) for item in successful if item.get("execution_stats", {}).get("processed_bytes") is not None]
    cpu = [int(item["execution_stats"]["cpu_ms"]) for item in successful if item.get("execution_stats", {}).get("cpu_ms") is not None]
    memory = [int(item["execution_stats"]["peak_memory_bytes"]) for item in successful if item.get("execution_stats", {}).get("peak_memory_bytes") is not None]
    spill = [int(item["execution_stats"]["spilled_bytes"]) for item in successful if item.get("execution_stats", {}).get("spilled_bytes") is not None]
    regenerations = [int(item.get("regeneration_count") or 0) for item in receipts]
    estimate_errors = [
        abs(int(item["estimated_bytes"]) - int(item["execution_stats"]["processed_bytes"])) / max(1, int(item["execution_stats"]["processed_bytes"]))
        for item in successful
        if item.get("estimated_bytes") is not None and item.get("execution_stats", {}).get("processed_bytes") is not None
    ]
    per_case: dict[str, dict[str, Any]] = {}
    for case_id in sorted({str(item["case_id"]) for item in receipts}):
        case_receipts = [item for item in receipts if item["case_id"] == case_id]
        case_elapsed = [
            int(item["execution_stats"]["wall_ms"])
            for item in case_receipts
            if item.get("correctness") == "passed" and item.get("execution_stats", {}).get("wall_ms") is not None
        ]
        per_case[case_id] = {
            "runs": len(case_receipts),
            "correct": sum(1 for item in case_receipts if item.get("correctness") == "passed"),
            "p50WallMs": int(median(case_elapsed)) if case_elapsed else None,
            "p95WallMs": percentile(case_elapsed, 0.95),
        }
    first = receipts[0]
    return {
        "summaryVersion": "1",
        "campaignId": campaign_id,
        "candidateRole": first["candidate_role"],
        "suiteVersion": first["suite_version"],
        "fixtureVersion": first["fixture_version"],
        "datasetSnapshotHash": first["dataset_snapshot_hash"],
        "runtimeProfile": first["runtime_profile"],
        "cacheModes": sorted({str(item["cache_mode"]) for item in receipts}),
        "provider": first["provider"],
        "model": first["model"],
        "generatorVersion": first["generator_version"],
        "promptVersion": first["prompt_version"],
        "runs": len(receipts),
        "correctnessRate": sum(1 for item in receipts if item.get("correctness") == "passed") / len(receipts),
        "generationValidationSuccessRate": sum(
            1 for item in receipts
            if item.get("validation_result", {}).get("accepted") or (
                item.get("status") == "rejected" and item.get("correctness") == "passed"
            )
        ) / len(receipts),
        "failureRate": sum(1 for item in receipts if item.get("correctness") != "passed") / len(receipts),
        "timeoutRate": sum(1 for item in receipts if item.get("status") == "timed_out") / len(receipts),
        "regenerationRate": sum(1 for count in regenerations if count > 0) / len(receipts),
        "wallMs": {"p50": int(median(elapsed)) if elapsed else None, "p95": percentile(elapsed, 0.95)},
        "processedBytes": {
            "average": int(sum(processed) / len(processed)) if processed else None,
            "p50": int(median(processed)) if processed else None,
            "p95": percentile(processed, 0.95),
        },
        "cpuMs": {"p50": int(median(cpu)) if cpu else None, "p95": percentile(cpu, 0.95)},
        "peakMemoryBytes": {"p50": int(median(memory)) if memory else None, "p95": percentile(memory, 0.95)},
        "spilledBytes": {"p50": int(median(spill)) if spill else None, "p95": percentile(spill, 0.95)},
        "estimateErrorRatioAverage": sum(estimate_errors) / len(estimate_errors) if estimate_errors else None,
        "perCase": per_case,
        "redaction": "aggregated metrics and hashes only; no SQL, endpoint, credential, or result row",
    }
