from typing import Any, Literal

from pydantic import Field, field_validator, model_validator

from app.schemas.common import CamelModel


TextFieldTask = Literal[
    "copy",
    "classification",
    "multi_label",
    "ordinal",
    "boolean",
    "extract_span",
    "extract_scalar",
    "free_text",
]
TextOutputMode = Literal["flat", "nested", "child_table"]
TextProvider = Literal["heuristic", "openai_compatible", "student", "hybrid"]


class TextLabelSpec(CamelModel):
    value: str
    description: str = ""
    order: int | None = None


class TextFieldExample(CamelModel):
    text: str
    value: Any
    evidence: str | None = None


class TextFieldSpec(CamelModel):
    field_id: str
    target_name: str
    task: TextFieldTask
    description: str
    output_type: str = "String"
    source_field: str | None = None
    allowed_values: list[TextLabelSpec] = Field(default_factory=list)
    examples: list[TextFieldExample] = Field(default_factory=list)
    nullable: bool = True
    unknown_value: str | None = "unknown"
    evidence_required: bool = False

    @field_validator("field_id", "target_name")
    @classmethod
    def validate_identifier(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Text field identifiers cannot be empty.")
        if not normalized.replace("_", "").isalnum():
            raise ValueError("Text field identifiers may contain only letters, numbers, and underscores.")
        return normalized

    @model_validator(mode="after")
    def validate_task_contract(self) -> "TextFieldSpec":
        if self.task in {"classification", "multi_label", "ordinal"} and not self.allowed_values:
            raise ValueError(f"{self.target_name} requires allowedValues.")
        if self.task == "ordinal":
            orders = [item.order for item in self.allowed_values]
            if any(order is None for order in orders) or len(set(orders)) != len(orders):
                raise ValueError(f"{self.target_name} ordinal labels require unique order values.")
        return self


class TextRepeatedGroupSpec(CamelModel):
    group_id: str
    target_name: str
    description: str
    output_mode: Literal["nested", "child_table"] = "child_table"
    fields: list[TextFieldSpec]

    @field_validator("group_id", "target_name")
    @classmethod
    def validate_identifier(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized or not normalized.replace("_", "").isalnum():
            raise ValueError("Repeated group identifiers may contain only letters, numbers, and underscores.")
        return normalized

    @model_validator(mode="after")
    def validate_fields(self) -> "TextRepeatedGroupSpec":
        if not self.fields:
            raise ValueError("Repeated groups require at least one field.")
        names = [field.target_name for field in self.fields]
        if len(names) != len(set(names)):
            raise ValueError("Repeated group target names must be unique.")
        return self


class TextRoutingPolicy(CamelModel):
    mode: TextProvider = "hybrid"
    provider: TextProvider = "openai_compatible"
    accept_threshold: float = Field(default=0.9, ge=0, le=1)
    human_review_threshold: float = Field(default=0.65, ge=0, le=1)
    max_llm_fraction: float = Field(default=1.0, ge=0, le=1)
    external_provider_allowed: bool = False
    pii_mode: Literal["none", "mask", "block_external"] = "mask"
    on_error: Literal["fail", "quarantine", "keep_raw"] = "quarantine"
    batch_size: int = Field(default=32, ge=1, le=512)

    @model_validator(mode="after")
    def validate_thresholds(self) -> "TextRoutingPolicy":
        if self.human_review_threshold > self.accept_threshold:
            raise ValueError("humanReviewThreshold cannot exceed acceptThreshold.")
        return self


class TextStructuringDefinition(CamelModel):
    source_fields: list[str]
    locale: str = "auto"
    output_mode: TextOutputMode = "flat"
    fields: list[TextFieldSpec] = Field(default_factory=list)
    repeated_groups: list[TextRepeatedGroupSpec] = Field(default_factory=list)
    routing_policy: TextRoutingPolicy = Field(default_factory=TextRoutingPolicy)

    @model_validator(mode="after")
    def validate_definition(self) -> "TextStructuringDefinition":
        if not self.source_fields:
            raise ValueError("At least one source field is required.")
        target_names = [field.target_name for field in self.fields]
        group_names = [group.target_name for group in self.repeated_groups]
        all_names = target_names + group_names
        if len(all_names) != len(set(all_names)):
            raise ValueError("Text structuring output names must be unique.")
        if not self.fields and not self.repeated_groups:
            raise ValueError("At least one output field or repeated group is required.")
        return self


class TextStructuringSpecRef(CamelModel):
    spec_id: str
    version: int = Field(ge=1)
    fingerprint: str


class CreateTextStructuringSpecRequest(CamelModel):
    name: str
    description: str = ""
    definition: TextStructuringDefinition

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Text structuring spec name cannot be empty.")
        return normalized


class CreateTextStructuringVersionRequest(CamelModel):
    definition: TextStructuringDefinition
    publish: bool = False


class TextStructuringSpecVersionResponse(CamelModel):
    spec_id: str
    version: int
    fingerprint: str
    status: Literal["draft", "published", "archived"]
    definition: TextStructuringDefinition
    compiled_schema: dict[str, Any]
    prompt_version: str
    created_at: str
    published_at: str | None = None


class TextStructuringSpecResponse(CamelModel):
    id: str
    name: str
    description: str
    owner: str
    status: Literal["draft", "published", "archived"]
    active_version: int | None = None
    versions: list[TextStructuringSpecVersionResponse] = Field(default_factory=list)
    created_at: str
    updated_at: str


class TextStructuringSuggestionRequest(CamelModel):
    source_columns: list[dict[str, str]] = Field(default_factory=list)
    sample_rows: list[dict[str, Any]] = Field(default_factory=list)
    source_fields: list[str] = Field(default_factory=list)
    locale: str = "auto"
    include_aspects: bool = True


class TextStructuringSuggestionResponse(CamelModel):
    definition: TextStructuringDefinition
    source: Literal["llm", "fallback"]
    model: str
    warnings: list[str] = Field(default_factory=list)


class TextStructuringPreviewRequest(CamelModel):
    definition: TextStructuringDefinition | None = None
    spec_ref: TextStructuringSpecRef | None = None
    rows: list[dict[str, Any]] = Field(default_factory=list)
    persist_review_items: bool = False

    @model_validator(mode="after")
    def require_definition_or_ref(self) -> "TextStructuringPreviewRequest":
        if self.definition is None and self.spec_ref is None:
            raise ValueError("definition or specRef is required.")
        return self


class TextFieldResultMeta(CamelModel):
    route: str
    confidence: float | None = None
    calibrated: bool = False
    evidence: str | None = None
    warnings: list[str] = Field(default_factory=list)


class TextStructuringResultRow(CamelModel):
    source_row_id: str
    input: dict[str, Any]
    output: dict[str, Any]
    repeated_groups: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
    field_meta: dict[str, TextFieldResultMeta] = Field(default_factory=dict)
    review_required: bool
    review_reasons: list[str] = Field(default_factory=list)
    route: str


class TextStructuringPreviewResponse(CamelModel):
    spec_ref: TextStructuringSpecRef | None = None
    rows: list[TextStructuringResultRow]
    warnings: list[str] = Field(default_factory=list)
    route_breakdown: dict[str, int] = Field(default_factory=dict)


class TextStructuringBatchRequest(CamelModel):
    definition: TextStructuringDefinition
    rows: list[dict[str, Any]]
    run_id: str | None = None
    job_id: str | None = None
    spec_ref: TextStructuringSpecRef | None = None


class TextStructuringBatchResponse(CamelModel):
    rows: list[TextStructuringResultRow]
    route_breakdown: dict[str, int] = Field(default_factory=dict)


class TextReviewItemResponse(CamelModel):
    id: str
    spec_id: str
    spec_version: int
    run_id: str | None = None
    job_id: str | None = None
    source_row_id: str
    source_hash: str
    input_snapshot: dict[str, Any]
    prediction: dict[str, Any]
    correction: dict[str, Any] | None = None
    reasons: list[str] = Field(default_factory=list)
    route: str
    confidence: float | None = None
    status: Literal["pending", "accepted", "corrected", "rejected"]
    created_at: str
    updated_at: str


class UpdateTextReviewItemRequest(CamelModel):
    correction: dict[str, Any] | None = None
    status: Literal["accepted", "corrected", "rejected"]


class CreateTextTrainingRunRequest(CamelModel):
    spec_id: str
    spec_version: int
    task_fields: list[str] = Field(default_factory=list)


class TextTrainingRunResponse(CamelModel):
    id: str
    spec_id: str
    spec_version: int
    status: Literal["queued", "running", "success", "failed"]
    task_fields: list[str] = Field(default_factory=list)
    training_rows: int = 0
    model_id: str | None = None
    metrics: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None
    created_at: str
    updated_at: str


class TextModelResponse(CamelModel):
    id: str
    spec_id: str
    spec_version: int
    status: Literal["candidate", "champion", "retired"]
    provider: str
    model_name: str
    artifact_uri: str | None = None
    task_fields: list[str] = Field(default_factory=list)
    metrics: dict[str, Any] = Field(default_factory=dict)
    created_at: str
    updated_at: str
