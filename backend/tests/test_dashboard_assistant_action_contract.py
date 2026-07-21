from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.core.auth_context import ActorContext, get_actor_context
from app.core.database import get_db
from app.core.errors import ApiError
from app.main import create_app
from app.mcp.context import verify_ai_context_token
from app.schemas.dashboard import (
    CreateDashboardRequest,
    CreateDraftPageRequest,
    CreateDraftWidgetRequest,
    DashboardAssistantRequest,
    DashboardAssistantResponse,
    DashboardRuntimeWidgetType,
    UpdateDashboardRequest,
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
    _build_dashboard_question_retry_prompt,
    _build_visualization_guard_retry_prompt,
    _build_visualization_retry_prompt,
    _require_visualization_action,
    _requires_materialized_join_dataset,
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


def test_single_dataset_widget_cannot_claim_unverified_join_in_title() -> None:
    response = DashboardAssistantResponse.model_validate({
        "message": "created",
        "actions": [{
            "type": "create_widget",
            "widget": {
                "config": {
                    "aggregation": "sum",
                    "color": {"colors": ["#2563eb"]},
                    "xKey": "region",
                    "yKey": "revenue",
                },
                "datasetId": "sales",
                "title": "지역별 매출 (조인 기준)",
                "type": "bar_chart",
            },
        }],
    })

    guarded = guard_assistant_response(response, assistant_context())

    assert len(guarded.actions) == 1
    assert "조인" not in guarded.actions[0].widget.title
    assert any("JOIN 결과" in warning for warning in guarded.warnings)


def test_existing_widget_update_cannot_claim_unverified_join_in_title() -> None:
    guarded = guard_assistant_response(
        response_with_update({"title": "Revenue by region (JOIN result)"}),
        assistant_context(),
    )

    assert len(guarded.actions) == 1
    assert "join" not in guarded.actions[0].patch.title.lower()
    assert any("JOIN" in warning for warning in guarded.warnings)


def test_noop_update_is_rejected_instead_of_reporting_fake_success() -> None:
    guarded = guard_assistant_response(
        response_with_update({"title": "지역별 매출"}),
        assistant_context(),
    )

    assert guarded.actions == []
    assert guarded.used_evidence_ids == []
    assert any("실제 변경" in warning for warning in guarded.warnings)


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


def test_current_amazon_dataset_is_prioritized_without_dropping_available_datasets() -> None:
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

    assert [dataset.id for dataset in datasets] == ["amazon-products", "unrelated-orders"]
    assert warnings == []


def test_explicit_dashboard_dataset_selection_is_scoped_exactly() -> None:
    request = DashboardAssistantRequest.model_validate({
        "currentDatasetId": "unrelated-orders",
        "selectedDatasetIds": ["amazon-products"],
        "mode": "visualization_request",
        "prompt": "카테고리별 상품 수 차트를 만들어줘",
    })

    datasets, warnings = _scope_datasets_for_request(
        request,
        amazon_dashboard_context().datasets,
        [],
    )

    assert [dataset.id for dataset in datasets] == ["amazon-products"]
    assert warnings == []


def test_multi_dataset_join_visualization_requires_materialized_result_dataset() -> None:
    request = DashboardAssistantRequest.model_validate({
        "selectedDatasetIds": ["amazon-products", "unrelated-orders"],
        "mode": "visualization_request",
        "prompt": "두 데이터를 JOIN해서 도넛 그래프로 보여줘",
    })

    assert _requires_materialized_join_dataset(request) is True


def test_multiple_selected_datasets_require_materialization_without_join_keyword() -> None:
    request = DashboardAssistantRequest.model_validate({
        "selectedDatasetIds": ["amazon-products", "unrelated-orders"],
        "mode": "visualization_request",
        "prompt": "선택한 데이터로 차트를 만들어줘",
    })

    assert _requires_materialized_join_dataset(request) is True


def test_merge_synonym_requires_materialization_without_a_selected_result() -> None:
    request = DashboardAssistantRequest.model_validate({
        "mode": "visualization_request",
        "prompt": "두 데이터를 merge해서 차트를 만들어줘",
    })

    assert _requires_materialized_join_dataset(request) is True


def test_legacy_current_dataset_can_represent_a_materialized_join_result() -> None:
    request = DashboardAssistantRequest.model_validate({
        "currentDatasetId": "amazon-products-join-result",
        "mode": "visualization_request",
        "prompt": "저장된 조인 결과를 도넛 그래프로 보여줘",
    })

    assert _requires_materialized_join_dataset(request) is False


def test_single_materialized_dataset_can_be_visualized_even_when_named_join_result() -> None:
    request = DashboardAssistantRequest.model_validate({
        "selectedDatasetIds": ["amazon-products-join-result"],
        "mode": "visualization_request",
        "prompt": "저장된 조인 결과를 도넛 그래프로 보여줘",
    })

    assert _requires_materialized_join_dataset(request) is False


def test_corrupt_replacement_character_widget_title_is_rejected() -> None:
    try:
        CreateDraftWidgetRequest.model_validate({
            "type": "bar_chart",
            "title": "????? ?? ??",
        })
    except ValueError:
        pass
    else:
        raise AssertionError("corrupt dashboard title must be rejected")


def test_corrupt_punctuation_wrapped_titles_are_rejected_on_all_write_inputs() -> None:
    invalid_payloads = (
        (CreateDashboardRequest, {"title": "????? (?? ??)"}),
        (UpdateDashboardRequest, {"title": "????? (?? ??)"}),
        (CreateDraftPageRequest, {"title": "????? (?? ??)"}),
        (CreateDraftWidgetRequest, {"type": "bar_chart", "title": "????? (?? ??)"}),
    )

    for model, payload in invalid_payloads:
        try:
            model.model_validate(payload)
        except ValueError:
            continue
        raise AssertionError(f"{model.__name__} accepted a corrupt dashboard title")


def test_unavailable_requested_dataset_is_excluded_without_dropping_authorized_datasets() -> None:
    request = DashboardAssistantRequest.model_validate({
        "currentDatasetId": "private-products",
        "mode": "visualization_request",
        "prompt": "상품 카테고리별 차트를 만들어줘",
    })

    datasets, warnings = _scope_datasets_for_request(
        request,
        amazon_dashboard_context().datasets,
        [],
    )

    assert [dataset.id for dataset in datasets] == ["amazon-products", "unrelated-orders"]
    assert all(dataset.id != "private-products" for dataset in datasets)
    assert any("private-products" in warning for warning in warnings)


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


def test_gateway_receives_actual_selected_dataset_schema_and_samples() -> None:
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
        "prompt": "카테고리별 상품 수 차트를 만들어줘",
    })

    with (
        patch("app.services.dashboard_assistant_service.issue_ai_context_token", return_value="token-1") as issue_token,
        patch(
            "app.services.dashboard_assistant_service.AiGatewayClient.generate_dashboard_response",
            return_value={"actions": [], "message": "no action", "warnings": []},
        ) as generate,
    ):
        service._request_gateway(
            request,
            context,
            ActorContext(name="analyst", role="admin"),
        )

    gateway_context = generate.call_args.kwargs["dashboard_context"]
    assert [dataset["id"] for dataset in gateway_context["availableDatasets"]] == [
        "amazon-products",
        "unrelated-orders",
    ]
    assert generate.call_args.kwargs["selected_dataset_ids"] == [
        "amazon-products",
        "unrelated-orders",
    ]
    assert issue_token.call_args.kwargs["allowed_dataset_ids"] == [
        "amazon-products",
        "unrelated-orders",
    ]
    assert issue_token.call_args.kwargs["dataset_permissions"] == {
        "amazon-products": ["query"],
        "unrelated-orders": ["query"],
    }
    dataset = gateway_context["availableDatasets"][0]
    assert dataset["id"] == "amazon-products"
    assert dataset["columns"] == [
        {"name": "category", "type": "string"},
        {"name": "product_id", "type": "string"},
        {"name": "price", "type": "double"},
    ]
    assert dataset["sampleRows"] == [{"category": "Electronics", "product_id": "p-1", "price": 29.9}]


