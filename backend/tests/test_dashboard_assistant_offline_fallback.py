from types import SimpleNamespace
from unittest.mock import patch

from app.core.auth_context import ActorContext
from app.core.config import Settings
from app.schemas.dashboard import DashboardAssistantRequest
from app.services.dashboard_assistant_context import (
    AssistantColumnContext,
    AssistantDashboardContext,
    AssistantDatasetContext,
)
from app.services.dashboard_assistant_service import DashboardAssistantService


def runtime_settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "ai_gateway_base_url": None,
        "ai_gateway_service_token": None,
        "openai_assistant_enabled": True,
        "openai_assistant_max_sample_rows": 5,
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)


def test_visualization_request_fails_closed_without_gateway_configuration() -> None:
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
            openai_assistant_enabled=True,
            openai_assistant_max_sample_rows=5,
            ai_gateway_base_url=None,
            ai_gateway_service_token=None,
        ),
    )
    request = DashboardAssistantRequest.model_validate({
        "mode": "visualization_request",
        "prompt": "매출을 차트로 만들어줘",
    })

    with patch("app.services.dashboard_assistant_service.build_assistant_context", return_value=context):
        response = service.generate_response(request, ActorContext(name="analyst", role="admin"))

    assert response.actions == []
    assert response.provider == "unavailable"
    assert "요청을 실행하지 않았습니다" in response.message
    assert any("AI Gateway" in warning for warning in response.warnings)


def test_dashboard_assistant_uses_the_real_runtime_settings_contract() -> None:
    context = AssistantDashboardContext(id="dashboard-runtime-settings")
    service = DashboardAssistantService(
        SimpleNamespace(),
        SimpleNamespace(),
        runtime_settings(),
    )
    request = DashboardAssistantRequest.model_validate({
        "mode": "dashboard_question",
        "prompt": "현재 대시보드를 요약해줘",
    })

    with patch(
        "app.services.dashboard_assistant_service.build_assistant_context",
        return_value=context,
    ) as build_context:
        response = service.generate_response(
            request,
            ActorContext(name="analyst", role="admin"),
        )

    assert build_context.call_args.kwargs["max_sample_rows"] == 5
    assert response.actions == []
    assert response.provider == "unavailable"


def test_dashboard_assistant_honors_the_existing_feature_toggle() -> None:
    context = AssistantDashboardContext(id="dashboard-disabled")
    service = DashboardAssistantService(
        SimpleNamespace(),
        SimpleNamespace(),
        runtime_settings(openai_assistant_enabled=False),
    )
    request = DashboardAssistantRequest.model_validate({
        "mode": "dashboard_question",
        "prompt": "현재 대시보드를 요약해줘",
    })

    with patch(
        "app.services.dashboard_assistant_service.build_assistant_context",
        return_value=context,
    ):
        response = service.generate_response(
            request,
            ActorContext(name="analyst", role="admin"),
        )

    assert response.actions == []
    assert response.provider == "unavailable"
    assert any("비활성화" in warning for warning in response.warnings)


def test_non_visualization_request_stays_report_only_without_openai_key() -> None:
    context = AssistantDashboardContext(id="dashboard-1")
    service = DashboardAssistantService(
        SimpleNamespace(),
        SimpleNamespace(),
        SimpleNamespace(
            openai_assistant_enabled=True,
            openai_assistant_max_sample_rows=5,
            ai_gateway_base_url=None,
            ai_gateway_service_token=None,
        ),
    )
    request = DashboardAssistantRequest.model_validate({
        "mode": "dashboard_question",
        "prompt": "현재 대시보드 상태를 알려줘",
    })

    with patch("app.services.dashboard_assistant_service.build_assistant_context", return_value=context):
        response = service.generate_response(request, ActorContext(name="analyst", role="admin"))

    assert response.actions == []
    assert "AI Gateway를 사용할 수 없어" in response.message


def test_visualization_request_does_not_synthesize_a_local_chart() -> None:
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
            openai_assistant_enabled=True,
            openai_assistant_max_sample_rows=5,
            ai_gateway_base_url="http://ai-server:8090",
            ai_gateway_service_token="test-token",
        ),
    )
    request = DashboardAssistantRequest.model_validate({
        "mode": "visualization_request",
        "prompt": "Create a monthly revenue chart",
    })

    with (
        patch("app.services.dashboard_assistant_service.build_assistant_context", return_value=context),
        patch.object(
            service,
            "_request_gateway",
            return_value={
                "actions": [],
                "message": "The model returned no valid chart action.",
                "model": "gpt-test",
                "provider": "openai_compatible",
                "warnings": [],
            },
        ),
    ):
        response = service.generate_response(request, ActorContext(name="analyst", role="admin"))

    assert response.actions == []
    assert response.provider == "openai_compatible"
    assert "기본 차트" not in response.message
    assert "대시보드를 수정하지 않았습니다" in response.message
    assert any("action" in warning for warning in response.warnings)
