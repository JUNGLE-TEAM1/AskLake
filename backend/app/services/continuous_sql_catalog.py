from __future__ import annotations

from typing import Any

from fastapi import status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, require_permission
from app.core.errors import ApiError
from app.models.etl import ETLJobModel, KafkaContinuousRuntimeModel
from app.repositories.catalog_repository import CatalogRepository
from app.schemas.catalog import CatalogDatasetResponse
from app.schemas.common import ErrorCode
from app.services.continuous_sql_planner import (
    CatalogRelation,
    ContinuousSqlValidationError,
    normalize_identifier,
    schema_fingerprint,
)
from app.services.governance_enforcement import require_governed_access
from app.services.resource_permission_service import dataset_with_persisted_permission_grants


class ContinuousSqlCatalogResolver:
    def __init__(
        self,
        db: Session,
        *,
        allow_clickhouse_streaming: bool = False,
    ) -> None:
        self.db = db
        self.catalog_repository = CatalogRepository(db)
        self.allow_clickhouse_streaming = allow_clickhouse_streaming

    def resolve_authorized(
        self,
        dataset_ids: list[str],
        actor: ActorContext,
        *,
        api_path: str,
        http_method: str = "POST",
    ) -> list[CatalogRelation]:
        relations: list[CatalogRelation] = []
        for dataset_id in dataset_ids:
            payload = self.catalog_repository.get_dataset_payload(dataset_id)
            if payload is None:
                raise ApiError(
                    ErrorCode.NOT_FOUND,
                    "Continuous SQL relation Dataset not found.",
                    status.HTTP_404_NOT_FOUND,
                    {"datasetId": dataset_id},
                )
            dataset = dataset_with_persisted_permission_grants(
                self.db,
                CatalogDatasetResponse.model_validate(payload),
            )
            require_governed_access(
                self.db,
                actor,
                action="query",
                api_path=api_path,
                http_method=http_method,
                resource_id=dataset.id,
                resource_name=dataset.name,
                resource_type="dataset",
            )
            require_permission(
                actor,
                "query",
                owner=dataset.owner,
                grants=dataset.permission_grants,
                resource_label="dataset",
            )
            relations.append(self._relation(payload, dataset))
        return relations

    def resolve_current(self, dataset_id: str) -> CatalogRelation:
        payload = self.catalog_repository.get_dataset_payload(dataset_id)
        if payload is None:
            raise ContinuousSqlValidationError(
                "CONTINUOUS_SQL_RELATION_MISSING",
                "A bound Catalog Dataset no longer exists.",
                {"datasetId": dataset_id},
            )
        return self._relation(payload, CatalogDatasetResponse.model_validate(payload))

    def _relation(
        self,
        payload: dict[str, Any],
        dataset: CatalogDatasetResponse,
    ) -> CatalogRelation:
        stream_job = self._stream_job(dataset.id)
        mode = self._relation_mode(payload, dataset.id, stream_job)
        normalized_mapping = self._relation_mapping(payload, dataset.id, mode)
        schema, fingerprint, snapshot_id = self._schema_identity(
            payload, dataset.id, stream_job, mode,
        )

        streaming_source = self._streaming_source(payload, stream_job) if mode == "streaming" else None
        if mode == "streaming" and not streaming_source:
            raise ContinuousSqlValidationError(
                "CONTINUOUS_SQL_STREAM_SOURCE_UNRESOLVED",
                "Streaming relation is not connected to a Kafka Continuous source.",
                {"datasetId": dataset.id},
            )

        identifiers = unique_identifiers([
            dataset.id,
            dataset.name,
            normalized_mapping["table"],
            f"{normalized_mapping['schema']}.{normalized_mapping['table']}",
            f"{normalized_mapping['catalog']}.{normalized_mapping['schema']}.{normalized_mapping['table']}",
        ])
        return CatalogRelation(
            dataset_id=dataset.id,
            dataset_name=dataset.name,
            identifiers=tuple(identifiers),
            mode=mode,
            query_engine_table=normalized_mapping,
            schema=tuple(schema),
            schema_fingerprint=fingerprint,
            snapshot_id=snapshot_id,
            streaming_source=streaming_source,
            unique_key_sets=tuple(unique_key_sets(payload)),
            estimated_row_count=parse_row_count(payload.get("estimatedRowCount") or payload.get("rows")),
        )

    def _stream_job(self, dataset_id: str) -> ETLJobModel | None:
        return self.db.scalars(
            select(ETLJobModel)
            .where(
                ETLJobModel.dataset_id == dataset_id,
                ETLJobModel.execution_mode == "continuous",
                ETLJobModel.source_type.ilike("%kafka%"),
            )
            .order_by(ETLJobModel.updated_at.desc(), ETLJobModel.created_at.desc())
            .limit(1)
        ).first()

    @staticmethod
    def _relation_mode(
        payload: dict[str, Any],
        dataset_id: str,
        stream_job: ETLJobModel | None,
    ) -> str:
        explicit_mode = str(
            payload.get("relationMode") or payload.get("relation_mode") or ""
        ).strip().casefold()
        if explicit_mode and explicit_mode not in {"streaming", "static"}:
            raise ContinuousSqlValidationError(
                "CONTINUOUS_SQL_RELATION_MODE_INVALID",
                "Catalog relationMode must be streaming or static.",
                {"datasetId": dataset_id, "relationMode": explicit_mode},
            )
        return explicit_mode or ("streaming" if stream_job is not None else "static")

    def _relation_mapping(
        self,
        payload: dict[str, Any],
        dataset_id: str,
        mode: str,
    ) -> dict[str, Any]:
        return self._query_engine_mapping(payload, dataset_id)

    @staticmethod
    def _query_engine_mapping(payload: dict[str, Any], dataset_id: str) -> dict[str, Any]:
        mapping = payload.get("queryEngineTable") or payload.get("query_engine_table")
        query_engine_status = str(
            payload.get("queryEngineStatus") or payload.get("query_engine_status") or ""
        ).strip().casefold()
        if not isinstance(mapping, dict) or query_engine_status != "available":
            raise ContinuousSqlValidationError(
                "CONTINUOUS_SQL_RELATION_NOT_QUERYABLE",
                "Continuous SQL relations require an available Iceberg query-engine table.",
                {"datasetId": dataset_id, "queryEngineStatus": query_engine_status or "unavailable"},
            )
        normalized = {
            "catalog": str(mapping.get("catalog") or "").strip(),
            "schema": str(mapping.get("schema") or mapping.get("namespace") or "").strip(),
            "table": str(mapping.get("table") or "").strip(),
            "format": str(mapping.get("format") or "").strip().casefold(),
            "partitionColumns": [str(item) for item in mapping.get("partitionColumns") or []],
        }
        if not all(normalized[key] for key in ("catalog", "schema", "table")) or normalized["format"] != "iceberg":
            raise ContinuousSqlValidationError(
                "CONTINUOUS_SQL_RELATION_NOT_ICEBERG",
                "Continuous SQL V1 requires Iceberg Catalog relations.",
                {"datasetId": dataset_id},
            )
        return normalized

    @staticmethod
    def _schema_identity(
        payload: dict[str, Any],
        dataset_id: str,
        stream_job: ETLJobModel | None,
        mode: str,
    ) -> tuple[list[tuple[str, str]], str, str | None]:
        schema = normalize_schema(payload.get("schema") or payload.get("schema_json") or [])
        if not schema:
            raise ContinuousSqlValidationError(
                "CONTINUOUS_SQL_SCHEMA_MISSING",
                "Continuous SQL relation requires a Catalog schema.",
                {"datasetId": dataset_id},
            )
        fingerprint = str(
            payload.get("schemaFingerprint")
            or payload.get("schema_fingerprint")
            or (stream_job.schema_fingerprint if stream_job is not None else "")
            or schema_fingerprint(schema)
        ).strip()
        snapshot_id = current_snapshot_id(payload)
        if mode == "static" and not snapshot_id:
            raise ContinuousSqlValidationError(
                "CONTINUOUS_SQL_STATIC_SNAPSHOT_MISSING",
                "Static Continuous SQL relations require a committed Iceberg snapshot.",
                {"datasetId": dataset_id},
            )
        return schema, fingerprint, snapshot_id

    def _streaming_source(
        self,
        payload: dict[str, Any],
        job: ETLJobModel | None,
    ) -> dict[str, Any] | None:
        explicit = payload.get("streamingSource") or payload.get("streaming_source")
        explicit = dict(explicit) if isinstance(explicit, dict) else {}
        runtime = self.db.get(KafkaContinuousRuntimeModel, job.id) if job is not None else None
        fields = source_config_fields(job.source_config if job is not None else [])
        topic = first_text(
            explicit.get("topic"),
            runtime.topic if runtime is not None else None,
            fields.get("topic / queue name"),
            fields.get("topic"),
        )
        broker = first_text(
            explicit.get("broker"),
            runtime.broker if runtime is not None else None,
            fields.get("broker / endpoint"),
            fields.get("broker"),
        )
        consumer_group_id = first_text(
            explicit.get("consumerGroupId"),
            explicit.get("consumer_group_id"),
            runtime.consumer_group_id if runtime is not None else None,
            fields.get("consumer group id"),
        )
        if not topic or not broker or not consumer_group_id:
            return None
        return {
            "broker": broker,
            "topic": topic,
            "consumerGroupId": consumer_group_id,
            "initialOffsetPolicy": str(
                explicit.get("initialOffsetPolicy")
                or ((job.continuous_config or {}).get("initialOffsetPolicy") if job is not None else "")
                or "earliest"
            ),
            "maxOffsetsPerTrigger": int(
                explicit.get("maxOffsetsPerTrigger")
                or ((job.continuous_config or {}).get("maxOffsetsPerTrigger") if job is not None else 0)
                or 10_000
            ),
            "schemaColumns": list(job.schema_columns or []) if job is not None else list(explicit.get("schemaColumns") or []),
            "schemaFingerprint": str(
                explicit.get("schemaFingerprint")
                or (job.schema_fingerprint if job is not None else "")
                or ""
            ),
            "recordParsing": dict(job.record_parsing or {}) if job is not None else dict(explicit.get("recordParsing") or {}),
        }


