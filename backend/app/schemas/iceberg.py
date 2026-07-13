from typing import Any, Literal

from pydantic import Field, computed_field, field_validator

from app.schemas.catalog import QueryEngineTableRef
from app.schemas.common import CamelModel

IcebergWriteMode = Literal["append", "replace"]


class IcebergWriterTarget(CamelModel):
    catalog: str
    namespace: str
    table: str
    write_mode: IcebergWriteMode
    partition_columns: list[str] = Field(default_factory=list)

    @field_validator("catalog", "namespace", "table")
    @classmethod
    def validate_identifier(cls, value: str) -> str:
        normalized = str(value or "").strip()
        invalid_characters = ('"', "'", ";", "\x00")
        if (
            not normalized
            or len(normalized) > 255
            or any(character in normalized for character in invalid_characters)
        ):
            raise ValueError("Iceberg target identifiers must be non-empty quoted-SQL-safe values")
        return normalized

    @field_validator("partition_columns")
    @classmethod
    def normalize_partition_columns(cls, value: list[str]) -> list[str]:
        normalized: list[str] = []
        for column in value:
            name = str(column or "").strip()
            if not name or name in normalized:
                continue
            if len(name) > 255 or any(
                character in name for character in ('"', "'", ";", "\x00")
            ):
                raise ValueError("Iceberg partition columns must be quoted-SQL-safe values")
            normalized.append(name)
        return normalized

    @computed_field(alias="tableUri", return_type=str)
    @property
    def table_uri(self) -> str:
        return f"iceberg://{self.catalog}/{self.namespace}/{self.table}"

    def query_engine_table(self) -> QueryEngineTableRef:
        return QueryEngineTableRef(
            catalog=self.catalog,
            schema=self.namespace,
            table=self.table,
            format="iceberg",
            partition_columns=self.partition_columns,
        )


class IcebergCommitEvidence(CamelModel):
    created_table: bool
    job_id: str
    run_id: str
    target: IcebergWriterTarget
    query_engine_table: QueryEngineTableRef
    query_engine_verified: Literal[True] = True
    snapshot_id: str
    committed_at: str
    warehouse_location: str
    schema_fingerprint: str | None = None
    rule_fingerprint: str | None = None
    source_boundary: dict[str, Any] = Field(default_factory=dict)
