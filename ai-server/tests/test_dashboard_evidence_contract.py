import pytest
from pydantic import ValidationError

from app.schemas import DashboardAssistantOutput


def dashboard_action(*, evidence_ids: list[str]) -> dict[str, object]:
    return {
        "type": "report",
        "widgetId": None,
        "markdown": "근거 기반 보고서",
        "widget": None,
        "patch": None,
        "usedEvidenceIds": evidence_ids,
    }


def test_dashboard_output_derives_top_level_evidence_from_actions() -> None:
    output = DashboardAssistantOutput.model_validate({
        "message": "완료",
        "actions": [
            dashboard_action(evidence_ids=["doc-a", "doc-shared"]),
            dashboard_action(evidence_ids=["doc-shared", "doc-b"]),
        ],
        "warnings": [],
        "usedEvidenceIds": ["doc-b", "doc-shared", "doc-a"],
    })

    assert output.used_evidence_ids == ["doc-a", "doc-shared", "doc-b"]


def test_dashboard_output_rejects_unscoped_top_level_evidence() -> None:
    with pytest.raises(ValidationError, match="union of action-scoped evidence"):
        DashboardAssistantOutput.model_validate({
            "message": "완료",
            "actions": [dashboard_action(evidence_ids=[])],
            "warnings": [],
            "usedEvidenceIds": ["doc-unscoped"],
        })


def test_dashboard_output_rejects_missing_top_level_action_evidence() -> None:
    with pytest.raises(ValidationError, match="union of action-scoped evidence"):
        DashboardAssistantOutput.model_validate({
            "message": "완료",
            "actions": [dashboard_action(evidence_ids=["doc-action"])],
            "warnings": [],
            "usedEvidenceIds": [],
        })