def normalize_schema(value: Any) -> list[tuple[str, str]]:
    normalized: list[tuple[str, str]] = []
    for item in value if isinstance(value, list) else []:
        if isinstance(item, dict):
            name = str(item.get("name") or item.get("targetName") or "").strip()
            type_name = str(item.get("type") or item.get("targetType") or "string").strip()
        elif isinstance(item, (list, tuple)) and item:
            name = str(item[0] or "").strip()
            type_name = str(item[1] if len(item) > 1 else "string").strip()
        else:
            continue
        if name and normalize_identifier(name) not in {normalize_identifier(existing[0]) for existing in normalized}:
            normalized.append((name, type_name or "string"))
    return normalized


def current_snapshot_id(payload: dict[str, Any]) -> str | None:
    direct = str(payload.get("icebergSnapshotId") or payload.get("iceberg_snapshot_id") or "").strip()
    if direct:
        return direct
    runs = payload.get("materializationRuns") or payload.get("materialization_runs") or []
    for run in reversed(runs if isinstance(runs, list) else []):
        if not isinstance(run, dict) or str(run.get("status") or "").casefold() != "success":
            continue
        snapshot_id = str(run.get("icebergSnapshotId") or run.get("iceberg_snapshot_id") or "").strip()
        if snapshot_id:
            return snapshot_id
    return None


