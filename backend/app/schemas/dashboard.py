from enum import Enum
from typing import Any, Literal

from pydantic import Field

from app.schemas.common import CamelModel, PageRequest, SortDirection
from app.schemas.permissions import PermissionGrant, ResourcePermissions


class DashboardStatus(str, Enum):
    DRAFT = "draft"
    PUBLISHED = "published"


class DashboardSource(str, Enum):
    MANUAL = "manual"
    SQL = "sql"
    CATALOG = "catalog"


class DashboardRuntimeMode(str, Enum):
    PUBLISHED = "published"
    DRAFT = "draft"


class DashboardAssistantMode(str, Enum):
    DASHBOARD_QUESTION = "dashboard_question"
    VISUALIZATION_REQUEST = "visualization_request"


class DashboardCardWidgetType(str, Enum):
    KPI = "kpi"
    BAR = "bar"
    LINE = "line"
    DONUT = "donut"
    TABLE = "table"


class DashboardRuntimeWidgetType(str, Enum):
    METRIC = "metric"
    TABLE = "table"
    BAR_CHART = "bar_chart"
    LINE_CHART = "line_chart"
    AREA_CHART = "area_chart"
    DONUT_CHART = "donut_chart"
    PIE_CHART = "pie_chart"
    RADIAL_BAR_CHART = "radial_bar_chart"
    HEATMAP_CHART = "heatmap_chart"
    TREEMAP_CHART = "treemap_chart"


class DashboardWidgetAggregation(str, Enum):
    SUM = "sum"
    AVG = "avg"
    COUNT = "count"
    MIN = "min"
    MAX = "max"


class DashboardWidgetDateUnit(str, Enum):
    DAY = "day"
    MONTH = "month"
    YEAR = "year"


class DashboardWidgetFormat(str, Enum):
    NUMBER = "number"
    CURRENCY = "currency"
    PERCENT = "percent"


class DashboardWidgetLineCurve(str, Enum):
    SMOOTH = "smooth"
    STRAIGHT = "straight"
    STEPLINE = "stepline"


class DashboardWidgetOrientation(str, Enum):
    VERTICAL = "vertical"
    HORIZONTAL = "horizontal"


class DashboardWidgetPaletteId(str, Enum):
    ASKLAKE_DEFAULT = "asklake-default"
    AURORA = "aurora"
    SPECTRUM = "spectrum"
    SIGNAL = "signal"
    CUSTOM = "custom"


class DashboardSortOption(str, Enum):
    NAME_ASC = "name-asc"
    NAME_DESC = "name-desc"
    UPDATED_ASC = "updated-asc"
    UPDATED_DESC = "updated-desc"
    CREATED_ASC = "created-asc"
    CREATED_DESC = "created-desc"


class DashboardSqlResult(CamelModel):
    columns: list[str]
    query: str
    row_count: int = Field(ge=0)
    run_id: str


class DashboardCard(CamelModel):
    id: str
    name: str
    owner: str
    created_by: str | None = None
    created_by_profile: dict[str, Any] | None = None
    permission_grants: list[PermissionGrant] = Field(default_factory=list)
    permissions: ResourcePermissions = Field(default_factory=ResourcePermissions)
    meta: str
    status: DashboardStatus
    tags: str
    updated: str
    created_at: str | None = None
    created_at_value: str | None = None
    dataset_id: str | None = None
    has_published_revision: bool = False
    source_run_id: str | None = None
    sql_result: DashboardSqlResult | None = None
    updated_at_value: str | None = None
    widgets: list[DashboardCardWidgetType] = Field(default_factory=list)


class DashboardListFilterOptions(CamelModel):
    owners: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)


class DashboardListQuery(PageRequest):
    search: str | None = None
    search_query: str | None = None
    owner: str | None = None
    tags: list[str] = Field(default_factory=list)
    sort: DashboardSortOption = DashboardSortOption.UPDATED_DESC


class DashboardListResponse(CamelModel):
    filter_options: DashboardListFilterOptions
    items: list[DashboardCard]
    page: int = Field(ge=1)
    page_size: int = Field(ge=1)
    total: int = Field(ge=0)


class CreateDashboardRequest(CamelModel):
    title: str | None = None
    source: DashboardSource = DashboardSource.MANUAL
    dataset_id: str | None = None
    owner: str | None = None
    sql_run_id: str | None = None


