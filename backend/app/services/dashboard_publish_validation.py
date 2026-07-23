from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Iterable, Mapping

from fastapi import status

from app.core.errors import ApiError
from app.schemas.common import ErrorCode
from app.services.catalog_schema import dataset_schema


DASHBOARD_DESKTOP_COLUMNS = 12

_NUMERIC_TYPES = {
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
    "smallint",
    "tinyint",
}


@dataclass(frozen=True)
class DashboardValidationIssue:
    code: str
    message: str
    page_id: str
    widget_id: str | None = None
    widget_title: str | None = None

    def to_dict(self) -> dict[str, str]:
        return {
            key: value
            for key, value in asdict(self).items()
            if value is not None
        }


def _integer(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _layout_value(layout: Mapping[str, Any], camel_key: str, snake_key: str) -> int | None:
    return _integer(layout.get(camel_key, layout.get(snake_key)))


def _layout_bounds(layout: Mapping[str, Any]) -> tuple[int, int, int, int, int, int] | None:
    x = _layout_value(layout, "x", "x")
    y = _layout_value(layout, "y", "y")
    w = _layout_value(layout, "w", "w")
    h = _layout_value(layout, "h", "h")
    min_w = _layout_value(layout, "minW", "min_w") or 1
    min_h = _layout_value(layout, "minH", "min_h") or 1
    if None in {x, y, w, h}:
        return None
    return int(x), int(y), int(w), int(h), min_w, min_h


def dashboard_layout_issues(
    page_id: str,
    widgets: Iterable[tuple[str, str | None, Mapping[str, Any]]],
) -> list[DashboardValidationIssue]:
    resolved: list[tuple[str, str | None, tuple[int, int, int, int, int, int]]] = []
    issues: list[DashboardValidationIssue] = []

    for widget_id, widget_title, layout in widgets:
        bounds = _layout_bounds(layout)
        if bounds is None:
            issues.append(DashboardValidationIssue(
                code="INVALID_LAYOUT_VALUE",
                message="위젯 좌표와 크기는 정수여야 합니다.",
                page_id=page_id,
                widget_id=widget_id,
                widget_title=widget_title,
            ))
            continue

        x, y, w, h, min_w, min_h = bounds
        if (
            x < 0
            or y < 0
            or w < min_w
            or h < min_h
            or x + w > DASHBOARD_DESKTOP_COLUMNS
        ):
            issues.append(DashboardValidationIssue(
                code="LAYOUT_OUT_OF_BOUNDS",
                message="위젯 위치 또는 크기가 12열 캔버스 범위와 최소 크기 조건을 벗어났습니다.",
                page_id=page_id,
                widget_id=widget_id,
                widget_title=widget_title,
            ))
            continue
        resolved.append((widget_id, widget_title, bounds))

    for index, (widget_id, widget_title, bounds) in enumerate(resolved):
        x, y, w, h, _min_w, _min_h = bounds
        for other_id, other_title, other_bounds in resolved[index + 1:]:
            other_x, other_y, other_w, other_h, _other_min_w, _other_min_h = other_bounds
            collides = (
                x < other_x + other_w
                and x + w > other_x
                and y < other_y + other_h
                and y + h > other_y
            )
            if collides:
                issues.append(DashboardValidationIssue(
                    code="LAYOUT_COLLISION",
                    message=f"'{widget_title or widget_id}' 위젯이 '{other_title or other_id}' 위젯과 겹칩니다.",
                    page_id=page_id,
                    widget_id=widget_id,
                    widget_title=widget_title,
                ))

    return issues


def _config_string(config: Mapping[str, Any], key: str) -> str | None:
    value = config.get(key)
    return value.strip() if isinstance(value, str) and value.strip() else None


def _required_config_fields(widget_type: str, config: Mapping[str, Any]) -> list[tuple[str, str, bool]]:
    aggregation_is_count = _config_string(config, "aggregation") == "count"
    numeric_value = not aggregation_is_count

    if widget_type == "metric":
        return [] if aggregation_is_count else [("valueKey", "값", True)]
    if widget_type in {"bar_chart", "line_chart", "area_chart"}:
        fields = [("xKey", "분류", False)]
        if numeric_value:
            fields.append(("yKey", "값", True))
        return fields
    if widget_type in {"donut_chart", "pie_chart", "treemap_chart"}:
        fields = [("labelKey", "분류", False)]
        if numeric_value:
            fields.append(("valueKey", "값", True))
        return fields
    if widget_type == "radial_bar_chart":
        return [] if aggregation_is_count else [("valueKey", "값", True)]
    if widget_type == "heatmap_chart":
        fields = [("xKey", "X축", False), ("yKey", "Y축", False)]
        if numeric_value:
            fields.append(("valueKey", "값", True))
        return fields
    return []


def _configured_column_fields(widget_type: str, config: Mapping[str, Any]) -> list[tuple[str, str, bool]]:
    fields = _required_config_fields(widget_type, config)
    optional_keys = {
        "bar_chart": (("groupKey", "그룹", False),),
        "line_chart": (("seriesKey", "계열", False),),
        "area_chart": (("seriesKey", "계열", False),),
        "radial_bar_chart": (("labelKey", "분류", False),),
        "table": (("sortKey", "정렬", False),),
    }
    fields.extend(optional_keys.get(widget_type, ()))
    if widget_type == "table":
        columns = config.get("columns")
        if isinstance(columns, list):
            fields.extend((str(index), "표시", False) for index, _value in enumerate(columns))
    filters = config.get("filters")
    if isinstance(filters, list):
        fields.extend((f"filter:{index}", "필터", False) for index, _value in enumerate(filters))
    return fields


def _column_name(config: Mapping[str, Any], key: str) -> str | None:
    if key.isdigit():
        columns = config.get("columns")
        if isinstance(columns, list):
            value = columns[int(key)]
            return value.strip() if isinstance(value, str) and value.strip() else None
        return None
    if key.startswith("filter:"):
        filters = config.get("filters")
        index = int(key.split(":", 1)[1])
        if isinstance(filters, list) and isinstance(filters[index], dict):
            value = filters[index].get("column")
            return value.strip() if isinstance(value, str) and value.strip() else None
        return None
    return _config_string(config, key)


def _is_known_numeric_type(data_type: str) -> bool:
    normalized = data_type.strip().lower()
    base_type = normalized.split("(", 1)[0].split(maxsplit=1)[0] if normalized else ""
    return base_type in _NUMERIC_TYPES


def _is_unknown_type(data_type: str) -> bool:
    return data_type.strip().lower() in {"", "any", "object", "unknown"}


def _inline_schema(rows: Any) -> dict[str, str]:
    if not isinstance(rows, list):
        return {}
    schema: dict[str, str] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        for key, value in row.items():
            if value is None or key in schema:
                continue
            numeric_string = (
                isinstance(value, str)
                and value.strip() != ""
                and _can_parse_number(value)
            )
            schema[str(key)] = (
                "number"
                if (isinstance(value, (int, float)) and not isinstance(value, bool)) or numeric_string
                else type(value).__name__
            )
    return schema


def _can_parse_number(value: str) -> bool:
    try:
        float(value)
        return True
    except ValueError:
        return False


def dashboard_widget_config_issues(
    page_id: str,
    widget: Any,
    catalog_payload: Mapping[str, Any] | None,
) -> list[DashboardValidationIssue]:
    widget_id = str(widget.id)
    widget_title = widget.title
    widget_type = str(widget.type)
    config = dict(widget.config or {})
    if config.get("placeholderKind") in {"text", "visualization_request"}:
        return []

    dataset_id = getattr(widget, "dataset_id", None)
    if dataset_id:
        if catalog_payload is None:
            return [DashboardValidationIssue(
                code="DATASET_SCHEMA_UNAVAILABLE",
                message="연결된 Catalog 데이터셋 또는 스키마를 찾을 수 없습니다.",
                page_id=page_id,
                widget_id=widget_id,
                widget_title=widget_title,
            )]
        schema_items = dataset_schema(dict(catalog_payload))
        if not schema_items:
            return [DashboardValidationIssue(
                code="DATASET_SCHEMA_UNAVAILABLE",
                message="연결된 Catalog 데이터셋의 스키마가 비어 있습니다.",
                page_id=page_id,
                widget_id=widget_id,
                widget_title=widget_title,
            )]
        schema = {str(item["name"]): str(item["dataType"]) for item in schema_items}
    else:
        schema = _inline_schema(getattr(widget, "data", None))
        if not schema:
            return []

    issues: list[DashboardValidationIssue] = []
    required_keys = {key for key, _label, _numeric in _required_config_fields(widget_type, config)}
    for key, label, numeric in _configured_column_fields(widget_type, config):
        column_name = _column_name(config, key)
        if not column_name:
            if key in required_keys:
                issues.append(DashboardValidationIssue(
                    code="WIDGET_FIELD_REQUIRED",
                    message=f"{label} 컬럼 설정이 필요합니다.",
                    page_id=page_id,
                    widget_id=widget_id,
                    widget_title=widget_title,
                ))
            continue
        if column_name not in schema:
            issues.append(DashboardValidationIssue(
                code="WIDGET_FIELD_NOT_FOUND",
                message=f"설정한 {label} 컬럼 '{column_name}'을(를) Catalog 스키마에서 찾을 수 없습니다.",
                page_id=page_id,
                widget_id=widget_id,
                widget_title=widget_title,
            ))
            continue
        data_type = schema[column_name]
        if numeric and not _is_unknown_type(data_type) and not _is_known_numeric_type(data_type):
            issues.append(DashboardValidationIssue(
                code="WIDGET_FIELD_NOT_NUMERIC",
                message=f"설정한 {label} 컬럼 '{column_name}'은(는) 숫자형이 아닙니다.",
                page_id=page_id,
                widget_id=widget_id,
                widget_title=widget_title,
            ))

    return issues


def apply_validated_draft_layouts(repository: Any, page: Any, request: Any) -> None:
    widgets = repository.list_widgets_by_page_ids([page.id]).get(page.id, [])
    widgets_by_id = {widget.id: widget for widget in widgets}
    requested_widget_ids: set[str] = set()
    next_layout_by_widget_id: dict[str, dict[str, Any]] = {}

    for layout in request.layouts:
        if layout.widget_id in requested_widget_ids:
            raise ApiError(
                ErrorCode.DASHBOARD_LAYOUT_INVALID,
                "Dashboard layout request contains a duplicate widget.",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                {"widgetId": layout.widget_id},
                stage="dashboard_layout",
                user_message="같은 위젯의 배치가 요청에 두 번 포함되어 있습니다.",
            )
        requested_widget_ids.add(layout.widget_id)
        widget = widgets_by_id.get(layout.widget_id)
        if widget is None:
            raise ApiError(
                ErrorCode.NOT_FOUND,
                "Dashboard widget not found",
                status.HTTP_404_NOT_FOUND,
                {"widgetId": layout.widget_id},
            )
        next_layout_by_widget_id[widget.id] = {
            **dict(widget.layout or {}),
            "x": layout.x,
            "y": layout.y,
            "w": layout.w,
            "h": layout.h,
        }

    issues = dashboard_layout_issues(
        page.id,
        (
            (
                widget.id,
                widget.title,
                next_layout_by_widget_id.get(widget.id, dict(widget.layout or {})),
            )
            for widget in widgets
        ),
    )
    if issues:
        raise ApiError(
            ErrorCode.DASHBOARD_LAYOUT_INVALID,
            "Dashboard layout validation failed.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            {"issues": [issue.to_dict() for issue in issues]},
            stage="dashboard_layout",
            user_message=f"레이아웃을 저장할 수 없습니다. {issues[0].message}",
        )

    for widget_id, next_layout in next_layout_by_widget_id.items():
        repository.update_widget_layout(widgets_by_id[widget_id], next_layout)


def validate_draft_for_publish(repository: Any, catalog_repository: Any, draft_revision: Any) -> None:
    pages = repository.list_pages(draft_revision.id)
    widgets_by_page_id = repository.list_widgets_by_page_ids([page.id for page in pages])
    issues: list[DashboardValidationIssue] = []
    catalog_payloads: dict[str, dict[str, Any] | None] = {}
    for page in pages:
        widgets = widgets_by_page_id.get(page.id, [])
        issues.extend(dashboard_layout_issues(
            page.id,
            ((widget.id, widget.title, dict(widget.layout or {})) for widget in widgets),
        ))
        for widget in widgets:
            catalog_payload = None
            if widget.dataset_id:
                if widget.dataset_id not in catalog_payloads:
                    catalog_payloads[widget.dataset_id] = catalog_repository.get_dataset_payload(widget.dataset_id)
                catalog_payload = catalog_payloads[widget.dataset_id]
            issues.extend(dashboard_widget_config_issues(page.id, widget, catalog_payload))

    if issues:
        raise ApiError(
            ErrorCode.DASHBOARD_PUBLISH_BLOCKED,
            "Dashboard publish validation failed.",
            status.HTTP_409_CONFLICT,
            {"issues": [issue.to_dict() for issue in issues]},
            stage="dashboard_publish",
            user_message=f"게시 전 확인이 필요합니다. {issues[0].message}",
        )
