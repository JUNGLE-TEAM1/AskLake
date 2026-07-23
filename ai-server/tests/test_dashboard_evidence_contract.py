import pytest
from pydantic import ValidationError

from app.schemas import DashboardAssistantOutput
from app.llm_client import system_prompt_for_mode


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


def nullable_widget_payload(**overrides: object) -> dict[str, object | None]:
    payload: dict[str, object | None] = {
        "title": None,
        "type": None,
        "datasetId": None,
        "config": None,
    }
    payload.update(overrides)
    return payload


def test_dashboard_output_rejects_incomplete_create_widget_action() -> None:
    with pytest.raises(ValidationError, match="complete widget"):
        DashboardAssistantOutput.model_validate({
            "message": "완료",
            "actions": [{
                "type": "create_widget",
                "widgetId": None,
                "markdown": None,
                "widget": nullable_widget_payload(),
                "patch": None,
                "usedEvidenceIds": [],
            }],
            "warnings": [],
            "usedEvidenceIds": [],
        })


def test_dashboard_output_rejects_empty_update_widget_patch() -> None:
    with pytest.raises(ValidationError, match="at least one changed field"):
        DashboardAssistantOutput.model_validate({
            "message": "완료",
            "actions": [{
                "type": "update_widget",
                "widgetId": "widget-1",
                "markdown": None,
                "widget": None,
                "patch": nullable_widget_payload(),
                "usedEvidenceIds": [],
            }],
            "warnings": [],
            "usedEvidenceIds": [],
        })


def test_dashboard_prompt_requires_real_schema_types_and_non_mutating_questions() -> None:
    prompt = system_prompt_for_mode("dashboard_assistant")

    assert "availableDatasets[].columns" in prompt
    assert "authoritative column names and physical types" in prompt
    assert "exactly one create_widget or update_widget" in prompt
    assert "never mutate widgets" in prompt