class DashboardCardResponse(CamelModel):
    dashboard: DashboardCard


class UpdateDashboardRequest(CamelModel):
    title: str


class DeleteDashboardResponse(CamelModel):
    deleted_dashboard_id: str


class DashboardWidgetConfigBase(CamelModel):
    body: str | None = None
    data_mode: Literal["server_aggregated", "server_preview"] | None = None
    description: str | None = None
    error: str | None = None
    error_message: str | None = None
    placeholder_kind: str | None = None
    prompt: str | None = None
    source_config: dict[str, Any] | None = None


class DashboardWidgetColorConfig(CamelModel):
    colors: list[str] = Field(default_factory=list)
    # Legacy fields kept only so older local mock rows do not fail validation.
    palette_id: DashboardWidgetPaletteId | None = None
    custom_colors: list[str] | None = None


class MetricWidgetConfig(DashboardWidgetConfigBase):
    aggregation: DashboardWidgetAggregation
    value_key: str
    format: DashboardWidgetFormat | None = None


class TableWidgetConfig(DashboardWidgetConfigBase):
    columns: list[str]
    limit: int | None = Field(default=None, ge=1)
    sort_direction: SortDirection | None = None
    sort_key: str | None = None


class BarChartWidgetConfig(DashboardWidgetConfigBase):
    aggregation: DashboardWidgetAggregation
    color: DashboardWidgetColorConfig
    x_key: str
    y_key: str
    group_key: str | None = None
    orientation: DashboardWidgetOrientation | None = None


class LineChartWidgetConfig(DashboardWidgetConfigBase):
    aggregation: DashboardWidgetAggregation
    color: DashboardWidgetColorConfig
    x_key: str
    y_key: str
    curve: DashboardWidgetLineCurve | None = None
    date_unit: DashboardWidgetDateUnit | None = None
    series_key: str | None = None


class AreaChartWidgetConfig(DashboardWidgetConfigBase):
    aggregation: DashboardWidgetAggregation
    color: DashboardWidgetColorConfig
    x_key: str
    y_key: str
    date_unit: DashboardWidgetDateUnit | None = None
    series_key: str | None = None
    stacked: bool | None = None


class DonutChartWidgetConfig(DashboardWidgetConfigBase):
    aggregation: DashboardWidgetAggregation
    color: DashboardWidgetColorConfig
    center_label: str | None = None
    label_key: str
    value_key: str


class PieChartWidgetConfig(DashboardWidgetConfigBase):
    aggregation: DashboardWidgetAggregation
    color: DashboardWidgetColorConfig
    label_key: str
    value_key: str


class RadialBarChartWidgetConfig(DashboardWidgetConfigBase):
    aggregation: DashboardWidgetAggregation
    color: DashboardWidgetColorConfig
    value_key: str
    format: DashboardWidgetFormat | None = None
    label_key: str | None = None
    max: float | None = None
    min: float | None = None


class HeatmapChartWidgetConfig(DashboardWidgetConfigBase):
    aggregation: DashboardWidgetAggregation
    color: DashboardWidgetColorConfig
    x_key: str
    y_key: str
    value_key: str


class TreemapChartWidgetConfig(DashboardWidgetConfigBase):
    aggregation: DashboardWidgetAggregation
    color: DashboardWidgetColorConfig
    label_key: str
    value_key: str


DashboardRuntimeWidgetConfig = (
    MetricWidgetConfig
    | TableWidgetConfig
    | BarChartWidgetConfig
    | LineChartWidgetConfig
    | AreaChartWidgetConfig
    | DonutChartWidgetConfig
    | PieChartWidgetConfig
    | RadialBarChartWidgetConfig
    | HeatmapChartWidgetConfig
    | TreemapChartWidgetConfig
)


class DashboardWidgetLayout(CamelModel):
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    w: int = Field(ge=1)
    h: int = Field(ge=1)
    min_w: int | None = Field(default=None, ge=1)
    min_h: int | None = Field(default=None, ge=1)


class DashboardRuntimeWidget(CamelModel):
    id: str
    page_id: str
    type: DashboardRuntimeWidgetType
    title: str | None
    layout: DashboardWidgetLayout
    config: DashboardRuntimeWidgetConfig
    data: list[dict[str, Any]] = Field(default_factory=list)
    dataset_id: str | None = None
    query_id: str | None = None


