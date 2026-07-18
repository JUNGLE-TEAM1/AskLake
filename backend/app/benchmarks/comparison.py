from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.benchmarks.suite import BenchmarkSuite


class RegressionPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")

    policy_version: str
    minimum_repetitions: int = Field(ge=3)
    maximum_correctness_drop: float = Field(ge=0, le=1)
    maximum_scan_p95_regression_ratio: float = Field(ge=0)
    maximum_wall_p95_regression_ratio: float = Field(ge=0)
    wall_p95_absolute_allowance_ms: int = Field(ge=0)
    maximum_cpu_p95_regression_ratio: float = Field(ge=0)
    cpu_p95_absolute_allowance_ms: int = Field(ge=0)
    maximum_memory_p95_regression_ratio: float = Field(ge=0)
    memory_p95_absolute_allowance_bytes: int = Field(ge=0)
    allow_new_spill: bool


def load_policy(path: Path) -> RegressionPolicy:
    return RegressionPolicy.model_validate_json(path.read_text(encoding="utf-8"))


def compare_campaigns(
    baseline: dict[str, Any],
    candidate: dict[str, Any],
    suite: BenchmarkSuite,
    policy: RegressionPolicy,
) -> dict[str, Any]:
    incompatibilities = compatibility_errors(baseline, candidate)
    baseline_cases = set((baseline.get("perCase") or {}).keys())
    candidate_cases = set((candidate.get("perCase") or {}).keys())
    suite_cases = {case.case_id for case in suite.cases}
    if baseline_cases != candidate_cases or baseline_cases != suite_cases:
        incompatibilities.append("case_set_mismatch")
    if incompatibilities:
        return {
            "reportVersion": "1",
            "comparable": False,
            "gate": "blocked",
            "reasons": sorted(set(incompatibilities)),
            "caseComparisons": [],
        }

    failures: list[str] = []
    baseline_correctness = float(baseline["correctnessRate"])
    candidate_correctness = float(candidate["correctnessRate"])
    correctness_delta = candidate_correctness - baseline_correctness
    if correctness_delta < -policy.maximum_correctness_drop:
        failures.append("overall_correctness_regression")

    case_comparisons: list[dict[str, Any]] = []
    case_types = {case.case_id: case.case_type for case in suite.cases}
    for case_id in sorted(suite_cases):
        item, case_failures = compare_case(
            case_id,
            case_types[case_id],
            baseline["perCase"][case_id],
            candidate["perCase"][case_id],
            policy,
        )
        failures.extend(f"{case_id}:{reason}" for reason in case_failures)
        case_comparisons.append(item)

    minimum_runs = min(int(item["runs"]) for item in case_comparisons)
    if minimum_runs < policy.minimum_repetitions:
        failures.append("insufficient_repetitions")
    return {
        "reportVersion": "1",
        "policyVersion": policy.policy_version,
        "comparable": True,
        "gate": "pass" if not failures else "fail",
        "confidence": "exploratory-small-sample" if minimum_runs < 10 else "standard",
        "baselineCampaignId": baseline["campaignId"],
        "candidateCampaignId": candidate["campaignId"],
        "correctness": {
            "baseline": baseline_correctness,
            "candidate": candidate_correctness,
            "absoluteDelta": correctness_delta,
            "relativeImprovement": None if baseline_correctness == 0 else correctness_delta / baseline_correctness,
        },
        "overallMetrics": {
            "note": "informational only because newly-correct cases change the successful population",
            "scanP95": metric_delta(baseline["processedBytes"]["p95"], candidate["processedBytes"]["p95"]),
            "wallP95": metric_delta(baseline["wallMs"]["p95"], candidate["wallMs"]["p95"]),
            "cpuP95": metric_delta(baseline["cpuMs"]["p95"], candidate["cpuMs"]["p95"]),
            "peakMemoryP95": metric_delta(baseline["peakMemoryBytes"]["p95"], candidate["peakMemoryBytes"]["p95"]),
            "spillP95": metric_delta(baseline["spilledBytes"]["p95"], candidate["spilledBytes"]["p95"]),
        },
        "byType": group_by_type(case_comparisons),
        "caseComparisons": case_comparisons,
        "failures": failures,
        "promotion": "manual_approval_required",
    }


