from fastapi import APIRouter

from app.schemas.dashboard import (
    DashboardAssistantReportAction,
    DashboardAssistantRequest,
    DashboardAssistantResponse,
    DashboardAssistantUpdateWidgetAction,
    DashboardAssistantWidgetContext,
    DashboardAssistantWidgetPatch,
    DashboardAssistantMode,
)

router = APIRouter(prefix="/dashboards", tags=["dashboard-assistant"])


def _find_target_widget(request: DashboardAssistantRequest) -> DashboardAssistantWidgetContext | None:
    target_widget_id = request.widget_id or request.selected_widget_id
    if not target_widget_id:
        return request.widgets[0] if request.widgets else None

    return next((widget for widget in request.widgets if widget.id == target_widget_id), None)


def _build_visualization_response(request: DashboardAssistantRequest) -> DashboardAssistantResponse:
    target_widget = _find_target_widget(request)
    warnings: list[str] = []
    if not target_widget:
        warnings.append("위젯 컨텍스트가 없어 mock action을 만들지 못했습니다.")
        return DashboardAssistantResponse(
            message="Assistant mock endpoint가 요청을 받았습니다. 위젯 컨텍스트를 함께 보내면 수정 action을 반환할 수 있습니다.",
            warnings=warnings,
        )

    config_patch = {
        "description": "Assistant mock 응답으로 생성한 시각화 설명입니다.",
        "prompt": request.prompt,
    }
    widget_patch = DashboardAssistantWidgetPatch(
        title=target_widget.title or "AI 추천 시각화",
        config=config_patch,
    )

    return DashboardAssistantResponse(
        message="Assistant mock endpoint가 시각화 요청을 받았습니다. 실제 OpenAI 연결은 후속 작업에서 진행합니다.",
        actions=[
            DashboardAssistantUpdateWidgetAction(
                widget_id=target_widget.id,
                patch=widget_patch,
            ),
        ],
        config_patch=config_patch,
        widget_patch=widget_patch,
        warnings=warnings,
    )


def _build_dashboard_question_response(request: DashboardAssistantRequest) -> DashboardAssistantResponse:
    target_widget = _find_target_widget(request)
    widget_label = f"`{target_widget.title}`" if target_widget else "현재 대시보드"
    markdown = (
        f"## Assistant mock report\n\n"
        f"- 대상: {widget_label}\n"
        f"- 요청: {request.prompt}\n"
        f"- 위젯 수: {len(request.widgets)}개\n\n"
        "실제 분석/리포트 생성은 OpenAI API 연결 후 이 action에 채워집니다."
    )

    return DashboardAssistantResponse(
        message="Assistant mock endpoint가 질문 요청을 받았습니다. 실제 분석 답변은 후속 OpenAI 연결에서 확장합니다.",
        actions=[DashboardAssistantReportAction(markdown=markdown)],
        warnings=[],
    )


@router.post("/assistant", response_model=DashboardAssistantResponse)
def request_dashboard_assistant(request: DashboardAssistantRequest) -> DashboardAssistantResponse:
    if request.mode == DashboardAssistantMode.VISUALIZATION_REQUEST:
        return _build_visualization_response(request)

    return _build_dashboard_question_response(request)
