import json
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from app.core.config import Settings
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.dashboard_runtime_repository import DashboardRuntimeRepository
from app.schemas.dashboard import (
    DashboardAssistantMode,
    DashboardAssistantReportAction,
    DashboardAssistantRequest,
    DashboardAssistantResponse,
    DashboardAssistantUpdateWidgetAction,
    DashboardAssistantWidgetContext,
    DashboardAssistantWidgetPatch,
)
from app.services.dashboard_assistant_context import (
    AssistantDashboardContext,
    build_assistant_context,
)
from app.services.dashboard_assistant_guard import (
    coerce_assistant_response,
    guard_assistant_response,
)

OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"


class DashboardAssistantService:
    def __init__(
        self,
        runtime_repository: DashboardRuntimeRepository,
        catalog_repository: CatalogRepository,
        settings: Settings,
    ) -> None:
        self.runtime_repository = runtime_repository
        self.catalog_repository = catalog_repository
        self.settings = settings

    def generate_response(self, request: DashboardAssistantRequest) -> DashboardAssistantResponse:
        context = build_assistant_context(
            request,
            self.runtime_repository,
            self.catalog_repository,
            max_sample_rows=self.settings.openai_assistant_max_sample_rows,
        )

        if not self.settings.openai_assistant_enabled:
            return self._mock_fallback_response(request, context, "mock fallback: OpenAI Assistant가 비활성화되어 있습니다.")
        if not self.settings.openai_api_key:
            return self._mock_fallback_response(request, context, "mock fallback: OPENAI_API_KEY가 설정되지 않았습니다.")

        try:
            raw_payload = self._request_openai(request, context)
            coerced_response = coerce_assistant_response(raw_payload)
            guarded_response = guard_assistant_response(coerced_response, context)
            return self._with_context_warnings(guarded_response, context)
        except (HTTPError, URLError, TimeoutError, ValueError, OSError) as exc:
            return self._mock_fallback_response(
                request,
                context,
                f"mock fallback: OpenAI 호출에 실패해 mock 응답을 사용했습니다. ({exc.__class__.__name__})",
            )

    def _request_openai(
        self,
        assistant_request: DashboardAssistantRequest,
        context: AssistantDashboardContext,
    ) -> dict[str, Any]:
        payload = {
            "model": self.settings.openai_assistant_model,
            "instructions": _assistant_instructions(),
            "input": json.dumps(
                {
                    "mode": assistant_request.mode,
                    "prompt": assistant_request.prompt,
                    "selectedWidgetId": assistant_request.selected_widget_id,
                    "widgetId": assistant_request.widget_id,
                    "context": context.to_prompt_payload(),
                },
                ensure_ascii=False,
            ),
            "max_output_tokens": self.settings.openai_assistant_max_output_tokens,
            "store": False,
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "dashboard_assistant_response",
                    "description": "A safe dashboard assistant response containing executable actions only.",
                    "schema": _assistant_response_schema(),
                },
            },
        }
        request = Request(
            OPENAI_RESPONSES_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.settings.openai_api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urlopen(request, timeout=self.settings.openai_assistant_timeout_seconds) as response:
            response_payload = json.loads(response.read().decode("utf-8"))

        if response_payload.get("error"):
            raise ValueError("OpenAI response contained an error")

        output_text = _extract_output_text(response_payload)
        if not output_text:
            raise ValueError("OpenAI response did not include output text")
        parsed = json.loads(output_text)
        if not isinstance(parsed, dict):
            raise ValueError("OpenAI response JSON root was not an object")
        return parsed

    def _mock_fallback_response(
        self,
        request: DashboardAssistantRequest,
        context: AssistantDashboardContext,
        warning: str,
    ) -> DashboardAssistantResponse:
        response = (
            _build_visualization_mock_fallback(request, context)
            if request.mode == DashboardAssistantMode.VISUALIZATION_REQUEST
            else _build_dashboard_question_mock_fallback(request, context)
        )
        response.warnings = [*context.warnings, warning, *response.warnings]
        return response

    @staticmethod
    def _with_context_warnings(
        response: DashboardAssistantResponse,
        context: AssistantDashboardContext,
    ) -> DashboardAssistantResponse:
        response.warnings = [*context.warnings, *response.warnings]
        return response


def _assistant_instructions() -> str:
    return (
        "You are AskLake's dashboard assistant. "
        "You must answer only with JSON that matches the requested schema. "
        "Use only datasets listed in context.availableDatasets. "
        "Use only widgets listed in context.widgets for update_widget actions. "
        "Use only widget types and config fields listed in context.widgetOptions. "
        "Do not invent datasetIds, widgetIds, column names, or chart types. "
        "For dashboard_question, prefer a report action. "
        "For visualization_request, use update_widget when widgetId or selectedWidgetId targets an existing widget; otherwise use create_widget. "
        "Write user-facing message and report markdown in Korean."
    )


def _assistant_response_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "message": {"type": "string"},
            "warnings": {
                "type": "array",
                "items": {"type": "string"},
            },
            "actions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": True,
                    "properties": {
                        "type": {
                            "type": "string",
                            "enum": ["create_widget", "update_widget", "report"],
                        },
                        "widgetId": {"type": "string"},
                        "markdown": {"type": "string"},
                        "widget": {"type": "object"},
                        "patch": {"type": "object"},
                    },
                    "required": ["type"],
                },
            },
        },
        "required": ["message", "actions", "warnings"],
    }


