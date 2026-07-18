import json
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


GenerationMode = Literal[
    "query_sql",
    "classify_dataset",
    "segment_document",
    "etl_transform",
    "dashboard_assistant",
    "review_schema",
    "review_row",
    "rag_query_plan",
    "rag_relevance",
]


class QuerySqlOutput(BaseModel):
    """The only provider output accepted by the gateway contract."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True, str_strip_whitespace=True)

    query_sql: str = Field(min_length=1, max_length=20_000)
    explanation: str = Field(max_length=4_000)
    warnings: list[str] = Field(max_length=8)
    used_evidence_ids: list[str] = Field(alias="usedEvidenceIds", max_length=24)

    @field_validator("warnings")
    @classmethod
    def validate_warnings(cls, value: list[str]) -> list[str]:
        if any(len(warning) > 500 for warning in value):
            raise ValueError("Each warning must be at most 500 characters")
        return value

    @field_validator("used_evidence_ids")
    @classmethod
    def validate_used_evidence_ids(cls, value: list[str]) -> list[str]:
        if any(not item.strip() or len(item) > 255 for item in value):
            raise ValueError("Used evidence IDs must be non-empty and at most 255 characters")
        if len(set(value)) != len(value):
            raise ValueError("Used evidence IDs must be unique")
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

    colors: list[str] | None = Field(max_length=32)
    palette_id: str | None = Field(alias="paletteId", max_length=100)
    custom_colors: list[str] | None = Field(alias="customColors", max_length=32)

    @field_validator("colors", "custom_colors")
    @classmethod
    def validate_colors(cls, value: list[str] | None) -> list[str] | None:
        if value is not None and any(len(color) > 64 for color in value):
            raise ValueError("Dashboard color values must be at most 64 characters")
        return value


class DashboardWidgetConfigOutput(BaseModel):
    """Bounded dashboard widget config accepted by the backend action guard."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    aggregation: Literal["sum", "avg", "count", "min", "max"] | None
    body: str | None = Field(max_length=8_000)
    center_label: str | None = Field(alias="centerLabel")
    color: DashboardColorOutput | None
    columns: list[str] | None = Field(max_length=64)
    curve: Literal["smooth", "straight", "stepline"] | None
    date_unit: Literal["day", "month", "year"] | None = Field(alias="dateUnit")
    description: str | None = Field(max_length=2_000)
    error: str | None = Field(max_length=1_000)
    error_message: str | None = Field(alias="errorMessage", max_length=1_000)
    format: Literal["number", "currency", "percent"] | None
    group_key: str | None = Field(alias="groupKey", max_length=255)
    label_key: str | None = Field(alias="labelKey", max_length=255)
    limit: int | None = Field(ge=1, le=10_000)
    max: float | None
    min: float | None
    orientation: Literal["vertical", "horizontal"] | None
    placeholder_kind: str | None = Field(alias="placeholderKind", max_length=100)
    prompt: str | None = Field(max_length=2_000)
    series_key: str | None = Field(alias="seriesKey", max_length=255)
    sort_direction: Literal["asc", "desc"] | None = Field(alias="sortDirection")
    sort_key: str | None = Field(alias="sortKey")
    stacked: bool | None
    value_key: str | None = Field(alias="valueKey", max_length=255)
    x_key: str | None = Field(alias="xKey", max_length=255)
    y_key: str | None = Field(alias="yKey", max_length=255)

    @field_validator("columns")
    @classmethod
    def validate_columns(cls, value: list[str] | None) -> list[str] | None:
        if value is not None and any(not column.strip() or len(column) > 255 for column in value):
            raise ValueError("Dashboard columns must be non-empty and at most 255 characters")
        return value


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

    title: str | None = Field(max_length=255)
    type: DashboardWidgetType | None
    dataset_id: str | None = Field(alias="datasetId", max_length=255)
    config: DashboardWidgetConfigOutput | None


