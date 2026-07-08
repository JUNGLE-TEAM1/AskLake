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

PLACEHOLDER_TITLES = {
    "ai 추천 위젯",
    "logistics cost overview",
    "shipment performance",
    "inventory status",
    "시각화 요청",
    "제목 없는 위젯",
}

COLUMN_TITLE_TERMS = {
    "avg_lead_time_days": "평균 리드타임",
    "carrier": "운송사",
    "customer_id": "고객",
    "destination_region": "도착 지역",
    "inventory_value": "재고 금액",
    "month": "월",
    "on_time_rate": "정시 배송률",
    "order_date": "주문일",
    "region": "지역",
    "service_level": "서비스 등급",
    "ship_date": "배송일",
    "shipment_count": "배송 건수",
    "sku_category": "상품군",
    "snapshot_date": "스냅샷 일자",
    "status": "상태",
    "stock_quantity": "재고 수량",
    "stockout_risk_count": "품절 위험 수량",
    "total_amount": "총 주문 금액",
    "total_cost": "총 물류비",
    "transport_cost": "운송비",
    "warehouse": "창고",
    "warehouse_cost": "창고비",
}

DATASET_TITLE_TERMS = {
    "gold_inventory_status": "재고 현황",
    "gold_logistics_cost_overview": "물류비",
    "gold_shipment_performance": "배송 성과",
}

