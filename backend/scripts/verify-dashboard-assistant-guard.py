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


def visualization_request() -> DashboardAssistantRequest:
    return DashboardAssistantRequest(
        mode=DashboardAssistantMode.VISUALIZATION_REQUEST,
        prompt="region별 주문 수 막대 차트를 만들어줘",
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


def verify_empty_visualization_response_fails_closed() -> None:
    response = _require_visualization_action(
        visualization_request(),
        DashboardAssistantResponse(
            message="AI 응답에 적용 가능한 변경이 없습니다.",
            actions=[],
            warnings=[],
        ),
    )

    assert_true(response.actions == [], "empty visualization response must not synthesize a local chart.")
    assert_true("수정하지 않았습니다" in response.message, "empty visualization response should explain fail-closed behavior.")
    assert_true(any("action" in warning for warning in response.warnings), "missing mutation action should be retained as a warning.")


def verify_single_visualization_action_is_preserved() -> None:
    response = _require_visualization_action(
        visualization_request(),
        DashboardAssistantResponse.model_validate({
            "message": "시각화 변경을 생성했습니다.",
            "actions": [{
                "type": "update_widget",
                "widgetId": "widget_test",
                "patch": {"title": "지역별 주문 수"},
                "usedEvidenceIds": [],
            }],
            "warnings": [],
        }),
    )

    assert_true(len(response.actions) == 1, "one visualization mutation action should be preserved.")
    assert_true(response.actions[0].type == "update_widget", "the preserved action should keep its mutation type.")


def verify_multiple_visualization_actions_fail_closed() -> None:
    response = _require_visualization_action(
        visualization_request(),
        DashboardAssistantResponse.model_validate({
            "message": "여러 변경을 생성했습니다.",
            "actions": [
                {
                    "type": "update_widget",
                    "widgetId": "widget_test",
                    "patch": {"title": "지역별 주문 수"},
                    "usedEvidenceIds": [],
                },
                {
                    "type": "update_widget",
                    "widgetId": "widget_test",
                    "patch": {"title": "지역 주문 현황"},
                    "usedEvidenceIds": [],
                },
            ],
            "warnings": [],
        }),
    )

    assert_true(response.actions == [], "multiple visualization mutation actions must fail closed.")
    assert_true(any("여러" in warning for warning in response.warnings), "multiple mutation actions should produce an explicit warning.")


def verify_dashboard_question_drops_mutation_actions() -> None:
    request = DashboardAssistantRequest(
        mode=DashboardAssistantMode.DASHBOARD_QUESTION,
        prompt="현재 대시보드를 요약해줘",
    )
    response = _require_visualization_action(
        request,
        DashboardAssistantResponse.model_validate({
            "message": "질문에 답했습니다.",
            "actions": [{
                "type": "update_widget",
                "widgetId": "widget_test",
                "patch": {"title": "변경하면 안 됨"},
                "usedEvidenceIds": ["mutation-evidence"],
            }],
            "usedEvidenceIds": ["mutation-evidence"],
            "warnings": [],
        }),
    )

    assert_true(response.actions == [], "dashboard questions must not retain widget mutation actions.")
    assert_true(response.used_evidence_ids == [], "removed mutation actions must not retain mutation evidence.")


def main() -> None:
    verify_dimension_only_count_normalization()
    verify_metric_alias_to_available_column()
    verify_empty_visualization_response_fails_closed()
    verify_single_visualization_action_is_preserved()
    verify_multiple_visualization_actions_fail_closed()
    verify_dashboard_question_drops_mutation_actions()
    print("Dashboard assistant guard verification passed (6 checks).")


if __name__ == "__main__":
    main()
