from types import SimpleNamespace
from unittest.mock import patch

from app.core.auth_context import ActorContext
from app.schemas.dashboard import DashboardAssistantRequest
from app.services.dashboard_assistant_context import (
    AssistantColumnContext,
    AssistantDashboardContext,
    AssistantDatasetContext,
)
from app.services.dashboard_assistant_service import DashboardAssistantService


def test_visualization_request_applies_deterministic_action_without_openai_key() -> None:
    context = AssistantDashboardContext(
        id="dashboard-1",
        datasets=[
            AssistantDatasetContext(
                id="sales",
                name="Sales",
                layer="gold",
                description="Monthly sales",
                columns=[
                    AssistantColumnContext(name="month", type="date"),
                    AssistantColumnContext(name="revenue", type="decimal"),
                ],
                sample_rows=[{"month": "2026-01", "revenue": 100}],
                tags=[],
            ),
        ],
    )
    service = DashboardAssistantService(
        SimpleNamespace(),
        SimpleNamespace(),
        SimpleNamespace(
            openai_api_key=None,
            openai_assistant_enabled=True,
            openai_assistant_max_sample_rows=5,
        ),
    )
    request = DashboardAssistantRequest.model_validate({
        "mode": "visualization_request",
        "prompt": "매출을 차트로 만들어줘",
    })

    with patch("app.services.dashboard_assistant_service.build_assistant_context", return_value=context):
        response = service.generate_response(request, ActorContext(name="analyst", role="admin"))

    assert response.actions
    assert response.actions[0].type == "create_widget"
    assert response.actions[0].widget.dataset_id == "sales"
    assert response.actions[0].widget.config["yKey"] == "revenue"
    assert any("OPENAI_API_KEY" in warning for warning in response.warnings)


def test_non_visualization_request_stays_report_only_without_openai_key() -> None:
    context = AssistantDashboardContext(id="dashboard-1")
    service = DashboardAssistantService(
        SimpleNamespace(),
        SimpleNamespace(),
        SimpleNamespace(
            openai_api_key=None,
            openai_assistant_enabled=True,
            openai_assistant_max_sample_rows=5,
        ),
    )
    request = DashboardAssistantRequest.model_validate({
        "mode": "dashboard_question",
        "prompt": "현재 대시보드 상태를 알려줘",
    })

    with patch("app.services.dashboard_assistant_service.build_assistant_context", return_value=context):
        response = service.generate_response(request, ActorContext(name="analyst", role="admin"))

    assert response.actions == []
    assert "AI Assistant를 사용할 수 없어" in response.message