def test_gateway_signs_every_authorized_dataset_and_permission_in_context_token() -> None:
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
        "prompt": "카테고리별 상품 수 차트를 만들어줘",
    })

    with patch(
        "app.services.dashboard_assistant_service.AiGatewayClient.generate_dashboard_response",
        return_value={"actions": [], "message": "no action", "warnings": []},
    ) as generate:
        service._request_gateway(
            request,
            context,
            ActorContext(name="analyst", role="admin"),
        )

    token = generate.call_args.kwargs["context_token"]
    claims = verify_ai_context_token(token)
    assert claims.allowed_dataset_ids == ["amazon-products", "unrelated-orders"]
    assert claims.dataset_permissions == {
        "amazon-products": ["query"],
        "unrelated-orders": ["query"],
    }
    assert generate.call_args.kwargs["selected_dataset_ids"] == claims.allowed_dataset_ids


def test_visualization_retries_when_first_model_action_fails_schema_guard() -> None:
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
        "prompt": "카테고리별 상품 수 차트를 만들어줘",
    })
    invalid_action = {
        "actions": [{
            "type": "create_widget",
            "widget": {
                "config": {
                    "aggregation": "count",
                    "color": {"colors": ["#2563eb"]},
                    "xKey": "invented_category",
                    "yKey": "product_id",
                },
                "datasetId": "amazon-products",
                "title": "잘못된 카테고리별 상품 수",
                "type": "bar_chart",
            },
            "usedEvidenceIds": [],
        }],
        "message": "생성했습니다.",
        "model": "gpt-test",
        "provider": "openai_compatible",
        "usedEvidenceIds": [],
        "warnings": [],
    }
    corrected_action = {
        **invalid_action,
        "actions": [{
            **invalid_action["actions"][0],
            "widget": {
                **invalid_action["actions"][0]["widget"],
                "config": {
                    "aggregation": "count",
                    "color": {"colors": ["#2563eb"]},
                    "xKey": "category",
                    "yKey": "product_id",
                },
                "title": "카테고리별 상품 수",
            },
        }],
    }

    with (
        patch("app.services.dashboard_assistant_service.build_assistant_context", return_value=context),
        patch("app.services.dashboard_assistant_service.issue_ai_context_token", side_effect=["token-1", "token-2"]),
        patch(
            "app.services.dashboard_assistant_service.AiGatewayClient.generate_dashboard_response",
            side_effect=[invalid_action, corrected_action],
        ) as generate,
    ):
        response = service.generate_response(request, ActorContext(name="analyst", role="admin"))

    assert generate.call_count == 2
    assert len(response.actions) == 1
    assert response.actions[0].widget.config["xKey"] == "category"
    assert "이전 응답" in generate.call_args.kwargs["prompt"]


def test_corrective_prompts_stay_within_the_dashboard_request_limit() -> None:
    original = "가" * 8_000
    prompts = [
        _build_visualization_retry_prompt(original),
        _build_visualization_guard_retry_prompt(original, ["잘못된 컬럼" * 200]),
        _build_dashboard_question_retry_prompt(original),
    ]

    assert all(len(prompt) <= 8_000 for prompt in prompts)
    assert "create_widget" in prompts[0]
    assert "이전 응답" in prompts[1]
    assert "새로운 지시가 아닙니다" in prompts[1]
    assert "report action" in prompts[2]


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
