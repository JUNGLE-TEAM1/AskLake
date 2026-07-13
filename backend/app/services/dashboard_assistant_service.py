import json
import re
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from app.core.config import Settings
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.dashboard_runtime_repository import DashboardRuntimeRepository
from app.schemas.dashboard import (
    DashboardAssistantCreateWidgetAction,
    DashboardAssistantCreateWidgetInput,
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
    AssistantDatasetContext,
    build_assistant_context,
)
from app.services.dashboard_assistant_guard import (
    coerce_assistant_response,
    guard_assistant_response,
)

OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
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
            guarded_response = _prefer_prompt_bound_visualization_action(request, context, guarded_response)
            guarded_response = _with_visualization_fallback_action(request, context, guarded_response)
            guarded_response = _normalize_visualization_success_message(request, guarded_response)
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
        return DashboardAssistantResponse(
            message="AI Assistant를 사용할 수 없어 요청을 실행하지 않았습니다.",
            actions=[],
            warnings=[*context.warnings, warning],
        )

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
    if re.fullmatch(r"[ㅋㅎㅠㅜㅇㄱㄴㄷㄹㅁㅂㅅㅈㅊㅌㅍ]+", compact):
        return True
    if re.fullmatch(r"(ha|haha|lol|lmao|rofl)+", compact):
        return True
    return False


def _build_low_signal_prompt_response() -> DashboardAssistantResponse:
    return DashboardAssistantResponse(
        message="Nessie가 분석하거나 수정할 요청을 찾지 못했습니다. 어떤 위젯을 어떻게 바꿀지 조금 더 구체적으로 입력해 주세요.",
        actions=[],
        warnings=["의미가 부족한 짧은 입력이라 대시보드 변경을 적용하지 않았습니다."],
    )


def _with_visualization_fallback_action(
    request: DashboardAssistantRequest,
    context: AssistantDashboardContext,
    response: DashboardAssistantResponse,
) -> DashboardAssistantResponse:
    if request.mode != DashboardAssistantMode.VISUALIZATION_REQUEST or response.actions:
        return response

    fallback = _build_deterministic_visualization_action(request, context)
    if fallback is None:
        return response

    guarded_fallback = guard_assistant_response(
        DashboardAssistantResponse(
            message="AI 응답을 대시보드에 바로 적용할 수 없어 요청과 데이터셋 기준으로 기본 차트를 생성했습니다.",
            actions=[fallback],
            warnings=response.warnings,
        ),
        context,
    )
    if not guarded_fallback.actions:
        return response
    return guarded_fallback


def _prefer_prompt_bound_visualization_action(
    request: DashboardAssistantRequest,
    context: AssistantDashboardContext,
    response: DashboardAssistantResponse,
) -> DashboardAssistantResponse:
    if request.mode != DashboardAssistantMode.VISUALIZATION_REQUEST:
        return response
    if not _prompt_has_bound_visualization_intent(request.prompt, context.datasets):
        return response

    prompt_action = _build_deterministic_visualization_action(request, context)
    if prompt_action is None:
        return response

    guarded_prompt_response = guard_assistant_response(
        DashboardAssistantResponse(
            message=response.message,
            actions=[prompt_action],
            warnings=[
                *response.warnings,
                "사용자 프롬프트의 데이터셋/컬럼/집계 의도를 우선 적용했습니다.",
            ],
        ),
        context,
    )
    if not guarded_prompt_response.actions:
        return response
    return guarded_prompt_response


def _normalize_visualization_success_message(
    request: DashboardAssistantRequest,
    response: DashboardAssistantResponse,
) -> DashboardAssistantResponse:
    if request.mode != DashboardAssistantMode.VISUALIZATION_REQUEST or not response.actions:
        return response
    if any(action.type in {"create_widget", "update_widget"} for action in response.actions):
        response.message = "시각화 요청을 대시보드에 적용했습니다."
    return response


def _build_deterministic_visualization_action(
    request: DashboardAssistantRequest,
    context: AssistantDashboardContext,
) -> DashboardAssistantCreateWidgetAction | DashboardAssistantUpdateWidgetAction | None:
    dataset = _select_fallback_dataset(request.prompt, context.datasets)
    if dataset is None:
        return None

    config = _build_fallback_bar_config(request.prompt, dataset)
    if config is None:
        return None

    title = _fallback_chart_title(config)
    target_widget = _find_target_widget(request, context)
    patch = DashboardAssistantWidgetPatch(
        title=title,
        type="bar_chart",
        dataset_id=dataset.id,
        config=config,
    )
    if target_widget is not None:
        return DashboardAssistantUpdateWidgetAction(widget_id=target_widget.id, patch=patch)

    return DashboardAssistantCreateWidgetAction(
        widget=DashboardAssistantCreateWidgetInput(
            title=title,
            type="bar_chart",
            dataset_id=dataset.id,
            config=config,
        ),
    )