def unique_key_sets(payload: dict[str, Any]) -> list[tuple[str, ...]]:
    results: list[tuple[str, ...]] = []
    explicit_sets = payload.get("uniqueKeySets") or payload.get("unique_key_sets") or []
    for value in explicit_sets if isinstance(explicit_sets, list) else []:
        if isinstance(value, (list, tuple)):
            key_set = tuple(normalize_identifier(item) for item in value if str(item or "").strip())
            if key_set and key_set not in results:
                results.append(key_set)
    unique_columns = payload.get("uniqueKeyColumns") or payload.get("unique_key_columns") or []
    for value in unique_columns if isinstance(unique_columns, list) else []:
        key_set = (normalize_identifier(value),)
        if key_set[0] and key_set not in results:
            results.append(key_set)
    index_columns = payload.get("indexColumns") or payload.get("index_columns") or []
    indexes_are_unique = payload.get("indexColumnsUnique") is True or payload.get("index_columns_unique") is True
    if indexes_are_unique and isinstance(index_columns, list):
        key_set = tuple(normalize_identifier(value) for value in index_columns if str(value or "").strip())
        if key_set and key_set not in results:
            results.append(key_set)
    return results


def parse_row_count(value: Any) -> int | None:
    digits = "".join(character for character in str(value or "") if character.isdigit())
    return int(digits) if digits else None


def source_config_fields(value: Any) -> dict[str, str]:
    fields: dict[str, str] = {}
    for item in value if isinstance(value, list) else []:
        if isinstance(item, (list, tuple)) and len(item) >= 2:
            key = str(item[0] or "").strip().casefold()
            field_value = str(item[1] or "").strip()
            if key and field_value:
                fields[key] = field_value
    return fields


def first_text(*values: Any) -> str:
    for value in values:
        normalized = str(value or "").strip()
        if normalized:
            return normalized
    return ""


def unique_identifiers(values: list[str]) -> list[str]:
    results: list[str] = []
    seen: set[str] = set()
    for value in values:
        normalized = normalize_identifier(value)
        if normalized and normalized not in seen:
            results.append(value)
            seen.add(normalized)
    return results