class DashboardActionOutput(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    type: Literal["create_widget", "update_widget", "report"]
    widget_id: str | None = Field(alias="widgetId", max_length=255)
    markdown: str | None = Field(max_length=8_000)
    widget: DashboardWidgetOutput | None
    patch: DashboardWidgetOutput | None
    used_evidence_ids: list[str] = Field(alias="usedEvidenceIds", max_length=24)

    @field_validator("used_evidence_ids")
    @classmethod
    def validate_used_evidence_ids(cls, value: list[str]) -> list[str]:
        normalized = [item.strip() for item in value]
        if any(not item or len(item) > 255 for item in normalized):
            raise ValueError("Action evidence IDs must be non-empty and at most 255 characters")
        if len(set(normalized)) != len(normalized):
            raise ValueError("Action evidence IDs must be unique")
        return normalized

    @model_validator(mode="after")
    def validate_action_shape(self) -> "DashboardActionOutput":
        if self.type == "report":
            if not self.markdown or self.widget is not None or self.patch is not None or self.widget_id is not None:
                raise ValueError("Report actions must contain only markdown")
        elif self.type == "create_widget":
            if self.widget is None or self.patch is not None or self.widget_id is not None or self.markdown is not None:
                raise ValueError("Create actions must contain only widget")
        elif self.type == "update_widget":
            if not self.widget_id or self.patch is None or self.widget is not None or self.markdown is not None:
                raise ValueError("Update actions must contain widgetId and patch")
        return self


class DashboardAssistantOutput(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, str_strip_whitespace=True)

    message: str = Field(max_length=8_000)
    actions: list[DashboardActionOutput] = Field(max_length=8)
    warnings: list[str] = Field(max_length=16)
    used_evidence_ids: list[str] = Field(alias="usedEvidenceIds", max_length=24)

    @field_validator("warnings")
    @classmethod
    def validate_warnings(cls, value: list[str]) -> list[str]:
        if any(len(warning) > 500 for warning in value):
            raise ValueError("Dashboard warnings must be at most 500 characters")
        return value

    @field_validator("used_evidence_ids")
    @classmethod
    def validate_used_evidence_ids(cls, value: list[str]) -> list[str]:
        if any(not item.strip() or len(item) > 255 for item in value):
            raise ValueError("Used evidence IDs must be non-empty and at most 255 characters")
        if len(set(value)) != len(value):
            raise ValueError("Used evidence IDs must be unique")
        return value

    @model_validator(mode="after")
    def require_action_scoped_evidence(self) -> "DashboardAssistantOutput":
        scoped_ids = list(dict.fromkeys(
            evidence_id
            for action in self.actions
            for evidence_id in action.used_evidence_ids
        ))
        if set(self.used_evidence_ids) != set(scoped_ids):
            raise ValueError("Top-level usedEvidenceIds must equal the union of action-scoped evidence IDs")
        self.used_evidence_ids = scoped_ids
        return self


class ReviewSchemaColumnOutput(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, str_strip_whitespace=True)

    target_name: str = Field(min_length=1, max_length=255, alias="targetName")
    label: str = Field(min_length=1, max_length=255)
    type: Literal["String", "Integer", "Long", "Double", "Boolean", "Timestamp"]
    nullable: bool
    method: Literal["copy", "one_of_values", "instruction"]
    allowed_values: list[str] | None = Field(alias="allowedValues", max_length=64)
    instruction: str | None = Field(max_length=2_000)

    @model_validator(mode="after")
    def validate_method_contract(self) -> "ReviewSchemaColumnOutput":
        values = self.allowed_values or []
        if any(not value.strip() or len(value) > 255 for value in values):
            raise ValueError("Review allowedValues must be non-empty and at most 255 characters")
        if self.method == "one_of_values" and not values:
            raise ValueError("one_of_values requires allowedValues")
        if self.method != "one_of_values" and self.allowed_values not in (None, []):
            raise ValueError("allowedValues is supported only for one_of_values")
        return self


class ReviewSchemaOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    columns: list[ReviewSchemaColumnOutput] = Field(min_length=1, max_length=64)


class ReviewRowValueOutput(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, str_strip_whitespace=True)

    target_name: str = Field(min_length=1, max_length=255, alias="targetName")
    value: str | int | float | bool | None

    @field_validator("value")
    @classmethod
    def validate_value(cls, value: str | int | float | bool | None) -> str | int | float | bool | None:
        if isinstance(value, str) and len(value) > 8_000:
            raise ValueError("Review values must be at most 8000 characters")
        return value


class ReviewRowOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    values: list[ReviewRowValueOutput] = Field(min_length=1, max_length=64)


class RagQueryFilterOutput(BaseModel):
    """One typed metadata predicate proposed for a known Dataset field."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True, str_strip_whitespace=True)

    field: str = Field(min_length=1, max_length=255)
    operator: Literal["eq", "gte", "gt", "lte", "lt"]
    value: str | int | float | bool


class RagDatasetQueryPlanOutput(BaseModel):
    """Dataset-scoped search plan; backend validation remains authoritative."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True, str_strip_whitespace=True)

    dataset_id: str = Field(min_length=1, max_length=255, alias="datasetId")
    semantic_query: str = Field(min_length=1, max_length=2_000, alias="semanticQuery")
    in_domain: bool = Field(alias="inDomain")
    reason: str = Field(max_length=500)
    filters: list[RagQueryFilterOutput] = Field(max_length=32)


class RagQueryPlanOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    plans: list[RagDatasetQueryPlanOutput] = Field(min_length=1, max_length=100)


class RagRelevanceJudgmentOutput(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, str_strip_whitespace=True)

    document_id: str = Field(min_length=1, max_length=255, alias="documentId")
    relevant: bool
    score: float = Field(ge=0, le=1)
    reason: str = Field(max_length=500)


class RagRelevanceOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    judgments: list[RagRelevanceJudgmentOutput] = Field(max_length=24)


GenerationOutput = (
    QuerySqlOutput
    | DatasetClassificationOutput
    | DocumentSegmentationOutput
    | EtlTransformOutput
    | DashboardAssistantOutput
    | ReviewSchemaOutput
    | ReviewRowOutput
    | RagQueryPlanOutput
    | RagRelevanceOutput
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

    @field_validator("selected_dataset_ids")
    @classmethod
    def validate_selected_dataset_ids(cls, value: list[str]) -> list[str]:
        if any(not dataset_id.strip() or len(dataset_id) > 255 for dataset_id in value):
            raise ValueError("Selected Dataset IDs must be non-empty and at most 255 characters")
        if len(set(value)) != len(value):
            raise ValueError("Selected Dataset IDs must be unique")
        return value


class GenerationUsage(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, allow_inf_nan=False)

    input_tokens: int = Field(default=0, ge=0, alias="inputTokens")
    output_tokens: int = Field(default=0, ge=0, alias="outputTokens")
    total_tokens: int = Field(default=0, ge=0, alias="totalTokens")
    estimated_cost_usd: float = Field(default=0, ge=0, alias="estimatedCostUsd")


class GenerateResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: str
    mode: GenerationMode = "query_sql"
    output: GenerationOutput
    provider: str = Field(min_length=1, max_length=100)
    model: str = Field(min_length=1, max_length=200)
    usage: GenerationUsage = Field(default_factory=GenerationUsage)


class EmbeddingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    model: str = Field(default="text-embedding-3-small", min_length=1, max_length=200)
    input: list[str] = Field(min_length=1, max_length=256)

    @field_validator("input")
    @classmethod
    def validate_input_items(cls, value: list[str]) -> list[str]:
        if any(not item.strip() for item in value):
            raise ValueError("Embedding input items must not be blank")
        if any(len(item) > 32_000 for item in value):
            raise ValueError("Each embedding input item must be at most 32000 characters")
        return value


class EmbeddingResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    provider: str = Field(min_length=1, max_length=100)
    model: str
    dimensions: int = Field(ge=1, le=8192)
    data: list[list[float]] = Field(min_length=1, max_length=256)


def compact_json_size(value: Any) -> int:
    """Return the UTF-8 size used for bounded generic payload validation."""

    return len(
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    )
