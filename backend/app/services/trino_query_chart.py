"""Bounded chart aggregation over persisted full Trino query results."""

from __future__ import annotations

import math
import time
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from fastapi import status
from pydantic import ValidationError

from app.core.errors import ApiError
from app.schemas.common import ErrorCode
from app.schemas.dashboard import (
    AreaChartWidgetConfig,
    BarChartWidgetConfig,
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
from app.schemas.trino import TrinoQueryRunChartRequest, TrinoQueryRunChartResponse
from app.services.dashboard_physical_data import (
    DASHBOARD_TABLE_ROW_LIMIT,
    MAX_DASHBOARD_INCREMENTAL_GROUPS,
    dashboard_json_cell,
    dashboard_result_from_aggregate_state,
    dashboard_source_config,
    dashboard_widget_query_fields,
)
from app.services.dashboard_widget_config import normalize_dashboard_widget_config


TRINO_RESULT_CHART_TIMEOUT_SECONDS = 15.0

_CONFIG_MODELS = {
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


@dataclass(frozen=True)
class _ChartAggregationPlan:
    aggregation: str
    column_indexes: dict[str, int]
    configured_value_key: str | None
    dimension_keys: list[str]
    dimension_specs: list[tuple[str, str | None]]
    value_alias: str
    value_config_key: str


def build_trino_result_chart(
    *,
    columns: list[str],
    pages: Iterable[list[list[object]]],
    request: TrinoQueryRunChartRequest,
    run_id: str,
    source_row_count: int,
    timeout_seconds: float = TRINO_RESULT_CHART_TIMEOUT_SECONDS,
) -> TrinoQueryRunChartResponse:
    widget_type = DashboardRuntimeWidgetType(request.type)
    config = _validated_config(widget_type, request.config)
    if widget_type == DashboardRuntimeWidgetType.TABLE:
        return _table_preview(
            columns=columns,
            config=config,
            pages=pages,
            run_id=run_id,
            source_row_count=source_row_count,
        )

    plan = _chart_aggregation_plan(widget_type, config, columns)
    groups = _aggregate_chart_pages(
        pages,
        plan=plan,
        run_id=run_id,
        timeout_seconds=timeout_seconds,
    )

    state = {
        "version": 1,
        "widgetType": widget_type.value,
        "aggregation": plan.aggregation,
        "dimensionKeys": plan.dimension_keys,
        "valueConfigKey": plan.value_config_key,
        "valueAlias": plan.value_alias,
        "sourceConfig": config,
        "rows": list(groups.values()),
    }
    result = dashboard_result_from_aggregate_state(state)
    return TrinoQueryRunChartResponse(
        config=result["config"],
        data=result["data"],
        groupCount=len(groups),
        runId=run_id,
        sourceRowCount=source_row_count,
    )


def _chart_aggregation_plan(
    widget_type: DashboardRuntimeWidgetType,
    config: dict[str, Any],
    columns: list[str],
) -> _ChartAggregationPlan:
    try:
        dimension_specs, value_config_key = dashboard_widget_query_fields(widget_type.value, config)
    except ValueError as exc:
        raise _validation_error(str(exc)) from exc
    column_indexes = {column: index for index, column in enumerate(columns)}
    dimension_keys = [column for column, _date_unit in dimension_specs if column]
    for column in dimension_keys:
        if column not in column_indexes:
            raise _validation_error(f"Chart column does not exist: {column}")
    aggregation = str(config.get("aggregation") or "sum").lower()
    configured_value_key = config.get(value_config_key) or config.get(_camel_to_snake(value_config_key))
    if aggregation != "count":
        if not isinstance(configured_value_key, str) or configured_value_key not in column_indexes:
            raise _validation_error(f"Chart value column does not exist: {configured_value_key or '-'}")
    return _ChartAggregationPlan(
        aggregation=aggregation,
        column_indexes=column_indexes,
        configured_value_key=configured_value_key if isinstance(configured_value_key, str) else None,
        dimension_keys=dimension_keys,
        dimension_specs=dimension_specs,
        value_alias=(
            "__asklake_widget_value"
            if aggregation == "count" or configured_value_key in dimension_keys
            else str(configured_value_key)
        ),
        value_config_key=value_config_key,
    )


def _aggregate_chart_pages(
    pages: Iterable[list[list[object]]],
    *,
    plan: _ChartAggregationPlan,
    run_id: str,
    timeout_seconds: float,
) -> dict[tuple[object, ...], dict[str, Any]]:
    groups: dict[tuple[object, ...], dict[str, Any]] = {}
    deadline = time.monotonic() + max(timeout_seconds, 0.1)
    for page_rows in pages:
        if time.monotonic() > deadline:
            raise _timeout_error(run_id, timeout_seconds)
        for row_index, row in enumerate(page_rows):
            if row_index % 1_024 == 0 and time.monotonic() > deadline:
                raise _timeout_error(run_id, timeout_seconds)
            numeric_value = _aggregation_value(row, plan)
            if numeric_value is None:
                continue
            dimension_values = tuple(
                _dimension_value(row, plan.column_indexes[column], date_unit)
                for column, date_unit in plan.dimension_specs
                if column
            )
            state_row = groups.get(dimension_values)
            if state_row is None:
                state_row = _new_state_row(groups, plan.dimension_keys, dimension_values)
                groups[dimension_values] = state_row
            state_row["__asklake_state_count"] += 1
            state_row["__asklake_state_sum"] += numeric_value
            state_row["__asklake_state_min"] = _state_min(state_row["__asklake_state_min"], numeric_value)
            state_row["__asklake_state_max"] = _state_max(state_row["__asklake_state_max"], numeric_value)
    return groups


def _aggregation_value(row: list[object], plan: _ChartAggregationPlan) -> float | None:
    if plan.aggregation == "count":
        return 1.0
    if not plan.configured_value_key:
        return None
    return _finite_number(_cell(row, plan.column_indexes[plan.configured_value_key]))


def _new_state_row(
    groups: dict[tuple[object, ...], dict[str, Any]],
    dimension_keys: list[str],
    dimension_values: tuple[object, ...],
) -> dict[str, Any]:
    if len(groups) >= MAX_DASHBOARD_INCREMENTAL_GROUPS:
        raise _validation_error(
            f"차트 집계 그룹이 {MAX_DASHBOARD_INCREMENTAL_GROUPS:,}개를 초과했습니다. "
            "날짜 단위나 그룹 컬럼을 더 크게 묶어 주세요.",
        )
    return {
        **dict(zip(dimension_keys, dimension_values, strict=True)),
        "__asklake_state_count": 0,
        "__asklake_state_sum": 0.0,
        "__asklake_state_min": None,
        "__asklake_state_max": None,
    }


def _table_preview(
    *,
    columns: list[str],
    config: dict[str, Any],
    pages: Iterable[list[list[object]]],
    run_id: str,
    source_row_count: int,
) -> TrinoQueryRunChartResponse:
    selected = [value for value in config.get("columns", []) if isinstance(value, str) and value]
    selected = selected or columns[:20]
    missing = [column for column in selected if column not in columns]
    if missing:
        raise _validation_error(f"Table column does not exist: {missing[0]}")
    try:
        requested_limit = int(config.get("limit") or 100)
    except (TypeError, ValueError):
        requested_limit = 100
    limit = max(1, min(requested_limit, DASHBOARD_TABLE_ROW_LIMIT))
    indexes = [columns.index(column) for column in selected]
    data: list[dict[str, Any]] = []
    for page_rows in pages:
        for row in page_rows:
            data.append({
                column: dashboard_json_cell(row[index] if index < len(row) else None)
                for column, index in zip(selected, indexes, strict=True)
            })
            if len(data) >= limit:
                runtime_config = {
                    **config,
                    "columns": selected,
                    "limit": limit,
                    "dataMode": "server_preview",
                    "sourceConfig": config,
                }
                return TrinoQueryRunChartResponse(
                    config=runtime_config,
                    data=data,
                    groupCount=len(data),
                    runId=run_id,
                    sourceRowCount=source_row_count,
                )
    return TrinoQueryRunChartResponse(
        config={
            **config,
            "columns": selected,
            "limit": limit,
            "dataMode": "server_preview",
            "sourceConfig": config,
        },
        data=data,
        groupCount=len(data),
        runId=run_id,
        sourceRowCount=source_row_count,
    )


def _validated_config(
    widget_type: DashboardRuntimeWidgetType,
    raw_config: dict[str, Any],
) -> dict[str, Any]:
    source_config = dashboard_source_config(raw_config)
    normalized = normalize_dashboard_widget_config(widget_type, source_config)
    try:
        model = _CONFIG_MODELS[widget_type].model_validate(normalized)
    except (KeyError, ValidationError) as exc:
        raise _validation_error("차트 설정이 올바르지 않습니다.") from exc
    return model.model_dump(by_alias=True, exclude_none=True, mode="json")


def _dimension_value(row: list[object], index: int, date_unit: str | None) -> object:
    value = _cell(row, index)
    if date_unit in {"day", "month", "year"}:
        return _date_bucket(value, date_unit)
    return dashboard_json_cell(value)


def _date_bucket(value: object, date_unit: str) -> str | None:
    parsed: date | datetime | None
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, date):
        parsed = value
    elif value is None:
        parsed = None
    else:
        normalized = str(value).strip().replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(normalized)
        except ValueError:
            try:
                parsed = date.fromisoformat(normalized[:10])
            except ValueError:
                parsed = None
    if parsed is None:
        return None
    if date_unit == "year":
        return f"{parsed.year:04d}"
    if date_unit == "month":
        return f"{parsed.year:04d}-{parsed.month:02d}"
    return f"{parsed.year:04d}-{parsed.month:02d}-{parsed.day:02d}"


def _finite_number(value: object) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, str):
        value = value.replace(",", "").strip()
        if not value:
            return None
    try:
        parsed = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return parsed if math.isfinite(parsed) else None


def _cell(row: list[object], index: int) -> object | None:
    return row[index] if index < len(row) else None


def _state_min(current: object, value: float) -> float:
    return value if current is None else min(float(current), value)


def _state_max(current: object, value: float) -> float:
    return value if current is None else max(float(current), value)


def _camel_to_snake(value: str) -> str:
    output = ""
    for character in value:
        output += f"_{character.lower()}" if character.isupper() else character
    return output


def _validation_error(message: str) -> ApiError:
    return ApiError(
        ErrorCode.VALIDATION_ERROR,
        message,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    )


def _timeout_error(run_id: str, timeout_seconds: float) -> ApiError:
    return ApiError(
        ErrorCode.BACKEND_TIMEOUT,
        "전체 SQL 결과 차트 집계 시간이 초과되었습니다. 차원 수를 줄여 다시 시도해 주세요.",
        status.HTTP_504_GATEWAY_TIMEOUT,
        {"runId": run_id, "timeoutSeconds": timeout_seconds},
        retryable=True,
    )
