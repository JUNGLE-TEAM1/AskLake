from enum import Enum
import re
from typing import Any, Literal

from pydantic import Field, field_validator

from app.schemas.common import CamelModel, PageRequest, SortDirection
from app.schemas.permissions import PermissionGrant, ResourcePermissions


def _reject_corrupt_dashboard_title(value: str | None) -> str | None:
    if value is None:
        return value
    # Reject titles made entirely from whitespace, punctuation, or Unicode
    # replacement characters. This catches mojibake such as "???? (??)"
    # while still allowing a valid title that happens to contain punctuation.
    if value.strip() and not re.search(r"[^\W_\ufffd]", value, re.UNICODE):
        raise ValueError("Dashboard title contains only replacement characters.")
    return value


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


class DashboardJobKind(str, Enum):
    ETL = "etl"
    CONTINUOUS_SQL = "continuous_sql"


class DashboardBindingMode(str, Enum):
    MANAGED = "managed"
    DETACHED = "detached"


class DashboardBindingDeliveryStatus(str, Enum):
    PENDING = "pending"
    CALCULATING = "calculating"
    APPLIED = "applied"
    DEGRADED = "degraded"
    FAILED = "failed"


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
    RATIO = "ratio"
    MIN = "min"
    MAX = "max"


class DashboardWidgetDateUnit(str, Enum):
    MINUTE = "minute"
    HOUR = "hour"
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

    _validate_title = field_validator("title")(_reject_corrupt_dashboard_title)


class DashboardCardResponse(CamelModel):
    dashboard: DashboardCard


class UpdateDashboardRequest(CamelModel):
    title: str

    _validate_title = field_validator("title")(_reject_corrupt_dashboard_title)


class DeleteDashboardResponse(CamelModel):
    deleted_dashboard_id: str


class DashboardJobBindingCreateRequest(CamelModel):
    dashboard_id: str = Field(min_length=1, max_length=64)
    job_id: str = Field(min_length=1, max_length=160)
    job_kind: DashboardJobKind
    output_dataset_id: str = Field(min_length=1, max_length=160)


class DashboardJobBindingDelivery(CamelModel):
    dataset_revision: int = Field(ge=0)
    mutation_type: str
    status: DashboardBindingDeliveryStatus
    applied_revision: int | None = Field(default=None, ge=0)
    calculated_at: str | None = None
    attempt_count: int = Field(ge=0)
    error_code: str | None = None
    error_message: str | None = None


class DashboardBoundDataset(CamelModel):
    """The managed output source, including its pre-publication Job schema."""

    id: str
    name: str
    layer: str
    status: str
    schema_: list[list[str]] = Field(default_factory=list, alias="schema")


class DashboardJobBinding(CamelModel):
    id: str
    dashboard_id: str
    job_id: str
    job_kind: DashboardJobKind
    output_dataset_id: str
    mode: DashboardBindingMode
    enabled: bool
    created_by: str
    detached_at: str | None = None
    created_at: str
    updated_at: str
    latest_delivery: DashboardJobBindingDelivery | None = None
    output_dataset: DashboardBoundDataset | None = None


class DashboardJobBindingList(CamelModel):
    items: list[DashboardJobBinding] = Field(default_factory=list)


class DashboardWidgetConfigBase(CamelModel):
    body: str | None = None
    data_mode: Literal["server_aggregated", "server_preview"] | None = None
    description: str | None = None
    error: str | None = None
    error_message: str | None = None
    placeholder_kind: str | None = None
    prompt: str | None = None
    numerator_value: str | None = None
    denominator_value: str | None = None
    window_days: int | None = Field(default=None, ge=1, le=3_650)
    source_config: dict[str, Any] | None = None


class DashboardWidgetColorConfig(CamelModel):
    colors: list[str] = Field(default_factory=list)
    # Legacy persisted fields remain accepted during the dashboard schema migration.
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
    applied_revision: int | None = None
    calculation_version: str | None = None
    calculated_at: str | None = None
    live_refresh: bool = False
    data_status: Literal["pending", "ready", "error"] = "ready"
    data_error: str | None = None


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
    event_cursor: int = Field(default=0, ge=0)
    pages: list[DashboardRuntimePage]
    widgets_by_page_id: dict[str, list[DashboardRuntimeWidget]]
    filters: list[DashboardFilter] = Field(default_factory=list)


class DatasetFreshnessQueryRequest(CamelModel):
    dataset_ids: list[str] = Field(min_length=1, max_length=100)


class DatasetFreshnessResponse(CamelModel):
    dataset_id: str
    is_continuous: bool
    latest_revision: int = Field(ge=0)
    updated_at: str | None = None
    next_check_after_ms: int = Field(ge=1_000, le=60_000)
    binding_epoch: int = Field(default=0, ge=0)
    active_serving_engine: str | None = None
    active_serving_version_id: str | None = None
    active_archive_snapshot_id: str | None = None
    latest_source_boundary: dict[str, Any] | None = None
    latest_checksum: str | None = None
    latest_mutation_type: Literal["append", "upsert", "replace", "retract"] | None = None


