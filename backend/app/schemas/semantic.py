from typing import Any, Literal

from pydantic import Field

from app.schemas.common import CamelModel
from app.schemas.permissions import PermissionGrant, ResourcePermissions


SemanticStatus = Literal["draft", "published", "archived"]


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
    schema_: list[SemanticSchemaColumn] = Field(default_factory=list, alias="schema")
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
