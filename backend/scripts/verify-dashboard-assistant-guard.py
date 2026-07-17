from app.schemas.dashboard import (
    DashboardAssistantMode,
    DashboardAssistantRequest,
    DashboardAssistantResponse,
    DashboardAssistantWidgetContext,
    DashboardRuntimeWidgetType,
)
from app.services.dashboard_assistant_context import (
    AssistantColumnContext,
    AssistantDatasetContext,
)
from app.services.dashboard_assistant_guard import _validate_config
from app.services.dashboard_assistant_service import _require_visualization_action


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


def verify_empty_ai_response_fails_closed() -> None:
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
    response = _require_visualization_action(
        request,
        DashboardAssistantResponse(
            message="AI 응답은 받았지만 대시보드에 적용 가능한 위젯 변경사항이 없었습니다.",
            actions=[],
            warnings=[],
        ),
    )
    assert_true(response.actions == [], "empty visualization AI response must not synthesize a local chart.")
    assert_true("수정하지 않았습니다" in response.message, "empty AI action must be reported as not applied.")
    assert_true(any("action" in warning for warning in response.warnings), "missing AI action must remain visible.")


def main() -> None:
    verify_dimension_only_count_normalization()
    verify_metric_alias_to_available_column()
    verify_empty_ai_response_fails_closed()
    print("Dashboard assistant guard verification passed (3 checks).")


if __name__ == "__main__":
    main()