class DatasetFreshnessQueryResponse(CamelModel):
    datasets: list[DatasetFreshnessResponse]


class DashboardWidgetQueryRequest(CamelModel):
    widget_ids: list[str] = Field(min_length=1, max_length=100)
    mode: DashboardRuntimeMode = DashboardRuntimeMode.PUBLISHED


class DashboardWidgetQueryResponse(CamelModel):
    widgets: list[DashboardRuntimeWidget]


class CreateDraftPageRequest(CamelModel):
    title: str

    _validate_title = field_validator("title")(_reject_corrupt_dashboard_title)


class DashboardPageResponse(CamelModel):
    id: str
    title: str
    order_index: int = Field(ge=0)


class UpdateDraftPageRequest(CamelModel):
    title: str

    _validate_title = field_validator("title")(_reject_corrupt_dashboard_title)


class CreateDraftWidgetRequest(CamelModel):
    type: DashboardRuntimeWidgetType
    title: str | None = None
    dataset_id: str | None = None
    layout: DashboardWidgetLayout | None = None
    config: DashboardRuntimeWidgetConfig | None = None
    data: list[dict[str, Any]] | None = None

    _validate_title = field_validator("title")(_reject_corrupt_dashboard_title)


class UpdateDraftWidgetRequest(CamelModel):
    type: DashboardRuntimeWidgetType | None = None
    title: str | None = None
    dataset_id: str | None = None
    config: DashboardRuntimeWidgetConfig | None = None
    data: list[dict[str, Any]] | None = None

    _validate_title = field_validator("title")(_reject_corrupt_dashboard_title)


class DashboardWidgetMutationResponse(CamelModel):
    id: str
    widget: DashboardRuntimeWidget


class DeleteDraftWidgetResponse(CamelModel):
    ok: bool = True
    deleted_widget_id: str


class DeleteDraftPageResponse(CamelModel):
    ok: bool = True
    replacement_page: DashboardPageResponse | None = None


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
    dashboard_id: str | None = Field(default=None, max_length=255)
    mode: DashboardAssistantMode
    page_id: str | None = Field(default=None, max_length=255)
    prompt: str = Field(min_length=1, max_length=8_000)
    selected_widget_id: str | None = Field(default=None, max_length=255)
    widget_id: str | None = Field(default=None, max_length=255)
    widgets: list[DashboardAssistantWidgetContext] = Field(default_factory=list, max_length=100)
    semantic_model_id: str | None = Field(default=None, max_length=255)
    current_dataset_id: str | None = Field(default=None, max_length=255)
    selected_dataset_ids: list[str] = Field(default_factory=list, max_length=20)
    surface: Literal["dashboard", "catalog", "semantic"] = "dashboard"


class DashboardAssistantWidgetPatch(CamelModel):
    title: str | None = Field(default=None, max_length=255)
    type: DashboardRuntimeWidgetType | None = None
    dataset_id: str | None = Field(default=None, max_length=255)
    config: dict[str, Any] | None = None

    _validate_title = field_validator("title")(_reject_corrupt_dashboard_title)


class DashboardAssistantCreateWidgetInput(CamelModel):
    title: str = Field(max_length=255)
    type: DashboardRuntimeWidgetType
    dataset_id: str = Field(max_length=255)
    config: dict[str, Any]

    _validate_title = field_validator("title")(_reject_corrupt_dashboard_title)


class DashboardAssistantCreateWidgetAction(CamelModel):
    type: Literal["create_widget"] = "create_widget"
    widget: DashboardAssistantCreateWidgetInput
    used_evidence_ids: list[str] = Field(default_factory=list, max_length=24)


class DashboardAssistantUpdateWidgetAction(CamelModel):
    type: Literal["update_widget"] = "update_widget"
    widget_id: str = Field(max_length=255)
    patch: DashboardAssistantWidgetPatch
    used_evidence_ids: list[str] = Field(default_factory=list, max_length=24)


class DashboardAssistantReportAction(CamelModel):
    type: Literal["report"] = "report"
    markdown: str = Field(max_length=8_000)
    used_evidence_ids: list[str] = Field(default_factory=list, max_length=24)


DashboardAssistantAction = (
    DashboardAssistantCreateWidgetAction
    | DashboardAssistantUpdateWidgetAction
    | DashboardAssistantReportAction
)


class DashboardAssistantResponse(CamelModel):
    message: str = Field(max_length=8_000)
    request_id: str | None = Field(default=None, max_length=255)
    actions: list[DashboardAssistantAction] = Field(default_factory=list, max_length=8)
    warnings: list[str] = Field(default_factory=list, max_length=16)
    model: str | None = Field(default=None, max_length=200)
    provider: str | None = Field(default=None, max_length=100)
    # Backward-compatible fields used by the current visualization request widget.
    config_patch: dict[str, Any] | None = None
    widget_patch: DashboardAssistantWidgetPatch | None = None
    sources: list[dict[str, Any]] = Field(default_factory=list)
    retrieval: dict[str, Any] | None = None
    used_evidence_ids: list[str] = Field(default_factory=list, max_length=24)