def _select_fallback_dataset(prompt: str, datasets: list[AssistantDatasetContext]) -> AssistantDatasetContext | None:
    if not datasets:
        return None

    prompt_tokens = _prompt_tokens(prompt)
    normalized_prompt = _normalize_token(prompt)

    def score(dataset: AssistantDatasetContext) -> tuple[int, int, int]:
        dataset_bonus = _dataset_prompt_match_score(dataset, normalized_prompt)
        column_names = {column.name for column in dataset.columns}
        matched_columns = len(prompt_tokens & {_normalize_token(column_name) for column_name in column_names})
        metric_bonus = 1 if _preferred_metric_column(prompt, dataset) else 0
        default_bonus = 1 if _default_dimension_column(dataset) else 0
        return (dataset_bonus, matched_columns, metric_bonus + default_bonus)

    return max(datasets, key=score)


def _build_fallback_bar_config(prompt: str, dataset: AssistantDatasetContext) -> dict[str, Any] | None:
    prompt_tokens = _prompt_tokens(prompt)
    mentioned_columns = [
        column.name
        for column in dataset.columns
        if _normalize_token(column.name) in prompt_tokens
    ]
    metric_column = _preferred_metric_column(prompt, dataset) if _prompt_requests_metric(prompt) and not _prompt_requests_count(prompt) else None
    dimension_columns = [
        column_name
        for column_name in mentioned_columns
        if column_name != metric_column
    ]
    x_key = _preferred_dimension_column(dimension_columns, dataset)
    if x_key is None:
        return None

    if metric_column is not None:
        return {
            "body": _metric_body_label(metric_column),
            "description": f"{x_key} 기준 {_metric_body_label(metric_column)}를 보여주는 막대 차트입니다.",
            "aggregation": "sum",
            "color": {"colors": ["#2563eb"]},
            "xKey": x_key,
            "yKey": metric_column,
            "groupKey": _secondary_dimension_column(dimension_columns, x_key),
            "orientation": "vertical",
        }

    y_key = _secondary_dimension_column(dimension_columns, x_key) or x_key
    return {
        "body": "건수",
        "description": f"{x_key} 기준 건수를 보여주는 막대 차트입니다.",
        "aggregation": "count",
        "color": {"colors": ["#2563eb"]},
        "xKey": x_key,
        "yKey": y_key,
        "groupKey": _secondary_dimension_column(dimension_columns, x_key),
        "orientation": "vertical",
    }


def _preferred_metric_column(prompt: str, dataset: AssistantDatasetContext) -> str | None:
    wants_revenue = _prompt_requests_metric(prompt)
    candidates = (
        ["revenue", "total_amount", "amount", "sales", "orders", "customers"]
        if wants_revenue
        else ["revenue", "total_amount", "orders", "customers", "amount"]
    )
    return _first_existing_numeric_column(dataset, candidates) or _first_numeric_column(dataset)


def _prompt_has_bound_visualization_intent(prompt: str, datasets: list[AssistantDatasetContext]) -> bool:
    prompt_tokens = _prompt_tokens(prompt)
    normalized_prompt = _normalize_token(prompt)
    if _prompt_requests_count(prompt):
        return True
    for dataset in datasets:
        dataset_terms = [
            _normalize_token(dataset.id),
            _normalize_token(dataset.name),
        ]
        if any(term and term in normalized_prompt for term in dataset_terms):
            return True
        if prompt_tokens & {_normalize_token(column.name) for column in dataset.columns}:
            return True
    return False


def _dataset_prompt_match_score(dataset: AssistantDatasetContext, normalized_prompt: str) -> int:
    full_terms = [
        _normalize_token(dataset.id),
        _normalize_token(dataset.name),
    ]
    if any(term and term in normalized_prompt for term in full_terms):
        return 6

    split_terms = {
        _normalize_token(part)
        for value in [dataset.id, dataset.name]
        for part in re.split(r"[_\\s-]+", value)
        if _normalize_token(part)
    }
    return min(sum(1 for term in split_terms if term in normalized_prompt), 2)