def _extract_output_text(payload: dict[str, Any]) -> str | None:
    output_text = payload.get("output_text")
    if isinstance(output_text, str) and output_text.strip():
        return output_text

    for item in payload.get("output") or []:
        if not isinstance(item, dict):
            continue
        for content in item.get("content") or []:
            if not isinstance(content, dict):
                continue
            if content.get("type") == "output_text" and isinstance(content.get("text"), str):
                return content["text"]
    return None


def _find_target_widget(
    request: DashboardAssistantRequest,
    context: AssistantDashboardContext,
) -> DashboardAssistantWidgetContext | None:
    target_widget_id = request.widget_id or request.selected_widget_id
    request_widgets = {
        widget.id: widget
        for widget in request.widgets
    }
    if target_widget_id and target_widget_id in request_widgets:
        return request_widgets[target_widget_id]
    if request.widgets:
        return request.widgets[0]

    context_widget = (
        context.widget_by_id().get(target_widget_id)
        if target_widget_id
        else (context.widgets[0] if context.widgets else None)
    )
    if context_widget is None:
        return None
    return DashboardAssistantWidgetContext(
        id=context_widget.id,
        title=context_widget.title,
        type=context_widget.type,
        dataset_id=context_widget.dataset_id,
        layout={"x": 0, "y": 0, "w": 4, "h": 3},
        config=context_widget.config,
        data_sample=context_widget.data_sample,
    )


def _build_visualization_mock_fallback(
    request: DashboardAssistantRequest,
    context: AssistantDashboardContext,
) -> DashboardAssistantResponse:
    target_widget = _find_target_widget(request, context)
    warnings: list[str] = []
    if not target_widget:
        warnings.append("mock fallback: 위젯 컨텍스트가 없어 action을 만들지 못했습니다.")
        return DashboardAssistantResponse(
            message="mock fallback 응답입니다. 위젯 컨텍스트를 함께 보내면 수정 action을 반환할 수 있습니다.",
            warnings=warnings,
        )

    config_patch = {
        "description": "mock fallback 응답으로 생성한 시각화 설명입니다.",
        "prompt": request.prompt,
    }
    widget_patch = DashboardAssistantWidgetPatch(
        title=target_widget.title or "AI 추천 시각화",
        config=config_patch,
    )

    return DashboardAssistantResponse(
        message="mock fallback 응답입니다. OpenAI 응답 대신 기존 위젯 설정을 일부 보강했습니다.",
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


def _build_dashboard_question_mock_fallback(
    request: DashboardAssistantRequest,
    context: AssistantDashboardContext,
) -> DashboardAssistantResponse:
    target_widget = _find_target_widget(request, context)
    widget_label = f"`{target_widget.title}`" if target_widget else "현재 대시보드"
    markdown = (
        "## mock fallback report\n\n"
        f"- 대상: {widget_label}\n"
        f"- 요청: {request.prompt}\n"
        f"- 현재 page 위젯 수: {len(context.widgets)}개\n"
        f"- 접근 가능한 GOLD 데이터셋 수: {len(context.datasets)}개\n\n"
        "OpenAI 호출이 준비되지 않아 mock fallback 리포트를 반환했습니다."
    )

    return DashboardAssistantResponse(
        message="mock fallback 응답입니다. 실제 분석 답변 대신 현재 컨텍스트 요약을 반환했습니다.",
        actions=[DashboardAssistantReportAction(markdown=markdown)],
        warnings=[],
    )
