from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.core.auth_context import ActorContext, get_actor_context
from app.core.database import get_db
from app.core.errors import ApiError
from app.main import create_app
from app.schemas.dashboard import (
    DashboardAssistantRequest,
    DashboardAssistantResponse,
    DashboardRuntimeWidgetType,
)
from app.services.dashboard_assistant_context import (
    AssistantColumnContext,
    AssistantDashboardContext,
    AssistantDatasetContext,
    AssistantWidgetContext,
    _scope_datasets_for_request,
)
from app.services.dashboard_assistant_guard import guard_assistant_response
from app.services.dashboard_assistant_service import (
    DashboardAssistantService,
    _require_visualization_action,
)


def assistant_context() -> AssistantDashboardContext:
    return AssistantDashboardContext(
        id="dashboard-1",
        datasets=[
            AssistantDatasetContext(
                id="sales",
                name="Sales",
                layer="gold",
                description="Regional sales",
                columns=[
                    AssistantColumnContext(name="region", type="string"),
                    AssistantColumnContext(name="revenue", type="decimal"),
                ],
                sample_rows=[{"region": "Seoul", "revenue": 100}],
                tags=[],
            ),
        ],
        widgets=[
            AssistantWidgetContext(
                id="widget-1",
                title="지역별 매출",
                type=DashboardRuntimeWidgetType.BAR_CHART,
                dataset_id="sales",
                config={
                    "aggregation": "sum",
                    "color": {"colors": ["#2563eb"]},
                    "xKey": "region",
                    "yKey": "revenue",
                },
                data_sample=[{"region": "Seoul", "revenue": 100}],
            ),
        ],
    )


def amazon_dashboard_context() -> AssistantDashboardContext:
    return AssistantDashboardContext(
        id="dashboard-amazon",
        datasets=[
            AssistantDatasetContext(
                id="amazon-products",
                name="amazon_products",
                layer="gold",
                description="Amazon product catalog",
                columns=[
                    AssistantColumnContext(name="category", type="string"),
                    AssistantColumnContext(name="product_id", type="string"),
                    AssistantColumnContext(name="price", type="double"),
                ],
                sample_rows=[{"category": "Electronics", "product_id": "p-1", "price": 29.9}],
                tags=["amazon", "products"],
            ),
            AssistantDatasetContext(
                id="unrelated-orders",
                name="orders",
                layer="gold",
                description="Unrelated orders",
                columns=[AssistantColumnContext(name="order_id", type="string")],
                sample_rows=[],
                tags=["orders"],
            ),
        ],
    )


def response_with_update(patch_payload: dict[str, object]) -> DashboardAssistantResponse:
    return DashboardAssistantResponse.model_validate({
        "message": "updated",
        "actions": [{
            "type": "update_widget",
            "widgetId": "widget-1",
            "patch": patch_payload,
            "usedEvidenceIds": ["doc-mutation"],
        }],
        "warnings": [],
        "usedEvidenceIds": ["doc-mutation"],
    })


def test_update_rejects_dataset_change_that_is_not_in_accessible_context() -> None:
    guarded = guard_assistant_response(
        response_with_update({"datasetId": "private-sales"}),
        assistant_context(),
    )

    assert guarded.actions == []
    assert guarded.used_evidence_ids == []
    assert any("private-sales" in warning for warning in guarded.warnings)


def test_update_merges_partial_config_with_current_widget_before_validation() -> None:
    guarded = guard_assistant_response(
        response_with_update({"config": {"color": {"colors": ["#ef4444"]}}}),
        assistant_context(),
    )

    assert len(guarded.actions) == 1
    patch_payload = guarded.actions[0].patch.config
    assert patch_payload is not None
    assert patch_payload["aggregation"] == "sum"
    assert patch_payload["xKey"] == "region"
    assert patch_payload["yKey"] == "revenue"
    assert patch_payload["color"]["colors"] == ["#ef4444"]


def test_update_rejects_type_change_without_a_valid_target_config() -> None:
    guarded = guard_assistant_response(
        response_with_update({"type": "metric"}),
        assistant_context(),
    )

    assert guarded.actions == []
    assert any("metric config" in warning for warning in guarded.warnings)


def test_title_only_update_remains_valid_without_rewriting_config() -> None:
    guarded = guard_assistant_response(
        response_with_update({"title": "서울 지역 매출"}),
        assistant_context(),
    )

    assert len(guarded.actions) == 1
    assert guarded.actions[0].patch.title == "서울 지역 매출"
    assert guarded.actions[0].patch.config is None


def test_dashboard_question_cannot_mutate_widgets_or_retain_mutation_evidence() -> None:
    request = DashboardAssistantRequest.model_validate({
        "mode": "dashboard_question",
        "prompt": "이 대시보드를 요약해줘",
    })
    response = DashboardAssistantResponse.model_validate({
        "message": "summary",
        "actions": [
            {
                "type": "report",
                "markdown": "매출 요약",
                "usedEvidenceIds": ["doc-report"],
            },
            {
                "type": "update_widget",
                "widgetId": "widget-1",
                "patch": {"title": "몰래 변경"},
                "usedEvidenceIds": ["doc-mutation"],
            },
        ],
        "warnings": [],
        "usedEvidenceIds": ["doc-report", "doc-mutation"],
    })

    guarded = _require_visualization_action(request, response)

    assert [action.type for action in guarded.actions] == ["report"]
    assert guarded.used_evidence_ids == ["doc-report"]
    assert any("질문 모드" in warning for warning in guarded.warnings)


