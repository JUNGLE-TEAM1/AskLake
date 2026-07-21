from typing import Any

from app.core.compatibility import CompatibilityPath, record_compatibility_path
from app.schemas.dashboard import (
    AreaChartWidgetConfig,
    BarChartWidgetConfig,
    DashboardRuntimeWidgetType,
    DashboardWidgetAggregation,
    DashboardWidgetAxisRangeMode,
    DashboardWidgetColorConfig,
    DashboardWidgetConfigBase,
    DashboardWidgetFormat,
    DashboardWidgetLayout,
    DashboardWidgetLineCurve,
    DashboardWidgetOrientation,
    DonutChartWidgetConfig,
    HeatmapChartWidgetConfig,
    LineChartWidgetConfig,
    MetricWidgetConfig,
    PieChartWidgetConfig,
    RadialBarChartWidgetConfig,
    TableWidgetConfig,
    TreemapChartWidgetConfig,
)
from app.services.dashboard_realtime_bridge import DASHBOARD_LEGACY_COLOR_MAP


def dashboard_widget_layout_to_json(layout: DashboardWidgetLayout) -> dict[str, int]:
    return {
        key: value
        for key, value in {
            "x": layout.x,
            "y": layout.y,
            "w": layout.w,
            "h": layout.h,
            "minW": layout.min_w,
            "minH": layout.min_h,
        }.items()
        if value is not None
    }


def dashboard_widget_config_to_json(
    widget_type: DashboardRuntimeWidgetType,
    config: DashboardWidgetConfigBase | None,
) -> dict[str, object]:
    resolved_config = config or default_dashboard_widget_config(widget_type)
    payload = resolved_config.model_dump(by_alias=True, exclude_none=True, mode="json")
    source_config = payload.pop("sourceConfig", None)
    payload.pop("dataMode", None)
    if not isinstance(source_config, dict):
        return payload

    persisted_config = dict(source_config)
    for key in (
        "body",
        "color",
        "description",
        "placeholderKind",
        "prompt",
    ):
        if key in payload:
            persisted_config[key] = payload[key]
    return persisted_config


def normalize_dashboard_widget_config(
    widget_type: DashboardRuntimeWidgetType,
    config: dict[str, Any] | None,
) -> dict[str, Any]:
    if config is None:
        return dashboard_widget_config_to_json(widget_type, None)

    normalized = dict(config)
    if widget_type in {DashboardRuntimeWidgetType.METRIC, DashboardRuntimeWidgetType.TABLE}:
        return normalized

    color = normalized.get("color")
    if isinstance(color, str):
        record_compatibility_path(
            CompatibilityPath.DASHBOARD_LEGACY_COLOR,
            reason="legacy scalar widget color is being normalized",
            context={"color": color},
        )
        normalized["color"] = {
            "colors": [
                DASHBOARD_LEGACY_COLOR_MAP.get(
                    color,
                    color if color.startswith("#") else "#2563eb",
                ),
            ],
        }
    elif color is None:
        normalized["color"] = {"colors": ["#2563eb"]}

    return normalized


def default_dashboard_widget_config(
    widget_type: DashboardRuntimeWidgetType,
) -> DashboardWidgetConfigBase:
    color = DashboardWidgetColorConfig(colors=["#2563eb"])
    if widget_type == DashboardRuntimeWidgetType.METRIC:
        return MetricWidgetConfig(
            aggregation=DashboardWidgetAggregation.COUNT,
            format=DashboardWidgetFormat.NUMBER,
            value_key="value",
        )
    if widget_type == DashboardRuntimeWidgetType.TABLE:
        return TableWidgetConfig(columns=[])
    if widget_type == DashboardRuntimeWidgetType.LINE_CHART:
        return LineChartWidgetConfig(
            aggregation=DashboardWidgetAggregation.SUM,
            color=color,
            curve=DashboardWidgetLineCurve.SMOOTH,
            value_axis_range_mode=DashboardWidgetAxisRangeMode.DEFAULT,
            x_key="category",
            y_key="value",
        )
    if widget_type == DashboardRuntimeWidgetType.AREA_CHART:
        return AreaChartWidgetConfig(
            aggregation=DashboardWidgetAggregation.SUM,
            color=color,
            stacked=False,
            value_axis_range_mode=DashboardWidgetAxisRangeMode.DEFAULT,
            x_key="category",
            y_key="value",
        )
    if widget_type == DashboardRuntimeWidgetType.DONUT_CHART:
        return DonutChartWidgetConfig(
            aggregation=DashboardWidgetAggregation.SUM,
            color=color,
            label_key="category",
            value_key="value",
        )
    if widget_type == DashboardRuntimeWidgetType.PIE_CHART:
        return PieChartWidgetConfig(
            aggregation=DashboardWidgetAggregation.SUM,
            color=color,
            label_key="category",
            value_key="value",
        )
    if widget_type == DashboardRuntimeWidgetType.RADIAL_BAR_CHART:
        return RadialBarChartWidgetConfig(
            aggregation=DashboardWidgetAggregation.AVG,
            color=color,
            format=DashboardWidgetFormat.PERCENT,
            max=100,
            min=0,
            value_key="value",
        )
    if widget_type == DashboardRuntimeWidgetType.HEATMAP_CHART:
        return HeatmapChartWidgetConfig(
            aggregation=DashboardWidgetAggregation.SUM,
            color=color,
            value_key="value",
            x_key="category",
            y_key="series",
        )
    if widget_type == DashboardRuntimeWidgetType.TREEMAP_CHART:
        return TreemapChartWidgetConfig(
            aggregation=DashboardWidgetAggregation.SUM,
            color=color,
            label_key="category",
            value_key="value",
        )
    return BarChartWidgetConfig(
        aggregation=DashboardWidgetAggregation.SUM,
        color=color,
        orientation=DashboardWidgetOrientation.VERTICAL,
        value_axis_range_mode=DashboardWidgetAxisRangeMode.DEFAULT,
        x_key="category",
        y_key="value",
    )
