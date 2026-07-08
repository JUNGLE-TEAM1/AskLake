from app.schemas.dashboard import (
    DashboardAssistantMode,
    DashboardAssistantRequest,
    DashboardAssistantResponse,
    DashboardAssistantWidgetContext,
    DashboardRuntimeWidgetType,
)
from app.services.dashboard_assistant_context import (
    AssistantColumnContext,
    AssistantDashboardContext,
    AssistantDatasetContext,
    AssistantWidgetContext,
)
from app.services.dashboard_assistant_guard import _validate_config
from app.services.dashboard_assistant_service import _with_visualization_fallback_action
from app.services.dashboard_assistant_service import _prefer_prompt_bound_visualization_action


def build_orders_dataset(*, id_: str = "ds_orders_clean") -> AssistantDatasetContext:
    return AssistantDatasetContext(
        id=id_,
        name="orders_clean",
        layer="gold",
        description="주문 데이터",
        columns=[
            AssistantColumnContext("order_id", "string"),
            AssistantColumnContext("order_date", "date"),
            AssistantColumnContext("region", "string"),
            AssistantColumnContext("channel", "string"),
            AssistantColumnContext("total_amount", "string"),
        ],
        sample_rows=[
            {
                "order_id": "ORD-1001",
                "order_date": "2026-07-02",
                "region": "KR",
                "channel": "online",
                "total_amount": "128000",
            }
        ],
        tags=["order"],
    )


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def verify_dimension_only_count_normalization() -> None:
    dataset = build_orders_dataset()
    parsed, warnings = _validate_config(
        DashboardRuntimeWidgetType.BAR_CHART,
        {
            "xKey": "order_date",
            "yKey": "region",
            "aggregation": "sum",
            "color": {"colors": ["#2563eb"]},
        },
        dataset,
    )
    assert_true(parsed is not None, "dimension-only chart config should be normalized instead of rejected.")
    payload = parsed.model_dump(by_alias=True, exclude_none=True)
    assert_true(payload["aggregation"] == "count", "dimension-only value axis should use count aggregation.")
    assert_true(any("aggregation" in warning for warning in warnings), "normalization warning should be retained.")


def verify_metric_alias_to_available_column() -> None:
    dataset = build_orders_dataset()
    parsed, _warnings = _validate_config(
        DashboardRuntimeWidgetType.BAR_CHART,
        {
            "xKey": "order_date",
            "yKey": "revenue",
            "aggregation": "sum",
            "color": {"colors": ["#2563eb"]},
        },
        dataset,
    )
    assert_true(parsed is not None, "revenue alias should map to total_amount when that is the available metric.")
    payload = parsed.model_dump(by_alias=True, exclude_none=True)
    assert_true(payload["yKey"] == "total_amount", "revenue alias should resolve to total_amount.")


def verify_empty_ai_response_gets_fallback_action() -> None:
    dataset = build_orders_dataset()
    request = DashboardAssistantRequest(
        mode=DashboardAssistantMode.VISUALIZATION_REQUEST,
        prompt="아무거나 만들어줘 region order_date",
        dashboardId="dash_test",
        pageId="page_test",
        selectedWidgetId="widget_test",
        widgetId="widget_test",
        widgets=[
            DashboardAssistantWidgetContext(
                id="widget_test",
                title="시각화 요청",
                type=DashboardRuntimeWidgetType.BAR_CHART,
                layout={"x": 0, "y": 0, "w": 6, "h": 8},
                config={"placeholderKind": "visualization_request"},
            )
        ],
    )
    response = _with_visualization_fallback_action(
        request,
        AssistantDashboardContext(
            id="dash_test",
            datasets=[dataset],
            widgets=[
                AssistantWidgetContext(
                    id="widget_test",
                    title="시각화 요청",
                    type=DashboardRuntimeWidgetType.BAR_CHART,
                    dataset_id=None,
                    config={"placeholderKind": "visualization_request"},
                    data_sample=[],
                )
            ],
        ),
        DashboardAssistantResponse(
            message="AI 응답은 받았지만 대시보드에 적용 가능한 위젯 변경사항이 없었습니다.",
            actions=[],
            warnings=[],
        ),
    )
    assert_true(len(response.actions) == 1, "empty visualization AI response should get a fallback action.")
    action = response.actions[0]
    assert_true(action.type == "update_widget", "fallback should update the selected request widget.")
    assert_true(action.patch.dataset_id == "ds_orders_clean", "fallback should select a compatible dataset.")
    assert_true(action.patch.config["aggregation"] == "count", "dimension-only fallback should use count.")