DATASET_NAME_TITLE_TERMS = {
    "inventory status": "재고 현황",
    "logistics cost overview": "물류비",
    "shipment performance": "배송 성과",
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
        return None, [
            f"create_widget datasetId {action.widget.dataset_id!r}는 대시보드에서 사용할 수 있는 데이터셋이 아니어서 제외했습니다. "
            f"사용 가능한 datasetId: {_available_dataset_ids(datasets)}",
        ]
    widget_type = _widget_type_enum(action.widget.type)
    config, warnings = _validate_config(widget_type, action.widget.config, dataset)
    if config is None:
        return None, warnings
    config_payload = config.model_dump(by_alias=True, exclude_none=True, mode="json")
    action.widget.config = config_payload
    action.widget.title = _ensure_korean_widget_title(action.widget.title, widget_type, config_payload, dataset)
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
            return None, [
                f"update_widget datasetId {dataset_id!r}는 대시보드에서 사용할 수 있는 데이터셋이 아니어서 제외했습니다. "
                f"사용 가능한 datasetId: {_available_dataset_ids(datasets)}",
            ]
        candidate_config = _merge_config_patch(widget.config, patch.config)
        config, warnings = _validate_config(target_type, candidate_config, dataset)
        if config is None:
            return None, warnings
        config_payload = config.model_dump(by_alias=True, exclude_none=True, mode="json")
        next_title = patch.title
        if patch.title is not None or widget.config.get("placeholderKind") == "visualization_request":
            next_title = _ensure_korean_widget_title(patch.title or widget.title, target_type, config_payload, dataset)
        action.patch = DashboardAssistantWidgetPatch(
            title=next_title,
            type=patch.type,
            dataset_id=patch.dataset_id,
            config=config_payload,
        )

    return action, []


def _ensure_korean_widget_title(
    title: str | None,
    widget_type: DashboardRuntimeWidgetType,
    config: dict[str, Any],
    dataset: AssistantDatasetContext,
) -> str:
    next_title = (title or "").strip()
    if next_title and not _title_needs_korean_normalization(next_title, dataset):
        return next_title
    return _build_korean_widget_title(widget_type, config, dataset)


def _title_needs_korean_normalization(title: str, dataset: AssistantDatasetContext) -> bool:
    normalized_title = _normalize_title_text(title)
    if not normalized_title or normalized_title in PLACEHOLDER_TITLES:
        return True
    dataset_name = _normalize_title_text(dataset.name)
    if dataset_name and dataset_name in normalized_title:
        return True
    if not _contains_hangul(title):
        return True
    return _contains_known_english_data_term(normalized_title)


def _normalize_title_text(value: str) -> str:
    return " ".join(value.replace("_", " ").replace("-", " ").split()).lower()


def _contains_hangul(value: str) -> bool:
    return any("가" <= character <= "힣" for character in value)


def _contains_known_english_data_term(normalized_title: str) -> bool:
    for column_name in COLUMN_TITLE_TERMS:
        column_phrase = _normalize_title_text(column_name)
        if column_phrase and column_phrase in normalized_title:
            return True
    for dataset_name in DATASET_NAME_TITLE_TERMS:
        if dataset_name in normalized_title:
            return True
    return False


def _build_korean_widget_title(
    widget_type: DashboardRuntimeWidgetType,
    config: dict[str, Any],
    dataset: AssistantDatasetContext,
) -> str:
    dataset_term = _dataset_title_term(dataset)
    value_term = _column_title_term(_first_config_key(config, ["yKey", "valueKey"])) or dataset_term
    x_key = _config_string(config, "xKey")
    x_term = _column_title_term(x_key)
    label_term = _column_title_term(_config_string(config, "labelKey"))
    group_term = _column_title_term(_config_string(config, "groupKey"))

    if widget_type == DashboardRuntimeWidgetType.TABLE:
        return f"{dataset_term} 상세 테이블"
    if widget_type == DashboardRuntimeWidgetType.METRIC:
        return value_term
    if widget_type in {DashboardRuntimeWidgetType.PIE_CHART, DashboardRuntimeWidgetType.DONUT_CHART}:
        return _dimension_title(label_term or group_term, value_term, "비중")
    if widget_type == DashboardRuntimeWidgetType.TREEMAP_CHART:
        return _dimension_title(label_term or group_term, value_term, "규모")
    if widget_type == DashboardRuntimeWidgetType.RADIAL_BAR_CHART:
        return f"{value_term} 현황"
    if widget_type == DashboardRuntimeWidgetType.HEATMAP_CHART:
        y_axis_term = _column_title_term(_config_string(config, "yKey"))
        if x_term and y_axis_term:
            return f"{x_term}·{y_axis_term}별 {value_term} 분포"
        return _dimension_title(x_term or y_axis_term or group_term, value_term, "분포")
    if widget_type in {DashboardRuntimeWidgetType.LINE_CHART, DashboardRuntimeWidgetType.AREA_CHART}:
        suffix = "추이" if _is_temporal_dimension(x_key) else "비교"
        return _dimension_title(x_term or group_term, value_term, suffix)
    if widget_type == DashboardRuntimeWidgetType.BAR_CHART:
        return _dimension_title(x_term or group_term, value_term, "비교")
    return f"{dataset_term} 시각화"


def _dimension_title(dimension_term: str | None, value_term: str, suffix: str) -> str:
    if not dimension_term:
        return f"{value_term} {suffix}"
    return f"{dimension_term}별 {value_term} {suffix}"


def _dataset_title_term(dataset: AssistantDatasetContext) -> str:
    if dataset.id in DATASET_TITLE_TERMS:
        return DATASET_TITLE_TERMS[dataset.id]
    normalized_name = _normalize_title_text(dataset.name)
    if normalized_name in DATASET_NAME_TITLE_TERMS:
        return DATASET_NAME_TITLE_TERMS[normalized_name]
    description = dataset.description or ""
    if "물류비" in description:
        return "물류비"
    if "배송" in description:
        return "배송 성과"
    if "재고" in description:
        return "재고 현황"
    if "주문" in description:
        return "주문"
    return dataset.name if _contains_hangul(dataset.name) else "데이터셋"


def _column_title_term(column_name: str | None) -> str | None:
    if not column_name:
        return None
    if column_name in COLUMN_TITLE_TERMS:
        return COLUMN_TITLE_TERMS[column_name]
    return column_name if _contains_hangul(column_name) else None


def _is_temporal_dimension(column_name: str | None) -> bool:
    if not column_name:
        return False
    normalized = column_name.lower()
    return any(token in normalized for token in ["date", "day", "month", "year", "time"])


def _config_string(config: dict[str, Any], key: str) -> str | None:
    value = config.get(key)
    return value if isinstance(value, str) and value else None


def _first_config_key(config: dict[str, Any], keys: list[str]) -> str | None:
    for key in keys:
        value = _config_string(config, key)
        if value:
            return value
    return None


def _validate_config(
    widget_type: DashboardRuntimeWidgetType | str,
    config: Any,
    dataset: AssistantDatasetContext,
) -> tuple[Any | None, list[str]]:
    widget_type = _widget_type_enum(widget_type)
    if widget_type not in WIDGET_OPTIONS:
        return None, [f"{widget_type!r}는 지원하지 않는 위젯 타입입니다."]

    config_payload = _config_to_dict(config)
    if widget_type in {DashboardRuntimeWidgetType.METRIC, DashboardRuntimeWidgetType.TABLE}:
        config_payload.pop("color", None)
    elif config_payload.get("color") is None:
        config_payload["color"] = {"colors": ["#2563eb"]}

    config_model = CONFIG_MODEL_BY_TYPE[widget_type]
    try:
        parsed_config = config_model.model_validate(config_payload)
    except ValidationError as exc:
        return None, [f"{widget_type.value} config가 계약과 맞지 않습니다: {exc.errors()[0]['msg']}"]

    warnings = _validate_columns(widget_type, parsed_config.model_dump(by_alias=True, exclude_none=True), dataset)
    if warnings:
        return None, warnings
    return parsed_config, []


def _merge_config_patch(current_config: dict[str, Any], patch_config: Any) -> dict[str, Any]:
    next_config = dict(current_config or {})
    for key, value in _config_to_dict(patch_config).items():
        if value is None:
            continue
        if key == "color":
            next_color = _merge_color_patch(next_config.get("color"), value)
            if next_color:
                next_config["color"] = next_color
            continue
        next_config[key] = value
    return next_config


def _merge_color_patch(current_color: Any, patch_color: Any) -> dict[str, Any]:
    next_color = _config_to_dict(current_color)
    for key, value in _config_to_dict(patch_color).items():
        if value is None:
            continue
        next_color[key] = value
    return next_color


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
                warnings.append(
                    f"{widget_type.value} config의 {field_name}={column_name!r} 컬럼이 데이터셋 "
                    f"{dataset.name!r}({dataset.id})에 없습니다. 사용 가능한 컬럼: {_available_column_names(columns)}"
                )

    for numeric_field in option["numeric"]:
        column_name = config.get(numeric_field)
        if not isinstance(column_name, str) or column_name not in columns:
            continue
        if not _is_numeric_column(columns[column_name].type):
            warnings.append(
                f"{widget_type.value} config의 {numeric_field}={column_name!r} 컬럼은 숫자형이 아닙니다. "
                f"현재 타입: {columns[column_name].type}. 숫자 컬럼만 값/축으로 사용할 수 있습니다."
            )

    return warnings


def _available_dataset_ids(datasets: dict[str, AssistantDatasetContext]) -> str:
    return ", ".join(datasets.keys()) or "없음"


def _available_column_names(columns: dict[str, Any]) -> str:
    return ", ".join(columns.keys()) or "없음"


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
