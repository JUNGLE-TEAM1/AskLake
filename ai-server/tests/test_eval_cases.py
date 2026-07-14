import json
from pathlib import Path


EVAL_CASES = Path(__file__).parents[1] / "evals" / "query_sql_cases.json"
REQUIRED_RISKS = {
    "normal",
    "join",
    "ambiguous_schema",
    "missing_schema",
    "legacy_preference",
    "prompt_injection",
    "permission",
    "malformed_sql",
}


def test_query_sql_eval_fixture_is_versioned_and_covers_release_risks() -> None:
    payload = json.loads(EVAL_CASES.read_text(encoding="utf-8"))

    assert payload["version"] == 1
    cases = payload["cases"]
    assert len(cases) >= len(REQUIRED_RISKS)
    assert {case["risk"] for case in cases} >= REQUIRED_RISKS
    assert len({case["id"] for case in cases}) == len(cases)

    for case in cases:
        assert case["prompt"]
        assert case["selected_dataset_ids"]
        assert case["expected_gates"]