def verify_prompt_bound_visualization_overrides_ai_metric_drift() -> None:
    customers_dataset = AssistantDatasetContext(
        id="ds_customers_clean_analysis",
        name="customers_clean_analysis",
        layer="gold",
        description="고객 분석 데이터",
        columns=[
            AssistantColumnContext("order_date", "string"),
            AssistantColumnContext("region", "string"),
            AssistantColumnContext("revenue", "string"),
        ],
        sample_rows=[
            {"order_date": "2026-07-02", "region": "KR", "revenue": "128000"},
            {"order_date": "2026-07-03", "region": "US", "revenue": "74000"},
        ],
        tags=["customers"],
    )
    app_events_dataset = AssistantDatasetContext(
        id="ds_app_events_analysis_analysis_analysis",
        name="app_events_analysis_analysis_analysis",
        layer="gold",
        description="앱 이벤트 데이터",
        columns=[
            AssistantColumnContext("order_date", "string"),
            AssistantColumnContext("total_amount", "string"),
            AssistantColumnContext("status", "string"),
        ],
        sample_rows=[
            {"order_date": "2026-07-02", "total_amount": "128000", "status": "paid"},
        ],
        tags=["events"],
    )
    request = DashboardAssistantRequest(
        mode=DashboardAssistantMode.VISUALIZATION_REQUEST,
        prompt="customers_clean_analysis에서 order_date별 고객 수를 막대 차트로 만들어줘",
        dashboardId="dash_test",
        pageId="page_test",
        selectedWidgetId="widget_test",
        widgetId="widget_test",
        widgets=[
            DashboardAssistantWidgetContext(
                id="widget_test",
                title="시각화 요청",
                type=DashboardRuntimeWidgetType.BAR_CHART,
                layout={"x": 0, "y": 0, "w": 6, "h": 8},
                config={"placeholderKind": "visualization_request"},
            )
        ],
    )
    response = _prefer_prompt_bound_visualization_action(
        request,
        AssistantDashboardContext(
            id="dash_test",
            datasets=[app_events_dataset, customers_dataset],
            widgets=[
                AssistantWidgetContext(
                    id="widget_test",
                    title="시각화 요청",
                    type=DashboardRuntimeWidgetType.BAR_CHART,
                    dataset_id=None,
                    config={"placeholderKind": "visualization_request"},
                    data_sample=[],
                )
            ],
        ),
        DashboardAssistantResponse(
            message="시각화 요청을 대시보드에 적용했습니다.",
            actions=[],
            warnings=[],
        ),
    )
    assert_true(len(response.actions) == 1, "prompt-bound visualization should produce one action.")
    action = response.actions[0]
    assert_true(action.type == "update_widget", "prompt-bound correction should update the selected request widget.")
    assert_true(action.patch.dataset_id == "ds_customers_clean_analysis", "prompt-mentioned dataset should win over unrelated datasets.")
    assert_true(action.patch.config["xKey"] == "order_date", "prompt-mentioned dimension should be retained.")
    assert_true(action.patch.config["aggregation"] == "count", "고객 수 prompt should use count, not sum.")


def main() -> None:
    verify_dimension_only_count_normalization()
    verify_metric_alias_to_available_column()
    verify_empty_ai_response_gets_fallback_action()
    verify_prompt_bound_visualization_overrides_ai_metric_drift()
    print("Dashboard assistant guard verification passed (4 checks).")


if __name__ == "__main__":
    main()