def compare_case(
    case_id: str,
    case_type: str,
    before: dict[str, Any],
    after: dict[str, Any],
    policy: RegressionPolicy,
) -> tuple[dict[str, Any], list[str]]:
    before_passed = int(before["correct"]) == int(before["runs"])
    after_passed = int(after["correct"]) == int(after["runs"])
    failures: list[str] = []
    if before_passed and not after_passed:
        failures.append("correctness_regression")
    if before_passed and after_passed:
        compare_metric(failures, "scan_p95", before.get("p95ProcessedBytes"), after.get("p95ProcessedBytes"), policy.maximum_scan_p95_regression_ratio, 0)
        compare_metric(failures, "wall_p95", before.get("p95WallMs"), after.get("p95WallMs"), policy.maximum_wall_p95_regression_ratio, policy.wall_p95_absolute_allowance_ms)
        compare_metric(failures, "cpu_p95", before.get("p95CpuMs"), after.get("p95CpuMs"), policy.maximum_cpu_p95_regression_ratio, policy.cpu_p95_absolute_allowance_ms)
        compare_metric(failures, "memory_p95", before.get("p95PeakMemoryBytes"), after.get("p95PeakMemoryBytes"), policy.maximum_memory_p95_regression_ratio, policy.memory_p95_absolute_allowance_bytes)
        if not policy.allow_new_spill and int(before.get("p95SpilledBytes") or 0) == 0 and int(after.get("p95SpilledBytes") or 0) > 0:
            failures.append("new_spill")
    item = {
        "caseId": case_id,
        "caseType": case_type,
        "baselineCorrect": int(before["correct"]),
        "candidateCorrect": int(after["correct"]),
        "runs": int(after["runs"]),
        "newlyCorrect": not before_passed and after_passed,
        "metricsComparable": before_passed and after_passed,
        "scanP95": metric_delta(before.get("p95ProcessedBytes"), after.get("p95ProcessedBytes")),
        "wallP95": metric_delta(before.get("p95WallMs"), after.get("p95WallMs")),
        "cpuP95": metric_delta(before.get("p95CpuMs"), after.get("p95CpuMs")),
        "peakMemoryP95": metric_delta(before.get("p95PeakMemoryBytes"), after.get("p95PeakMemoryBytes")),
        "spillP95": metric_delta(before.get("p95SpilledBytes"), after.get("p95SpilledBytes")),
        "failures": failures,
    }
    return item, failures


def group_by_type(case_comparisons: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    result: dict[str, dict[str, int]] = {}
    for item in case_comparisons:
        group = result.setdefault(item["caseType"], {"cases": 0, "baselineCorrect": 0, "candidateCorrect": 0})
        group["cases"] += 1
        group["baselineCorrect"] += int(item["baselineCorrect"] > 0)
        group["candidateCorrect"] += int(item["candidateCorrect"] > 0)
    return result


def compatibility_errors(baseline: dict[str, Any], candidate: dict[str, Any]) -> list[str]:
    mapping = {
        "suiteVersion": "suite_version_mismatch",
        "fixtureVersion": "fixture_version_mismatch",
        "datasetSnapshotHash": "dataset_snapshot_mismatch",
        "runtimeProfile": "runtime_profile_mismatch",
        "cacheMode": "cache_mode_mismatch",
    }
    return [reason for key, reason in mapping.items() if baseline.get(key) != candidate.get(key)]


def compare_metric(failures: list[str], name: str, before: Any, after: Any, ratio: float, absolute: int) -> None:
    if before is None or after is None:
        return
    allowed = max(float(before) * (1 + ratio), float(before) + absolute)
    if float(after) > allowed:
        failures.append(f"{name}_regression")


def metric_delta(before: Any, after: Any) -> dict[str, Any] | None:
    if before is None or after is None:
        return None
    absolute = float(after) - float(before)
    return {
        "baseline": before,
        "candidate": after,
        "absoluteDelta": absolute,
        "improvementRatio": None if float(before) == 0 else -absolute / float(before),
    }


def render_markdown(report: dict[str, Any]) -> str:
    lines = ["# Nessie SQL Benchmark Comparison", ""]
    if not report.get("comparable"):
        lines.extend(("Gate: **BLOCKED**", "", "Reasons: " + ", ".join(report.get("reasons") or [])))
        return "\n".join(lines) + "\n"
    correctness = report["correctness"]
    lines.extend((
        f"Gate: **{str(report['gate']).upper()}**",
        f"Confidence: `{report['confidence']}`",
        "",
        f"Correctness: {correctness['baseline']:.2%} → {correctness['candidate']:.2%} ({correctness['absoluteDelta']:+.2%}p)",
        "",
        "Performance is gated only for cases correct in both campaigns; overall metrics are informational.",
        "",
    ))
    for item in report["caseComparisons"]:
        marker = "PASS" if not item["failures"] else "FAIL"
        lines.append(f"- `{item['caseId']}` ({item['caseType']}): {marker}; correct {item['baselineCorrect']} → {item['candidateCorrect']}; failures={item['failures']}")
    if report["failures"]:
        lines.extend(("", "Failures: " + ", ".join(report["failures"])))
    lines.extend(("", "Promotion requires bounded live evidence and explicit human approval."))
    return "\n".join(lines) + "\n"
