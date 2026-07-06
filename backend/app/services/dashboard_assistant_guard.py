from typing import Any

from pydantic import ValidationError

from app.schemas.dashboard import (
    AreaChartWidgetConfig,
    BarChartWidgetConfig,
    DashboardAssistantCreateWidgetAction,
    DashboardAssistantReportAction,
    DashboardAssistantResponse,
    DashboardAssistantUpdateWidgetAction,
    DashboardAssistantWidgetPatch,
    DashboardRuntimeWidgetType,
    DonutChartWidgetConfig,
    HeatmapChartWidgetConfig,
    LineChartWidgetConfig,
    MetricWidgetConfig,
    PieChartWidgetConfig,
    RadialBarChartWidgetConfig,
    TableWidgetConfig,
    TreemapChartWidgetConfig,
)
from app.services.dashboard_assistant_context import (
    AssistantDashboardContext,
    AssistantDatasetContext,
    AssistantWidgetContext,
)
from app.services.dashboard_assistant_options import WIDGET_OPTIONS


CONFIG_MODEL_BY_TYPE = {
    DashboardRuntimeWidgetType.METRIC: MetricWidgetConfig,
    DashboardRuntimeWidgetType.TABLE: TableWidgetConfig,
    DashboardRuntimeWidgetType.BAR_CHART: BarChartWidgetConfig,
    DashboardRuntimeWidgetType.LINE_CHART: LineChartWidgetConfig,
    DashboardRuntimeWidgetType.AREA_CHART: AreaChartWidgetConfig,
    DashboardRuntimeWidgetType.DONUT_CHART: DonutChartWidgetConfig,
    DashboardRuntimeWidgetType.PIE_CHART: PieChartWidgetConfig,
    DashboardRuntimeWidgetType.RADIAL_BAR_CHART: RadialBarChartWidgetConfig,
    DashboardRuntimeWidgetType.HEATMAP_CHART: HeatmapChartWidgetConfig,
    DashboardRuntimeWidgetType.TREEMAP_CHART: TreemapChartWidgetConfig,
}

NUMERIC_TYPE_HINTS = {
    "bigint",
    "decimal",
    "double",
    "float",
    "int",
    "integer",
    "long",
    "number",
    "numeric",
    "real",
}


def coerce_assistant_response(payload: dict[str, Any]) -> DashboardAssistantResponse:
    warnings = _string_list(payload.get("warnings"))
    actions: list[
        DashboardAssistantCreateWidgetAction
        | DashboardAssistantUpdateWidgetAction
        | DashboardAssistantReportAction
    ] = []

    for raw_action in payload.get("actions") or []:
        if not isinstance(raw_action, dict):
            warnings.append("Assistant action이 object가 아니어서 제외했습니다.")
            continue
        action_type = raw_action.get("type")
        try:
            if action_type == "create_widget":
                actions.append(DashboardAssistantCreateWidgetAction.model_validate(raw_action))
            elif action_type == "update_widget":
                raw_action = _normalize_update_widget_action(raw_action)
                actions.append(DashboardAssistantUpdateWidgetAction.model_validate(raw_action))
            elif action_type == "report":
                actions.append(DashboardAssistantReportAction.model_validate(raw_action))
            else:
                warnings.append(f"지원하지 않는 action type {action_type!r}을 제외했습니다.")
        except ValidationError as exc:
            warnings.append(f"{action_type or 'unknown'} action이 계약과 맞지 않아 제외했습니다: {exc.errors()[0]['msg']}")

    return DashboardAssistantResponse(
        message=str(payload.get("message") or "Assistant 응답을 받았습니다."),
        actions=actions,
        warnings=warnings,
    )


def _normalize_update_widget_action(raw_action: dict[str, Any]) -> dict[str, Any]:
    if isinstance(raw_action.get("patch"), dict):
        return raw_action

    widget = raw_action.get("widget")
    if not isinstance(widget, dict):
        return raw_action

    patch = {
        "title": widget.get("title"),
        "type": widget.get("type"),
        "datasetId": widget.get("datasetId"),
        "config": widget.get("config"),
    }
    return {
        **raw_action,
        "patch": {
            key: value
            for key, value in patch.items()
            if value is not None
        },
    }


def guard_assistant_response(
    response: DashboardAssistantResponse,
    context: AssistantDashboardContext,
) -> DashboardAssistantResponse:
    guarded_actions: list[
        DashboardAssistantCreateWidgetAction
        | DashboardAssistantUpdateWidgetAction
        | DashboardAssistantReportAction
    ] = []
    warnings = [*response.warnings]
    datasets = context.dataset_by_id()
    widgets = context.widget_by_id()

    for action in response.actions:
        if isinstance(action, DashboardAssistantReportAction):
            if action.markdown.strip():
                guarded_actions.append(action)
            else:
                warnings.append("비어 있는 report action을 제외했습니다.")
            continue

        if isinstance(action, DashboardAssistantCreateWidgetAction):
            checked_action, action_warnings = _guard_create_widget_action(action, datasets)
            warnings.extend(action_warnings)
            if checked_action is not None:
                guarded_actions.append(checked_action)
            continue

        if isinstance(action, DashboardAssistantUpdateWidgetAction):
            checked_action, action_warnings = _guard_update_widget_action(action, widgets, datasets)
            warnings.extend(action_warnings)
            if checked_action is not None:
                guarded_actions.append(checked_action)

    message = response.message
    if response.actions and not guarded_actions and warnings:
        message = "AI 응답은 받았지만 대시보드에 적용 가능한 위젯 변경사항이 없었습니다."

    return DashboardAssistantResponse(
        message=message,
        actions=guarded_actions,
        warnings=warnings,
        config_patch=_config_patch_from_actions(guarded_actions),
        widget_patch=_widget_patch_from_actions(guarded_actions),
    )


