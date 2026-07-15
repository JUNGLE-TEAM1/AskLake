from datetime import datetime
from typing import Any, Literal

from pydantic import Field

from app.schemas.common import CamelModel
from app.schemas.permissions import PermissionGrant, ResourcePermissions


SemanticStatus = Literal["draft", "published", "archived"]
RagReviewState = Literal["not_configured", "classifying", "candidate", "needs_review", "approved", "excluded", "failed"]
RagIndexStatus = Literal["not_indexed", "stale", "queued", "staging", "chunking", "embedding", "indexing", "validating", "ready", "failed", "canceled"]
RagEmbeddingStatus = Literal["not_started", "pending", "generating", "ready", "failed"]
RagServingStatus = Literal["not_serving", "serving", "stale", "unavailable"]
RagFilterOperator = Literal["eq", "gte", "gt", "lte", "lt"]


class SemanticDatasetInput(CamelModel):
    dataset_id: str = Field(min_length=1, max_length=255)
    role: Literal["source", "lookup"] = "source"
    join_config: dict[str, Any] = Field(default_factory=dict)


class SemanticSchemaColumn(CamelModel):
    name: str
    data_type: str = "unknown"
    description: str = ""
    sample_values: list[str] = Field(default_factory=list)


class SemanticMetricInput(CamelModel):
    name: str = Field(min_length=1, max_length=255)
    label: str = Field(min_length=1, max_length=255)
    description: str = ""
    expression: str = Field(min_length=1, max_length=10_000)
    dataset_id: str | None = None
    source_columns: list[str] = Field(default_factory=list, max_length=50)
    format: str | None = None


class SemanticDimensionInput(CamelModel):
    name: str = Field(min_length=1, max_length=255)
    label: str = Field(min_length=1, max_length=255)
    description: str = ""
    column_name: str = Field(min_length=1, max_length=255)
    dataset_id: str | None = None
    data_type: str | None = None


class SemanticRelationshipInput(CamelModel):
    from_dataset_id: str = Field(min_length=1, max_length=255)
    to_dataset_id: str = Field(min_length=1, max_length=255)
    relationship_type: str = "many_to_one"
    join_expression: str = Field(min_length=1, max_length=10_000)


class SemanticVocabularyInput(CamelModel):
    term: str = Field(min_length=1, max_length=255)
    synonyms: list[str] = Field(default_factory=list, max_length=100)


class SemanticModelCreate(CamelModel):
    name: str = Field(min_length=1, max_length=255)
    description: str = ""
    datasets: list[SemanticDatasetInput] = Field(default_factory=list, max_length=100)
    metrics: list[SemanticMetricInput] = Field(default_factory=list, max_length=200)
    dimensions: list[SemanticDimensionInput] = Field(default_factory=list, max_length=200)
    relationships: list[SemanticRelationshipInput] = Field(default_factory=list, max_length=100)
    vocabulary: list[SemanticVocabularyInput] = Field(default_factory=list, max_length=500)
    permission_grants: list[PermissionGrant] = Field(default_factory=list, max_length=100)