class DashboardMeta(CamelModel):
    id: str
    title: str
    status: DashboardStatus
    permission_grants: list[PermissionGrant] = Field(default_factory=list)
    permissions: ResourcePermissions = Field(default_factory=ResourcePermissions)
    has_published_revision: bool
    updated_at: str


class DashboardRevision(CamelModel):
    id: str
    kind: DashboardRuntimeMode
    version: int = Field(ge=1)
    published_at: str | None = None


class DashboardRuntimePage(CamelModel):
    id: str
    title: str
    order_index: int = Field(ge=0)


class DashboardFilter(CamelModel):
    id: str
    label: str
    value: Any


class DashboardRuntimeResponse(CamelModel):
    dashboard: DashboardMeta
    mode: DashboardRuntimeMode
    revision: DashboardRevision | None
    pages: list[DashboardRuntimePage]
    widgets_by_page_id: dict[str, list[DashboardRuntimeWidget]]
    filters: list[DashboardFilter] = Field(default_factory=list)


class CreateDraftPageRequest(CamelModel):
    title: str


class DashboardPageResponse(CamelModel):
    id: str
    title: str
    order_index: int = Field(ge=0)


class UpdateDraftPageRequest(CamelModel):
    title: str


class CreateDraftWidgetRequest(CamelModel):
    type: DashboardRuntimeWidgetType
    title: str | None = None
    dataset_id: str | None = None
    layout: DashboardWidgetLayout | None = None
    config: DashboardRuntimeWidgetConfig | None = None
    data: list[dict[str, Any]] | None = None


class UpdateDraftWidgetRequest(CamelModel):
    type: DashboardRuntimeWidgetType | None = None
    title: str | None = None
    dataset_id: str | None = None
    config: DashboardRuntimeWidgetConfig | None = None
    data: list[dict[str, Any]] | None = None


class DashboardWidgetMutationResponse(CamelModel):
    id: str


class DeleteDraftWidgetResponse(CamelModel):
    ok: bool = True
    deleted_widget_id: str


class DeleteDraftPageResponse(CamelModel):
    ok: bool = True


class DraftLayoutItem(DashboardWidgetLayout):
    widget_id: str


class SaveDraftLayoutsRequest(CamelModel):
    page_id: str
    layouts: list[DraftLayoutItem]


class OkResponse(CamelModel):
    ok: bool = True


class PublishDashboardResponse(CamelModel):
    dashboard_id: str
    published_revision_id: str
    published_at: str


class DashboardAssistantWidgetContext(CamelModel):
    id: str
    title: str
    type: DashboardRuntimeWidgetType
    dataset_id: str | None = None
    layout: DashboardWidgetLayout
    config: dict[str, Any] = Field(default_factory=dict)
    data_sample: list[dict[str, Any]] = Field(default_factory=list)


class DashboardAssistantRequest(CamelModel):
    dashboard_id: str | None = None
    mode: DashboardAssistantMode
    page_id: str | None = None
    prompt: str = Field(min_length=1)
    selected_widget_id: str | None = None
    widget_id: str | None = None
    widgets: list[DashboardAssistantWidgetContext] = Field(default_factory=list)


class DashboardAssistantWidgetPatch(CamelModel):
    title: str | None = None
    type: DashboardRuntimeWidgetType | None = None
    dataset_id: str | None = None
    config: dict[str, Any] | None = None


class DashboardAssistantCreateWidgetInput(CamelModel):
    title: str
    type: DashboardRuntimeWidgetType
    dataset_id: str
    config: dict[str, Any]


class DashboardAssistantCreateWidgetAction(CamelModel):
    type: Literal["create_widget"] = "create_widget"
    widget: DashboardAssistantCreateWidgetInput


class DashboardAssistantUpdateWidgetAction(CamelModel):
    type: Literal["update_widget"] = "update_widget"
    widget_id: str
    patch: DashboardAssistantWidgetPatch


class DashboardAssistantReportAction(CamelModel):
    type: Literal["report"] = "report"
    markdown: str


DashboardAssistantAction = (
    DashboardAssistantCreateWidgetAction
    | DashboardAssistantUpdateWidgetAction
    | DashboardAssistantReportAction
)


class DashboardAssistantResponse(CamelModel):
    message: str
    actions: list[DashboardAssistantAction] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    # Backward-compatible fields used by the current visualization request widget.
    config_patch: dict[str, Any] | None = None
    widget_patch: DashboardAssistantWidgetPatch | None = None