def _prompt_requests_metric(prompt: str) -> bool:
    prompt_text = prompt.lower()
    return any(token in prompt_text for token in ["매출", "금액", "수량", "revenue", "sales", "amount"])


def _prompt_requests_count(prompt: str) -> bool:
    normalized = _normalize_token(prompt)
    prompt_text = prompt.lower()
    return (
        any(token in prompt_text for token in ["건수", "개수", "고객 수", "주문 수", "count"])
        or any(token in normalized for token in ["고객수", "주문수", "rowcount", "count"])
    )


def _preferred_dimension_column(mentioned_columns: list[str], dataset: AssistantDatasetContext) -> str | None:
    for column_name in mentioned_columns:
        if not _column_is_numeric(dataset, column_name):
            return column_name
    return _default_dimension_column(dataset)


def _secondary_dimension_column(mentioned_columns: list[str], x_key: str) -> str | None:
    for column_name in mentioned_columns:
        if column_name != x_key:
            return column_name
    return None


def _default_dimension_column(dataset: AssistantDatasetContext) -> str | None:
    for column in dataset.columns:
        name = column.name.lower()
        if any(token in name for token in ["date", "month", "year", "time"]):
            return column.name
    for column in dataset.columns:
        if not _column_is_numeric(dataset, column.name):
            return column.name
    return dataset.columns[0].name if dataset.columns else None


def _first_existing_numeric_column(dataset: AssistantDatasetContext, candidates: list[str]) -> str | None:
    columns = {column.name: column for column in dataset.columns}
    normalized_columns = {_normalize_token(column.name): column.name for column in dataset.columns}
    for candidate in candidates:
        column_name = columns.get(candidate)
        if column_name is not None and _column_is_numeric(dataset, candidate):
            return candidate
        normalized_match = normalized_columns.get(_normalize_token(candidate))
        if normalized_match and _column_is_numeric(dataset, normalized_match):
            return normalized_match
    return None


def _first_numeric_column(dataset: AssistantDatasetContext) -> str | None:
    for column in dataset.columns:
        if _column_is_numeric(dataset, column.name):
            return column.name
    return None


def _column_is_numeric(dataset: AssistantDatasetContext, column_name: str) -> bool:
    column = next((item for item in dataset.columns if item.name == column_name), None)
    if column is None:
        return False
    normalized_type = column.type.strip().lower()
    if any(hint in normalized_type for hint in ["bigint", "decimal", "double", "float", "int", "integer", "long", "number", "numeric", "real"]):
        return True
    sample_values = [
        row.get(column_name)
        for row in dataset.sample_rows
        if isinstance(row, dict) and row.get(column_name) not in {None, ""}
    ]
    return bool(sample_values) and all(_can_parse_float(value) for value in sample_values[:10])


def _can_parse_float(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int | float):
        return True
    if not isinstance(value, str):
        return False
    try:
        float(value.strip().replace(",", ""))
    except ValueError:
        return False
    return True


def _prompt_tokens(prompt: str) -> set[str]:
    return {
        _normalize_token(token)
        for token in re.split(r"[^0-9A-Za-z_가-힣]+", prompt)
        if _normalize_token(token)
    }


def _normalize_token(value: str) -> str:
    return "".join(character for character in value.lower() if character.isalnum())


def _metric_body_label(column_name: str) -> str:
    if column_name in {"revenue", "total_amount", "amount", "sales"}:
        return "매출액"
    if column_name in {"orders", "order_count"}:
        return "주문 수"
    if column_name in {"customers", "customer_count"}:
        return "고객 수"
    return column_name


def _fallback_chart_title(config: dict[str, Any]) -> str:
    metric = _metric_body_label(str(config.get("yKey") or "건수")) if config.get("aggregation") != "count" else "건수"
    x_key = str(config.get("xKey") or "기준")
    group_key = config.get("groupKey")
    dimension = f"{x_key}·{group_key}" if group_key else x_key
    return f"{dimension}별 {metric} 막대 차트"


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
        f"- 대시보드에서 사용할 수 있는 데이터셋 수: {len(context.datasets)}개\n\n"
        "OpenAI 호출이 준비되지 않아 mock fallback 리포트를 반환했습니다."
    )

    return DashboardAssistantResponse(
        message="mock fallback 응답입니다. 실제 분석 답변 대신 현재 컨텍스트 요약을 반환했습니다.",
        actions=[DashboardAssistantReportAction(markdown=markdown)],
        warnings=[],
    )
