import json
import re
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
    DashboardRuntimeWidgetType,
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
CHART_COLOR_ROTATION = ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#7c3aed", "#0891b2"]
COLOR_NAME_TO_HEX = {
    "blue": "#2563eb",
    "green": "#16a34a",
    "yellow": "#f59e0b",
    "orange": "#f97316",
    "red": "#dc2626",
    "purple": "#7c3aed",
    "pink": "#db2777",
    "cyan": "#0891b2",
    "black": "#111827",
    "gray": "#64748b",
    "grey": "#64748b",
    "파란": "#2563eb",
    "파랑": "#2563eb",
    "초록": "#16a34a",
    "녹색": "#16a34a",
    "노란": "#f59e0b",
    "노랑": "#f59e0b",
    "주황": "#f97316",
    "빨간": "#dc2626",
    "빨강": "#dc2626",
    "붉은": "#dc2626",
    "보라": "#7c3aed",
    "분홍": "#db2777",
    "핑크": "#db2777",
    "하늘": "#0891b2",
    "검정": "#111827",
    "검은": "#111827",
    "회색": "#64748b",
}
LOW_SIGNAL_PROMPTS = {"ㅋ", "ㅋㅋ", "ㅋㅋㅋ", "ㅎㅎ", "ㅎㅎㅎ", "ㅇㅋ", "ㅇㅇ", "ㄴㄴ", "lol", "haha", "hehe", "ok", "okay"}


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

        if _is_low_signal_prompt(request.prompt):
            return _build_low_signal_prompt_response()

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
        should_mutate_widget = (
            request.mode == DashboardAssistantMode.VISUALIZATION_REQUEST
            or _looks_like_widget_mutation_request(request.prompt)
        )
        response = (
            _build_visualization_mock_fallback(request, context)
            if should_mutate_widget
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
        "If the user prompt is only a casual reaction, laughter, acknowledgement, greeting, or otherwise lacks an analysis or widget-change request, return a short Korean clarification message with no actions. "
        "For dashboard_question, prefer a report action. "
        "For visualization_request, use update_widget when widgetId or selectedWidgetId targets an existing widget; otherwise use create_widget. "
        "Widget style edits are supported for chart widgets through config.color.colors; if the user asks to change line, bar, pie, or chart colors, return an update_widget action with a config color patch. "
        "For simple selected-widget edits such as color, title, chart type, aggregation, axis, or table column changes, return update_widget instead of saying the feature is unsupported. "
        "An update_widget config may include only changed fields; the server will merge it with the current widget config before validation. "
        "For update_widget actions, put changed title, type, datasetId, and config under patch, not widget. "
        "For create_widget and visualization_request update_widget actions, always provide a concise Korean widget title. "
        "Derive the title from the selected dataset name, dataset description, tags, column names, sample rows, and the user's request. "
        "Translate English dataset and column names into natural Korean business terms when the meaning is clear, and do not keep placeholder titles such as '시각화 요청', 'AI 추천 위젯', or '제목 없는 위젯'. "
        "If the user asks for a column or dimension that is not available in context.availableDatasets, explain that limitation instead of inventing a column. "
        "Write user-facing message and report markdown in Korean."
    )


def _is_low_signal_prompt(prompt: str) -> bool:
    compact = re.sub(r"\s+", "", prompt.strip().lower())
    if not compact:
        return True
    if compact in LOW_SIGNAL_PROMPTS:
        return True
    if re.fullmatch(r"[ㅋㅎㅠㅜ]+", compact):
        return True
    if re.fullmatch(r"(ha|haha|lol|lmao|rofl)+", compact):
        return True
    return False


def _looks_like_widget_mutation_request(prompt: str) -> bool:
    normalized = prompt.strip().lower()
    return any(
        keyword in normalized
        for keyword in [
            "변경",
            "바꿔",
            "바꾸",
            "수정",
            "적용",
            "색",
            "컬러",
            "color",
            "제목",
            "이름",
            "막대",
            "라인",
            "파이",
            "테이블",
            "합계",
            "평균",
            "집계",
            "count",
            "avg",
            "sum",
            "aggregation",
            "그려",
            "만들",
            "생성",
            "추가",
        ]
    )


def _build_low_signal_prompt_response() -> DashboardAssistantResponse:
    return DashboardAssistantResponse(
        message="Nessie가 분석하거나 수정할 요청을 찾지 못했습니다. 어떤 위젯을 어떻게 바꿀지 조금 더 구체적으로 입력해 주세요.",
        actions=[],
        warnings=["의미가 부족한 짧은 입력이라 대시보드 변경을 적용하지 않았습니다."],
    )


