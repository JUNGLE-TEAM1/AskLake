from typing import Any

from app.schemas.dashboard import DashboardRuntimeWidgetType


WIDGET_OPTIONS: dict[DashboardRuntimeWidgetType, dict[str, Any]] = {
    DashboardRuntimeWidgetType.METRIC: {
        "required": ["valueKey", "aggregation"],
        "optional": ["format"],
        "numeric": ["valueKey"],
        "description": "하나의 숫자 지표를 요약합니다.",
    },
    DashboardRuntimeWidgetType.TABLE: {
        "required": ["columns"],
        "optional": ["limit", "sortKey", "sortDirection"],
        "numeric": [],
        "description": "선택한 컬럼을 표로 보여줍니다.",
    },
    DashboardRuntimeWidgetType.BAR_CHART: {
        "required": ["xKey", "yKey", "aggregation"],
        "optional": ["groupKey", "orientation", "color"],
        "numeric": ["yKey"],
        "description": "범주별 값을 막대로 비교합니다.",
    },
    DashboardRuntimeWidgetType.LINE_CHART: {
        "required": ["xKey", "yKey", "aggregation", "color"],
        "optional": ["seriesKey", "dateUnit", "curve"],
        "numeric": ["yKey"],
        "description": "시간 또는 순서에 따른 추이를 선으로 보여줍니다.",
    },
    DashboardRuntimeWidgetType.AREA_CHART: {
        "required": ["xKey", "yKey", "aggregation", "color"],
        "optional": ["seriesKey", "dateUnit", "stacked"],
        "numeric": ["yKey"],
        "description": "흐름이나 누적 규모를 면적으로 강조합니다.",
    },
    DashboardRuntimeWidgetType.DONUT_CHART: {
        "required": ["labelKey", "valueKey", "aggregation", "color"],
        "optional": ["centerLabel"],
        "numeric": ["valueKey"],
        "description": "구성 비율을 도넛 형태로 보여줍니다.",
    },
    DashboardRuntimeWidgetType.PIE_CHART: {
        "required": ["labelKey", "valueKey", "aggregation", "color"],
        "optional": [],
        "numeric": ["valueKey"],
        "description": "구성 비율을 원형으로 보여줍니다.",
    },
    DashboardRuntimeWidgetType.RADIAL_BAR_CHART: {
        "required": ["valueKey", "aggregation", "color"],
        "optional": ["labelKey", "format", "min", "max"],
        "numeric": ["valueKey"],
        "description": "단일 또는 소수 지표의 달성률을 원형 막대로 보여줍니다.",
    },
    DashboardRuntimeWidgetType.HEATMAP_CHART: {
        "required": ["xKey", "yKey", "valueKey", "aggregation", "color"],
        "optional": [],
        "numeric": ["valueKey"],
        "description": "두 축의 교차 값 크기를 색상으로 보여줍니다.",
    },
    DashboardRuntimeWidgetType.TREEMAP_CHART: {
        "required": ["labelKey", "valueKey", "aggregation", "color"],
        "optional": [],
        "numeric": ["valueKey"],
        "description": "계층 또는 범주별 규모를 사각형 면적으로 보여줍니다.",
    },
}


def widget_options_payload() -> list[dict[str, Any]]:
    return [
        {
            "type": widget_type.value,
            "requiredFields": option["required"],
            "optionalFields": option["optional"],
            "numericFields": option["numeric"],
            "description": option["description"],
        }
        for widget_type, option in WIDGET_OPTIONS.items()
    ]
