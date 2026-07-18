from pathlib import Path

import pytest

from app.benchmarks.suite import BenchmarkSuite, canonical_result_hash, golden_mismatches, load_suite


SUITE = Path(__file__).parents[1] / "benchmarks/nessie-sql/question-suite.v1.json"


def test_suite_is_versioned_unique_and_covers_required_types() -> None:
    suite = load_suite(SUITE)
    types = {case.case_type for case in suite.cases}

    assert suite.suite_version == "1.0.0"
    assert len(suite.cases) == len({case.case_id for case in suite.cases}) == 12
    assert {"time_partition", "fact_dimension_join", "multi_join", "ambiguous", "invalid_scope"} <= types
    assert all(case.golden.row_count is not None or case.expected_failure for case in suite.cases)


def test_result_hash_is_stable_and_includes_columns() -> None:
    first = canonical_result_hash(["count"], [[10]])
    assert first == canonical_result_hash(["count"], [[10]])
    assert first != canonical_result_hash(["total"], [[10]])
    assert first != canonical_result_hash(["count"], [[11]])


def test_suite_rejects_duplicate_case_ids() -> None:
    payload = load_suite(SUITE).model_dump(mode="json")
    payload["cases"].append(dict(payload["cases"][0]))
    with pytest.raises(ValueError, match="unique"):
        BenchmarkSuite.model_validate(payload)


def test_golden_comparison_reports_hash_drift_without_rows() -> None:
    suite = load_suite(SUITE)
    receipt = {
        "results": [
            {"caseId": case.case_id, "expectedFailure": True}
            if case.expected_failure
            else {"caseId": case.case_id, "rowCount": case.golden.row_count, "resultHash": case.golden.result_hash}
            for case in suite.cases
        ]
    }
    assert golden_mismatches(suite, receipt) == []
    receipt["results"][0]["resultHash"] = "0" * 64
    assert golden_mismatches(suite, receipt) == ["recent_large_orders: result hash drift"]