def test_assistant_api_enforces_question_mode_without_counting_provider_stub_as_model_success() -> None:
    app = create_app()
    actor = ActorContext(name="dashboard-editor", role="admin")
    service = DashboardAssistantService(
        SimpleNamespace(),
        SimpleNamespace(),
        SimpleNamespace(
            openai_assistant_enabled=True,
            openai_assistant_max_sample_rows=5,
            ai_gateway_base_url="http://contract-stub.invalid",
            ai_gateway_service_token="contract-only",
        ),
    )
    app.dependency_overrides[get_actor_context] = lambda: actor
    app.dependency_overrides[get_db] = lambda: SimpleNamespace()
    try:
        with (
            patch("app.api.dashboard_assistant.DashboardAssistantService", return_value=service),
            patch("app.api.dashboard_assistant.DashboardRuntimeRepository", return_value=SimpleNamespace()),
            patch("app.api.dashboard_assistant.CatalogRepository", return_value=SimpleNamespace()),
            patch(
                "app.services.dashboard_assistant_service.build_assistant_context",
                return_value=assistant_context(),
            ),
            patch.object(
                service,
                "_request_gateway",
                return_value={
                    "_requestId": "contract-request",
                    "actions": [{
                        "type": "update_widget",
                        "widgetId": "widget-1",
                        "patch": {"title": "should-not-apply"},
                        "usedEvidenceIds": ["doc-mutation"],
                    }],
                    "message": "stubbed contract response",
                    "model": "contract-stub",
                    "provider": "contract-stub",
                    "usedEvidenceIds": ["doc-mutation"],
                    "warnings": [],
                },
            ),
            patch("app.services.dashboard_assistant_service.persist_verified_generation_evidence"),
        ):
            response = TestClient(app).post(
                "/api/dashboards/assistant",
                json={"mode": "dashboard_question", "prompt": "현재 상태를 설명해줘"},
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    payload = response.json()
    assert payload["actions"] == []
    assert payload["usedEvidenceIds"] == []
    assert any("질문 모드" in warning for warning in payload["warnings"])


def test_current_amazon_dataset_scopes_provider_context_away_from_unrelated_datasets() -> None:
    request = DashboardAssistantRequest.model_validate({
        "currentDatasetId": "amazon-products",
        "mode": "visualization_request",
        "prompt": "Amazon 상품 카테고리별 상품 수 막대그래프를 만들어줘",
    })

    datasets, warnings = _scope_datasets_for_request(
        request,
        amazon_dashboard_context().datasets,
        [],
    )

    assert [dataset.id for dataset in datasets] == ["amazon-products"]
    assert warnings == []


def test_amazon_visualization_retries_gateway_contract_failure_and_returns_create_widget() -> None:
    context = amazon_dashboard_context()
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
        "currentDatasetId": "amazon-products",
        "dashboardId": "dashboard-amazon",
        "mode": "visualization_request",
        "prompt": "Amazon 상품 카테고리별 상품 수 막대그래프를 만들어줘",
    })
    created = {
        "actions": [{
            "type": "create_widget",
            "widget": {
                "config": {
                    "aggregation": "count",
                    "color": {"colors": ["#2563eb"]},
                    "xKey": "category",
                    "yKey": "product_id",
                },
                "datasetId": "amazon-products",
                "title": "카테고리별 상품 수",
                "type": "bar_chart",
            },
            "usedEvidenceIds": [],
        }],
        "message": "차트를 생성했습니다.",
        "model": "gpt-test",
        "provider": "openai_compatible",
        "usedEvidenceIds": [],
        "warnings": [],
    }

    with (
        patch("app.services.dashboard_assistant_service.build_assistant_context", return_value=context),
        patch("app.services.dashboard_assistant_service.issue_ai_context_token", side_effect=["token-1", "token-2"]),
        patch(
            "app.services.dashboard_assistant_service.AiGatewayClient.generate_dashboard_response",
            side_effect=[
                ApiError("INTERNAL_ERROR", "AI gateway generation failed", 502),
                created,
            ],
        ) as generate,
    ):
        response = service.generate_response(request, ActorContext(name="analyst", role="admin"))

    assert generate.call_count == 2
    assert len(response.actions) == 1
    assert response.actions[0].type == "create_widget"
    assert response.actions[0].widget.dataset_id == "amazon-products"
    assert response.actions[0].widget.config["aggregation"] == "count"
    assert "재시도" in generate.call_args.kwargs["prompt"]


def test_dashboard_question_retries_gateway_contract_failure_with_report_only_instruction() -> None:
    context = assistant_context()
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
        "dashboardId": "dashboard-1",
        "mode": "dashboard_question",
        "prompt": "현재 대시보드를 요약해줘",
    })
    report = {
        "actions": [{
            "type": "report",
            "markdown": "현재 대시보드는 지역별 매출을 보여줍니다.",
            "usedEvidenceIds": [],
        }],
        "message": "요약을 생성했습니다.",
        "model": "gpt-test",
        "provider": "openai_compatible",
        "usedEvidenceIds": [],
        "warnings": [],
    }

    with (
        patch("app.services.dashboard_assistant_service.build_assistant_context", return_value=context),
        patch("app.services.dashboard_assistant_service.issue_ai_context_token", side_effect=["token-1", "token-2"]),
        patch(
            "app.services.dashboard_assistant_service.AiGatewayClient.generate_dashboard_response",
            side_effect=[
                ApiError("INTERNAL_ERROR", "AI gateway generation failed", 502),
                report,
            ],
        ) as generate,
    ):
        response = service.generate_response(request, ActorContext(name="analyst", role="admin"))

    assert generate.call_count == 2
    assert [action.type for action in response.actions] == ["report"]
    assert "report action" in generate.call_args.kwargs["prompt"]
    assert "create_widget" in generate.call_args.kwargs["prompt"]
