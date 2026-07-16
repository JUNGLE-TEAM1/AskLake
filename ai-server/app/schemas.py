import json
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


GenerationMode = Literal[
    "query_sql",
    "classify_dataset",
    "segment_document",
    "etl_transform",
    "dashboard_assistant",
    "review_schema",
    "review_row",
]


class QuerySqlOutput(BaseModel):
    """The only provider output accepted by the gateway contract."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    query_sql: str = Field(min_length=1, max_length=20_000)
    explanation: str = Field(max_length=4_000)
    warnings: list[str] = Field(max_length=8)

    @field_validator("warnings")
    @classmethod
    def validate_warnings(cls, value: list[str]) -> list[str]:
        if any(len(warning) > 500 for warning in value):
            raise ValueError("Each warning must be at most 500 characters")
        return value


class ClassificationRole(BaseModel):
    """Strict role contract used by the provider JSON schema."""

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        str_strip_whitespace=True,
    )

    column_name: str = Field(min_length=1, max_length=255, alias="columnName")
    role: Literal["body", "title", "metadata", "identifier", "excluded"]
    confidence: float = Field(ge=0, le=1)
    reason: str = Field(max_length=500)


class DatasetClassificationOutput(BaseModel):
    """Strict, bounded role recommendation for Catalog columns."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    classification: str = Field(min_length=1, max_length=100)
    confidence: float = Field(ge=0, le=1)
    roles: list[ClassificationRole] = Field(max_length=256)


class DocumentSegment(BaseModel):
    """Inclusive sentence range returned by the chunking refinement mode."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    start_sentence: int = Field(ge=0, alias="startSentence")
    end_sentence: int = Field(ge=0, alias="endSentence")

    @field_validator("end_sentence")
    @classmethod
    def end_must_not_precede_start(cls, value: int, info: Any) -> int:
        start = info.data.get("start_sentence")
        if start is not None and value < start:
            raise ValueError("segment end_sentence must be greater than or equal to start_sentence")
        return value


class DocumentSegmentationOutput(BaseModel):
    """Strict boundary-only output for semantic chunk refinement."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    segments: list[DocumentSegment] = Field(min_length=1, max_length=256)
    confidence: float = Field(ge=0, le=1)
    strategy: Literal["llm_refined"]


class EtlTransformOutput(BaseModel):
    """Safe SQL expression or SELECT transform generated for the ETL editor."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    sql: str = Field(min_length=1, max_length=20_000)
    schema_context: str = Field(max_length=4_000, alias="schemaContext")


class DashboardColorOutput(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    colors: list[str] | None
    palette_id: str | None = Field(alias="paletteId")
    custom_colors: list[str] | None = Field(alias="customColors")


class DashboardWidgetConfigOutput(BaseModel):
    """Bounded dashboard widget config accepted by the backend action guard."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    aggregation: Literal["sum", "avg", "count", "min", "max"] | None
    body: str | None
    center_label: str | None = Field(alias="centerLabel")
    color: DashboardColorOutput | None
    columns: list[str] | None
    curve: Literal["smooth", "straight", "stepline"] | None
    date_unit: Literal["day", "month", "year"] | None = Field(alias="dateUnit")
    description: str | None
    error: str | None
    error_message: str | None = Field(alias="errorMessage")
    format: Literal["number", "currency", "percent"] | None
    group_key: str | None = Field(alias="groupKey")
    label_key: str | None = Field(alias="labelKey")
    limit: int | None
    max: float | None
    min: float | None
    orientation: Literal["vertical", "horizontal"] | None
    placeholder_kind: str | None = Field(alias="placeholderKind")
    prompt: str | None
    series_key: str | None = Field(alias="seriesKey")
    sort_direction: Literal["asc", "desc"] | None = Field(alias="sortDirection")
    sort_key: str | None = Field(alias="sortKey")
    stacked: bool | None
    value_key: str | None = Field(alias="valueKey")
    x_key: str | None = Field(alias="xKey")
    y_key: str | None = Field(alias="yKey")


DashboardWidgetType = Literal[
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
]


class DashboardWidgetOutput(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    title: str | None
    type: DashboardWidgetType | None
    dataset_id: str | None = Field(alias="datasetId")
    config: DashboardWidgetConfigOutput | None


class DashboardActionOutput(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    type: Literal["create_widget", "update_widget", "report"]
    widget_id: str | None = Field(alias="widgetId")
    markdown: str | None
    widget: DashboardWidgetOutput | None
    patch: DashboardWidgetOutput | None


class DashboardAssistantOutput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    message: str = Field(max_length=8_000)
    actions: list[DashboardActionOutput] = Field(max_length=8)
    warnings: list[str] = Field(max_length=16)


class ReviewSchemaColumnOutput(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, str_strip_whitespace=True)

    target_name: str = Field(min_length=1, max_length=255, alias="targetName")
    label: str = Field(min_length=1, max_length=255)
    type: Literal["String", "Integer", "Long", "Double", "Boolean", "Timestamp"]
    nullable: bool
    method: Literal["copy", "one_of_values", "instruction"]
    allowed_values: list[str] | None = Field(alias="allowedValues")
    instruction: str | None


class ReviewSchemaOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    columns: list[ReviewSchemaColumnOutput] = Field(min_length=1, max_length=64)


class ReviewRowValueOutput(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, str_strip_whitespace=True)

    target_name: str = Field(min_length=1, max_length=255, alias="targetName")
    value: str | int | float | bool | None


class ReviewRowOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    values: list[ReviewRowValueOutput] = Field(min_length=1, max_length=64)


GenerationOutput = (
    QuerySqlOutput
    | DatasetClassificationOutput
    | DocumentSegmentationOutput
    | EtlTransformOutput
    | DashboardAssistantOutput
    | ReviewSchemaOutput
    | ReviewRowOutput
)


class GenerateRequest(BaseModel):
    """Stable internal request shape with bounded context/tool extension points.

    With MCP enabled, the gateway resolves only the fixed AskLake Catalog
    context tool. It never executes provider-supplied tools or interprets
    generic context values as instructions.
    """

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    mode: GenerationMode = "query_sql"
    request_id: str | None = Field(default=None, max_length=255)
    prompt: str = Field(min_length=1, max_length=8_000)
    current_query: str | None = Field(default=None, max_length=20_000)
    base_dataset_id: str | None = Field(default=None, max_length=255)
    rag_context: dict[str, Any] = Field(default_factory=dict)
    selected_dataset_ids: list[str] = Field(default_factory=list, max_length=100)
    context: dict[str, Any] = Field(default_factory=dict)
    tools: list[dict[str, Any]] = Field(default_factory=list, max_length=16)


class GenerateResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: str
    mode: GenerationMode = "query_sql"
    output: GenerationOutput
    provider: str
    model: str


class EmbeddingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    model: str = Field(default="text-embedding-3-small", min_length=1, max_length=200)
    input: list[str] = Field(min_length=1, max_length=256)


class EmbeddingResponse(BaseModel):
    model: str
    dimensions: int = Field(ge=1)
    data: list[list[float]]


def compact_json_size(value: Any) -> int:
    """Return the UTF-8 size used for bounded generic payload validation."""

    return len(
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    )