def _assistant_response_schema() -> dict[str, Any]:
    string_array_schema = {
        "type": "array",
        "items": {"type": "string"},
    }
    nullable_string = {"type": ["string", "null"]}
    nullable_number = {"type": ["number", "null"]}
    nullable_integer = {"type": ["integer", "null"]}
    nullable_boolean = {"type": ["boolean", "null"]}
    nullable_string_array = {
        "type": ["array", "null"],
        "items": {"type": "string"},
    }
    color_schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "colors": nullable_string_array,
            "paletteId": nullable_string,
            "customColors": nullable_string_array,
        },
        "required": ["colors", "paletteId", "customColors"],
    }
    config_schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "aggregation": {"type": ["string", "null"], "enum": ["sum", "avg", "count", "min", "max", None]},
            "body": nullable_string,
            "centerLabel": nullable_string,
            "color": {"anyOf": [color_schema, {"type": "null"}]},
            "columns": nullable_string_array,
            "curve": {"type": ["string", "null"], "enum": ["smooth", "straight", "stepline", None]},
            "dateUnit": {"type": ["string", "null"], "enum": ["day", "month", "year", None]},
            "description": nullable_string,
            "error": nullable_string,
            "errorMessage": nullable_string,
            "format": {"type": ["string", "null"], "enum": ["number", "currency", "percent", None]},
            "groupKey": nullable_string,
            "labelKey": nullable_string,
            "limit": nullable_integer,
            "max": nullable_number,
            "min": nullable_number,
            "orientation": {"type": ["string", "null"], "enum": ["vertical", "horizontal", None]},
            "placeholderKind": nullable_string,
            "prompt": nullable_string,
            "seriesKey": nullable_string,
            "sortDirection": {"type": ["string", "null"], "enum": ["asc", "desc", None]},
            "sortKey": nullable_string,
            "stacked": nullable_boolean,
            "valueKey": nullable_string,
            "xKey": nullable_string,
            "yKey": nullable_string,
        },
    }
    config_schema["required"] = list(config_schema["properties"].keys())
    widget_schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "title": nullable_string,
            "type": {
                "type": ["string", "null"],
                "enum": [
                    "metric",
                    "table",
                    "bar_chart",
                    "line_chart",
                    "area_chart",
                    "donut_chart",
                    "pie_chart",
                    "radial_bar_chart",
                    "heatmap_chart",
                    "treemap_chart",
                    None,
                ],
            },
            "datasetId": nullable_string,
            "config": {"anyOf": [config_schema, {"type": "null"}]},
        },
        "required": ["title", "type", "datasetId", "config"],
    }
    patch_schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "title": {"type": "string"},
            "type": widget_schema["properties"]["type"],
            "datasetId": {"type": "string"},
            "config": config_schema,
        },
        "required": ["title", "type", "datasetId", "config"],
    }
    patch_schema["properties"]["title"] = nullable_string
    patch_schema["properties"]["datasetId"] = nullable_string
    patch_schema["properties"]["config"] = {"anyOf": [config_schema, {"type": "null"}]}
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
                    "additionalProperties": False,
                    "properties": {
                        "type": {
                            "type": "string",
                            "enum": ["create_widget", "update_widget", "report"],
                        },
                        "widgetId": nullable_string,
                        "markdown": nullable_string,
                        "widget": {"anyOf": [widget_schema, {"type": "null"}]},
                        "patch": {"anyOf": [patch_schema, {"type": "null"}]},
                    },
                    "required": ["type", "widgetId", "markdown", "widget", "patch"],
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
    if target_widget_id:
        if target_widget_id in request_widgets:
            return request_widgets[target_widget_id]

        context_widget = context.widget_by_id().get(target_widget_id)
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

    if request.widgets:
        return request.widgets[0]

    context_widget = (
        context.widgets[0]
        if context.widgets
        else None
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
    color_patch = _color_patch_from_prompt(request.prompt, target_widget)
    if color_patch:
        config_patch["color"] = {"colors": color_patch}
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


def _color_patch_from_prompt(
    prompt: str,
    target_widget: DashboardAssistantWidgetContext,
) -> list[str] | None:
    if target_widget.type in {DashboardRuntimeWidgetType.METRIC, DashboardRuntimeWidgetType.TABLE}:
        return None
    normalized = prompt.strip().lower()
    if "색" not in normalized and "컬러" not in normalized and "color" not in normalized:
        return None

    requested_color = _requested_color_from_prompt(normalized)
    current_colors = _current_widget_colors(target_widget)
    if requested_color:
        return _replace_first_color(current_colors, requested_color)
    return _rotate_chart_colors(current_colors)


def _requested_color_from_prompt(prompt: str) -> str | None:
    match = re.search(r"#[0-9a-fA-F]{6}\b", prompt)
    if match:
        return match.group(0).lower()
    for color_name, color_value in COLOR_NAME_TO_HEX.items():
        if color_name in prompt:
            return color_value
    return None


def _current_widget_colors(target_widget: DashboardAssistantWidgetContext) -> list[str]:
    color = target_widget.config.get("color") if isinstance(target_widget.config, dict) else None
    if isinstance(color, dict):
        colors = [
            item
            for item in color.get("colors", [])
            if isinstance(item, str) and item.strip()
        ]
        if colors:
            return colors
    return [CHART_COLOR_ROTATION[0]]


def _replace_first_color(current_colors: list[str], next_color: str) -> list[str]:
    colors = list(current_colors) or [CHART_COLOR_ROTATION[0]]
    colors[0] = next_color
    return colors


def _rotate_chart_colors(current_colors: list[str]) -> list[str]:
    colors = list(current_colors) or [CHART_COLOR_ROTATION[0]]
    current_primary = colors[0].lower()
    next_primary = next(
        (color for color in CHART_COLOR_ROTATION if color.lower() != current_primary),
        CHART_COLOR_ROTATION[0],
    )
    colors[0] = next_primary
    return colors


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
        f"- 대시보드에서 사용할 수 있는 데이터셋 수: {len(context.datasets)}개\n\n"
        "OpenAI 호출이 준비되지 않아 mock fallback 리포트를 반환했습니다."
    )

    return DashboardAssistantResponse(
        message="mock fallback 응답입니다. 실제 분석 답변 대신 현재 컨텍스트 요약을 반환했습니다.",
        actions=[DashboardAssistantReportAction(markdown=markdown)],
        warnings=[],
    )
