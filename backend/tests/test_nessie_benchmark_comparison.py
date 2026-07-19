from copy import deepcopy
from pathlib import Path

from app.benchmarks.comparison import compare_campaigns, load_policy
from app.benchmarks.suite import load_suite


ROOT = Path(__file__).parents[1] / "benchmarks/nessie-sql"


def summary(role: str, correctness: float = 1.0) -> dict:
    cases = load_suite(ROOT / "question-suite.v1.json").cases
    return {
        "campaignId": role,
        "suiteVersion": "1.0.0",
        "fixtureVersion": "1.0.0",
        "datasetSnapshotHash": "a" * 64,
        "runtimeProfile": "local",
        "cacheMode": "warm",
        "correctnessRate": correctness,
        "processedBytes": {"p95": 100},
        "wallMs": {"p95": 100},
        "cpuMs": {"p95": 50},
        "peakMemoryBytes": {"p95": 1000},
        "spilledBytes": {"p95": 0},
        "perCase": {
            case.case_id: {
                "runs": 5, "correct": 5,
                "p95ProcessedBytes": 100, "p95WallMs": 100, "p95CpuMs": 50,
                "p95PeakMemoryBytes": 1000, "p95SpilledBytes": 0,
            }
            for case in cases
        },
    }


def test_comparator_passes_compatible_improvement() -> None:
    baseline = summary("baseline", 0.5)
    candidate = summary("candidate", 1.0)
    report = compare_campaigns(baseline, candidate, load_suite(ROOT / "question-suite.v1.json"), load_policy(ROOT / "regression-policy.v1.json"))
    assert report["gate"] == "pass"
    assert report["correctness"]["absoluteDelta"] == 0.5


def test_correctness_regression_fails_even_when_faster() -> None:
    baseline = summary("baseline")
    candidate = summary("candidate", 0.9)
    candidate["wallMs"]["p95"] = 1
    first_case = next(iter(candidate["perCase"].values()))
    first_case["correct"] = 4
    report = compare_campaigns(baseline, candidate, load_suite(ROOT / "question-suite.v1.json"), load_policy(ROOT / "regression-policy.v1.json"))
    assert report["gate"] == "fail"
    assert "overall_correctness_regression" in report["failures"]
    assert any("correctness_regression" in failure for failure in report["failures"])


def test_snapshot_or_cache_drift_blocks_comparison() -> None:
    baseline = summary("baseline")
    candidate = deepcopy(summary("candidate"))
    candidate["datasetSnapshotHash"] = "b" * 64
    candidate["cacheMode"] = "cold"
    report = compare_campaigns(baseline, candidate, load_suite(ROOT / "question-suite.v1.json"), load_policy(ROOT / "regression-policy.v1.json"))
    assert report["gate"] == "blocked"
    assert set(report["reasons"]) == {"cache_mode_mismatch", "dataset_snapshot_mismatch"}


def test_shared_correct_case_scan_regression_fails() -> None:
    baseline = summary("baseline")
    candidate = summary("candidate")
    candidate["perCase"]["monthly_order_count"]["p95ProcessedBytes"] = 106
    report = compare_campaigns(baseline, candidate, load_suite(ROOT / "question-suite.v1.json"), load_policy(ROOT / "regression-policy.v1.json"))
    assert report["gate"] == "fail"
    assert "monthly_order_count:scan_p95_regression" in report["failures"]


def test_small_memory_jitter_uses_absolute_allowance() -> None:
    baseline = summary("baseline")
    candidate = summary("candidate")
    candidate["perCase"]["monthly_order_count"]["p95PeakMemoryBytes"] += 4 * 1024 * 1024
    report = compare_campaigns(
        baseline,
        candidate,
        load_suite(ROOT / "question-suite.v1.json"),
        load_policy(ROOT / "regression-policy.v1.json"),
    )
    assert report["gate"] == "pass"
