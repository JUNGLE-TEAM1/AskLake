from app.schemas.dashboard import DashboardAssistantResponse
from app.services.dashboard_assistant_context import AssistantDashboardContext
from app.services.dashboard_assistant_guard import guard_assistant_response


def test_rejected_action_cannot_retain_its_evidence() -> None:
    response = DashboardAssistantResponse.model_validate({
        "message": "검토 결과",
        "actions": [
            {"type": "report", "markdown": "유효한 보고서", "usedEvidenceIds": ["doc-valid"]},
            {"type": "report", "markdown": "", "usedEvidenceIds": ["doc-rejected"]},
        ],
        "warnings": [],
        "usedEvidenceIds": ["doc-valid", "doc-rejected"],
    })

    guarded = guard_assistant_response(response, AssistantDashboardContext(id="dashboard-1"))

    assert len(guarded.actions) == 1
    assert guarded.used_evidence_ids == ["doc-valid"]


def test_top_level_evidence_without_action_scope_is_discarded() -> None:
    response = DashboardAssistantResponse.model_validate({
        "message": "검토 결과",
        "actions": [{"type": "report", "markdown": "보고서"}],
        "warnings": [],
        "usedEvidenceIds": ["doc-unscoped"],
    })

    guarded = guard_assistant_response(response, AssistantDashboardContext(id="dashboard-1"))

    assert guarded.used_evidence_ids == []


def test_each_surviving_action_contributes_only_its_scoped_evidence_ids() -> None:
    response = DashboardAssistantResponse.model_validate({
        "message": "검토 결과",
        "actions": [
            {"type": "report", "markdown": "첫 보고서", "usedEvidenceIds": ["doc-a", "doc-shared"]},
            {"type": "report", "markdown": "둘째 보고서", "usedEvidenceIds": ["doc-shared", "doc-b"]},
        ],
        "warnings": [],
        "usedEvidenceIds": ["doc-a", "doc-shared", "doc-b"],
    })

    guarded = guard_assistant_response(response, AssistantDashboardContext(id="dashboard-1"))

    assert guarded.used_evidence_ids == ["doc-a", "doc-shared", "doc-b"]