def _guard_create_widget_action(
    action: DashboardAssistantCreateWidgetAction,
    datasets: dict[str, AssistantDatasetContext],
) -> tuple[DashboardAssistantCreateWidgetAction | None, list[str]]:
    dataset = datasets.get(action.widget.dataset_id)
    if dataset is None:
        return None, [f"create_widget datasetId {action.widget.dataset_id!r}는 접근 가능한 GOLD 데이터셋이 아니어서 제외했습니다."]
    widget_type = _widget_type_enum(action.widget.type)
    config, warnings = _validate_config(widget_type, action.widget.config, dataset)
    if config is None:
        return None, warnings
    action.widget.config = config
    return action, warnings


def _guard_update_widget_action(
    action: DashboardAssistantUpdateWidgetAction,
    widgets: dict[str, AssistantWidgetContext],
    datasets: dict[str, AssistantDatasetContext],
) -> tuple[DashboardAssistantUpdateWidgetAction | None, list[str]]:
    widget = widgets.get(action.widget_id)
    if widget is None:
        return None, [f"update_widget widgetId {action.widget_id!r}는 현재 대시보드 page 위젯이 아니어서 제외했습니다."]

    patch = action.patch
    target_type = _widget_type_enum(patch.type or widget.type)
    dataset_id = patch.dataset_id or widget.dataset_id
    if target_type not in WIDGET_OPTIONS:
        return None, [f"update_widget type {target_type!r}는 지원하지 않는 위젯 타입이어서 제외했습니다."]

    if patch.config is not None:
        if dataset_id is None:
            return None, [f"update_widget {action.widget_id!r}는 datasetId가 없어 config를 검증할 수 없습니다."]
        dataset = datasets.get(dataset_id)
        if dataset is None:
            return None, [f"update_widget datasetId {dataset_id!r}는 접근 가능한 GOLD 데이터셋이 아니어서 제외했습니다."]
        config, warnings = _validate_config(target_type, patch.config, dataset)
        if config is None:
            return None, warnings
        action.patch = DashboardAssistantWidgetPatch(
            title=patch.title,
            type=patch.type,
            dataset_id=patch.dataset_id,
            config=config.model_dump(by_alias=True, exclude_none=True, mode="json"),
        )

    return action, []


def _validate_config(
    widget_type: DashboardRuntimeWidgetType | str,
    config: Any,
    dataset: AssistantDatasetContext,
) -> tuple[Any | None, list[str]]:
    widget_type = _widget_type_enum(widget_type)
    if widget_type not in WIDGET_OPTIONS:
        return None, [f"{widget_type!r}는 지원하지 않는 위젯 타입입니다."]

    config_payload = _config_to_dict(config)
    if widget_type in {DashboardRuntimeWidgetType.METRIC, DashboardRuntimeWidgetType.TABLE} and "color" in config_payload:
        return None, [f"{widget_type.value} config에는 color를 사용할 수 없습니다."]

    config_model = CONFIG_MODEL_BY_TYPE[widget_type]
    try:
        parsed_config = config_model.model_validate(config_payload)
    except ValidationError as exc:
        return None, [f"{widget_type.value} config가 계약과 맞지 않습니다: {exc.errors()[0]['msg']}"]

    warnings = _validate_columns(widget_type, parsed_config.model_dump(by_alias=True, exclude_none=True), dataset)
    if warnings:
        return None, warnings
    return parsed_config, []


def _widget_type_enum(value: DashboardRuntimeWidgetType | str) -> DashboardRuntimeWidgetType:
    return value if isinstance(value, DashboardRuntimeWidgetType) else DashboardRuntimeWidgetType(value)


def _validate_columns(
    widget_type: DashboardRuntimeWidgetType,
    config: dict[str, Any],
    dataset: AssistantDatasetContext,
) -> list[str]:
    columns = {column.name: column for column in dataset.columns}
    option = WIDGET_OPTIONS[widget_type]
    warnings: list[str] = []

    for field_name in [*option["required"], *option["optional"]]:
        value = config.get(field_name)
        if value is None:
            continue
        if field_name == "columns":
            values = value if isinstance(value, list) else []
        elif field_name.endswith("Key"):
            values = [value]
        else:
            continue
        for column_name in values:
            if column_name not in columns:
                warnings.append(f"{widget_type.value} config의 {field_name}={column_name!r} 컬럼이 데이터셋 {dataset.id!r}에 없습니다.")

    for numeric_field in option["numeric"]:
        column_name = config.get(numeric_field)
        if not isinstance(column_name, str) or column_name not in columns:
            continue
        if not _is_numeric_column(columns[column_name].type):
            warnings.append(f"{widget_type.value} config의 {numeric_field}={column_name!r} 컬럼은 숫자형이 아닙니다.")

    return warnings


def _is_numeric_column(column_type: str) -> bool:
    normalized = column_type.strip().lower()
    return any(hint in normalized for hint in NUMERIC_TYPE_HINTS)


def _config_to_dict(config: Any) -> dict[str, Any]:
    if hasattr(config, "model_dump"):
        return config.model_dump(by_alias=True, exclude_none=True, mode="json")
    if isinstance(config, dict):
        return dict(config)
    return {}


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if str(item).strip()]


def _config_patch_from_actions(actions: list[Any]) -> dict[str, Any] | None:
    for action in actions:
        if isinstance(action, DashboardAssistantUpdateWidgetAction) and action.patch.config:
            return action.patch.config
    return None


def _widget_patch_from_actions(actions: list[Any]) -> DashboardAssistantWidgetPatch | None:
    for action in actions:
        if isinstance(action, DashboardAssistantUpdateWidgetAction):
            return action.patch
    return None
