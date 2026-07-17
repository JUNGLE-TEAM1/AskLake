from app.services.rag_tokens import count_tokens, truncate_tokens
from app.services.rag_evaluation import enforce_baseline_gate, enforce_quality_gate


def test_context_token_budget_is_deterministic_for_mixed_korean_text():
    text = "배송이 늦었습니다. delivery was delayed."
    assert count_tokens(text) > 0
    assert count_tokens(truncate_tokens(text, 4)) <= 4
    assert truncate_tokens(text, 100) == text


def test_quality_gate_supports_baseline_report_metrics():
    baseline = {"metrics": {"parentRecall": 0.8, "parentMrr": 0.5}}
    current = {"metrics": {"parentRecall": 0.76, "parentMrr": 0.475}}
    assert enforce_baseline_gate(current, baseline)["baselineGate"]["passed"] is True
    failing = enforce_baseline_gate({"metrics": {"parentRecall": 0.7, "parentMrr": 0.5}}, baseline)
    assert failing["baselineGate"]["passed"] is False
    report = enforce_quality_gate({"metrics": {"parentRecall": 0.8, "parentMrr": 0.5, "parentNdcg": 0.5, "chunkRecall": 0.6, "filterPrecision": 1.0, "duplicateParentRate": 0.0}})
    assert report["gate"]["passed"] is True