class SemanticModelPatch(CamelModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None


class SemanticItem(CamelModel):
    id: str
    name: str | None = None
    label: str | None = None
    description: str | None = None
    expression: str | None = None
    dataset_id: str | None = None
    source_columns: list[str] = Field(default_factory=list)
    column_name: str | None = None
    data_type: str | None = None
    format: str | None = None
    from_dataset_id: str | None = None
    to_dataset_id: str | None = None
    relationship_type: str | None = None
    join_expression: str | None = None
    term: str | None = None
    synonyms: list[str] = Field(default_factory=list)


class SemanticDataset(CamelModel):
    id: str
    dataset_id: str
    role: str
    join_config: dict[str, Any] = Field(default_factory=dict)
    name: str | None = None
    description: str = ""
    layer: str | None = None
    rows: str | None = None
    schema: list[SemanticSchemaColumn] = Field(default_factory=list)
    schema_fingerprint: str | None = None


class SemanticModelResponse(CamelModel):
    id: str
    name: str
    description: str
    owner: str
    status: SemanticStatus
    version: int
    published_version: int | None = None
    permission_grants: list[PermissionGrant] = Field(default_factory=list)
    permissions: ResourcePermissions = Field(default_factory=ResourcePermissions)
    datasets: list[SemanticDataset] = Field(default_factory=list)
    metrics: list[SemanticItem] = Field(default_factory=list)
    dimensions: list[SemanticItem] = Field(default_factory=list)
    relationships: list[SemanticItem] = Field(default_factory=list)
    vocabulary: list[SemanticItem] = Field(default_factory=list)


class SemanticValidationResponse(CamelModel):
    valid: bool
    errors: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class SemanticPublishResponse(CamelModel):
    model: SemanticModelResponse
    published_version: int


class RagColumnRecommendation(CamelModel):
    id: str
    column_name: str
    role: Literal["body", "title", "metadata", "identifier", "excluded"]
    confidence: float
    reason: str
    approved: bool


class RagProfileResponse(CamelModel):
    dataset_id: str
    review_state: RagReviewState
    index_status: RagIndexStatus
    build_status: RagIndexStatus
    serving_status: RagServingStatus
    embedding_status: RagEmbeddingStatus
    schema: list[SemanticSchemaColumn] = Field(default_factory=list)
    schema_fingerprint: str | None = None
    body_columns: list[str] = Field(default_factory=list)
    title_columns: list[str] = Field(default_factory=list)
    metadata_columns: list[str] = Field(default_factory=list)
    identifier_columns: list[str] = Field(default_factory=list)
    excluded_columns: list[str] = Field(default_factory=list)
    classifier: str | None = None
    classifier_confidence: float | None = None
    target_alias: str | None = None
    active_index: str | None = None
    active_source_fingerprint: str | None = None
    active_embedding_model: str | None = None
    active_embedding_dimensions: int | None = None
    active_chunking_version: str | None = None
    last_error: str | None = None
    semantic_bindings: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
    physical_column_mapping: dict[str, str] = Field(default_factory=dict)
    recommendations: list[RagColumnRecommendation] = Field(default_factory=list)


class RagClassifyResponse(CamelModel):
    run_id: str
    dataset_id: str
    status: str


class RagApproveRequest(CamelModel):
    body_columns: list[str] = Field(min_length=1, max_length=50)
    title_columns: list[str] = Field(default_factory=list, max_length=20)
    metadata_columns: list[str] = Field(default_factory=list, max_length=100)
    identifier_columns: list[str] = Field(default_factory=list, max_length=20)
    excluded_columns: list[str] = Field(default_factory=list, max_length=100)


class RagDocumentPreview(CamelModel):
    document_id: str
    parent_document_id: str | None = None
    chunk_index: int = 0
    start_sentence: int = 0
    end_sentence: int = 0
    dataset_id: str
    source_row_id: str
    body: str
    title: str | None = None
    filter_terms: dict[str, str] = Field(default_factory=dict)
    metadata_filter: dict[str, dict[str, Any]] = Field(default_factory=dict)
    metadata_display: dict[str, Any] = Field(default_factory=dict)
    semantic_bindings: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
    source_dataset: str
    source_columns: list[str] = Field(default_factory=list)
    target_index: str
    embedding_status: str
    content_hash: str
    embedding_text: str = ""
    chunking_strategy: str = "pending"
    chunking_version: str = "rag-chunk-v3"
    source_fields: list[dict[str, Any]] = Field(default_factory=list)
    embedding_input_version: str = "title_body_fields_v2"
    field_rendering_version: str = "field_blocks_v1"


class RagDocumentPreviewResponse(CamelModel):
    dataset_id: str
    target_alias: str
    source_columns: list[str]
    documents: list[RagDocumentPreview]


class RagFilterPredicate(CamelModel):
    operator: RagFilterOperator
    value: Any


class RagSearchRequest(CamelModel):
    query: str = Field(min_length=1, max_length=4_000)
    filters: dict[str, RagFilterPredicate] = Field(default_factory=dict, max_length=100)


class RagSearchResponse(CamelModel):
    sources: list[dict[str, Any]] = Field(default_factory=list)
    retrieval: dict[str, Any] = Field(default_factory=dict)


class RagIndexResponse(CamelModel):
    job_id: str
    dataset_id: str
    status: str
    target_index: str | None = None


class RagIndexRequest(CamelModel):
    idempotency_key: str | None = Field(default=None, min_length=1, max_length=255)


class RagJobResponse(CamelModel):
    job_id: str
    dataset_id: str
    status: str
    requested_mode: str
    target_index: str | None = None
    document_count: int
    indexed_count: int
    parent_count: int = 0
    chunk_count: int = 0
    failed_count: int = 0
    row_count: int = 0
    failed_row_rate: float = 0.0
    failed_row_rate_threshold: float = 0.05
    failed_row_report: dict[str, Any] = Field(default_factory=dict)
    fallback_count: int = 0
    fallback_reasons: dict[str, int] = Field(default_factory=dict)
    stage: str = "queued"
    source_fingerprint: str | None = None
    policy_fingerprint: str | None = None
    embedding_model: str | None = None
    embedding_dimensions: int | None = None
    parent_table: str | None = None
    chunk_table: str | None = None
    checkpoint_path: str | None = None
    error: str | None = None
    airflow_run_id: str | None = None
    generation: int = 0
    validation_status: str = "pending"
    physical_column_mapping: dict[str, str] = Field(default_factory=dict)
    validated_at: datetime | None = None
    activation_status: str = "none"
    activation_alias: str | None = None
    activation_target_index: str | None = None
