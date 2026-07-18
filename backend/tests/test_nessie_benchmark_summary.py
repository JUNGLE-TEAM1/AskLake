import json
from pathlib import Path

from app.benchmarks.summary import percentile, summarize_receipts


def test_percentile_is_nearest_rank_and_bounded() -> None:
    assert percentile([], 0.95) is None
    assert percentile([1, 2, 3, 4, 5], 0.5) == 3
    assert percentile([1, 2, 3, 4, 5], 0.95) == 5


def test_summary_keeps_failures_and_uses_only_correct_success_metrics(tmp_path: Path) -> None:
    base = {
        "candidate_role": "baseline",
        "suite_version": "1",
        "fixture_version": "1",
        "dataset_snapshot_hash": "a" * 64,
        "runtime_profile": "local",
        "cache_mode": "warm",
        "provider": "fixture",
        "model": "fixture",
        "generator_version": "v1",
        "prompt_version": "v1",
        "regeneration_count": 0,
        "estimated_bytes": 100,
        "validation_result": {"accepted": True},
    }
    receipts = [
        {**base, "case_id": "one", "status": "succeeded", "correctness": "passed", "execution_stats": {"wall_ms": 10, "processed_bytes": 80, "cpu_ms": 2, "peak_memory_bytes": 5, "spilled_bytes": 0}},
        {**base, "case_id": "one", "status": "failed", "correctness": "failed", "execution_stats": {"wall_ms": 1, "processed_bytes": 1, "cpu_ms": 1, "peak_memory_bytes": 1, "spilled_bytes": 0}},
    ]
    for index, receipt in enumerate(receipts):
        (tmp_path / f"campaign-one-warm-{index}.json").write_text(json.dumps(receipt))
    summary = summarize_receipts(tmp_path, "campaign")
    assert summary["correctnessRate"] == 0.5
    assert summary["failureRate"] == 0.5
    assert summary["wallMs"] == {"p50": 10, "p95": 10}
