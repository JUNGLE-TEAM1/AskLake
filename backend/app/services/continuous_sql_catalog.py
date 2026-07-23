from __future__ import annotations

from typing import Any

from fastapi import status
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

    def resolve_current(
        self,
        dataset_id: str,
        *,
        legacy_binding: dict[str, Any] | None = None,
    ) -> CatalogRelation:
        payload = self.catalog_repository.get_dataset_payload(dataset_id)
        if payload is None:
            raise ContinuousSqlValidationError(
                "CONTINUOUS_SQL_RELATION_MISSING",
                "A bound Catalog Dataset no longer exists.",
                {"datasetId": dataset_id},
            )
        return self._relation(
            payload,
            CatalogDatasetResponse.model_validate(payload),
            legacy_binding=legacy_binding,
        )

    def _relation(
        self,
        payload: dict[str, Any],
        dataset: CatalogDatasetResponse,
        *,
        legacy_binding: dict[str, Any] | None = None,
    ) -> CatalogRelation:
        legacy_mode = str((legacy_binding or {}).get("mode") or "").strip().casefold()
        use_legacy_binding = (
            dataset.relation_mode is None
            and legacy_mode in {"streaming", "static"}
        )
        mode = legacy_mode if use_legacy_binding else self._relation_mode(dataset)
        producer_job = None if use_legacy_binding else self._producer_job(dataset, mode)
        effective_payload = dict(payload)
        if use_legacy_binding and isinstance(
            (legacy_binding or {}).get("streamingSource"),
            dict,
        ):
            effective_payload["streamingSource"] = dict(legacy_binding["streamingSource"])
        normalized_mapping = self._relation_mapping(effective_payload, dataset.id, mode)
        schema, fingerprint, snapshot_id = self._schema_identity(
            effective_payload, dataset.id, producer_job, mode,
        )

        streaming_source = self._streaming_source(effective_payload, producer_job) if mode == "streaming" else None
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
            unique_key_sets=tuple(unique_key_sets(effective_payload)),
            estimated_row_count=parse_row_count(
                effective_payload.get("estimatedRowCount")
                or effective_payload.get("rows")
            ),
            producer_job_id=dataset.producer_job_id,
            producer_job_kind=dataset.producer_job_kind,
            execution_mode=dataset.execution_mode,
            source_kind=dataset.source_kind,
            runtime_status=(producer_job.status if producer_job is not None else dataset.runtime_status),
        )

    def _producer_job(
        self,
        dataset: CatalogDatasetResponse,
        mode: str,
    ) -> ETLJobModel | None:
        producer_job_id = str(dataset.producer_job_id or "").strip()
        metadata = {
            "producerJobKind": dataset.producer_job_kind,
            "executionMode": dataset.execution_mode,
            "sourceKind": dataset.source_kind,
        }
        if not producer_job_id:
            if mode == "streaming":
                raise ContinuousSqlValidationError(
                    "CONTINUOUS_SQL_REALTIME_PRODUCER_REQUIRED",
                    "Streaming Continuous SQL input requires an authoritative Kafka producer Job.",
                    {"datasetId": dataset.id},
                )
            if any(str(value or "").strip() for value in metadata.values()):
                raise ContinuousSqlValidationError(
                    "CONTINUOUS_SQL_INPUT_RELATION_UNSUPPORTED",
                    "Catalog producer metadata is incomplete.",
                    {"datasetId": dataset.id, **metadata},
                )
            return None

        job = self.db.get(ETLJobModel, producer_job_id)
        if job is None or job.dataset_id != dataset.id:
            raise ContinuousSqlValidationError(
                (
                    "CONTINUOUS_SQL_REALTIME_PRODUCER_REQUIRED"
                    if mode == "streaming"
                    else "CONTINUOUS_SQL_INPUT_RELATION_UNSUPPORTED"
                ),
                "Catalog producer metadata does not resolve to the Dataset-producing Job.",
                {"datasetId": dataset.id, "producerJobId": producer_job_id},
            )

        expected_kind = str(dataset.producer_job_kind or "").strip().casefold()
        expected_execution = str(dataset.execution_mode or "").strip().casefold()
        expected_source = str(dataset.source_kind or "").strip().casefold()
        actual_kind = str(job.job_kind or "pipeline").strip().casefold()
        actual_execution = str(job.execution_mode or "snapshot").strip().casefold()
        actual_source = (
            "kafka"
            if is_kafka_producer_job(job)
            else "sql"
            if str(job.source_type or "").strip().casefold() == "sql result"
            else "etl"
        )
        if not all((expected_kind, expected_execution, expected_source)) or (
            expected_kind != actual_kind
            or expected_execution != actual_execution
            or expected_source != actual_source
        ):
            raise ContinuousSqlValidationError(
                "CONTINUOUS_SQL_INPUT_RELATION_UNSUPPORTED",
                "Catalog producer metadata does not match the Dataset-producing Job.",
                {
                    "datasetId": dataset.id,
                    "producerJobId": producer_job_id,
                    "expected": metadata,
                    "actual": {
                        "producerJobKind": actual_kind,
                        "executionMode": actual_execution,
                        "sourceKind": actual_source,
                    },
                },
            )
        if mode == "streaming" and not (
            actual_execution == "continuous" and actual_source == "kafka"
        ):
            raise ContinuousSqlValidationError(
                "CONTINUOUS_SQL_REALTIME_PRODUCER_REQUIRED",
                "Streaming Continuous SQL input must be produced by a Kafka Continuous Job.",
                {"datasetId": dataset.id, "producerJobId": producer_job_id},
            )
        if mode == "static" and actual_execution == "continuous":
            raise ContinuousSqlValidationError(
                "CONTINUOUS_SQL_INPUT_RELATION_UNSUPPORTED",
                "A Continuous producer cannot be bound as a static Continuous SQL input.",
                {"datasetId": dataset.id, "producerJobId": producer_job_id},
            )
        return job

    @staticmethod
    def _relation_mode(dataset: CatalogDatasetResponse) -> str:
        explicit_mode = str(dataset.relation_mode or "").strip().casefold()
        if explicit_mode not in {"streaming", "static"}:
            raise ContinuousSqlValidationError(
                "CONTINUOUS_SQL_RELATION_MODE_REQUIRED",
                "Catalog relationMode is required for Continuous SQL inputs.",
                {"datasetId": dataset.id},
            )
        return explicit_mode

    def _relation_mapping(
        self,
        payload: dict[str, Any],
        dataset_id: str,
        mode: str,
    ) -> dict[str, Any]:
        if mode == "streaming" and self.allow_clickhouse_streaming:
            return self._clickhouse_stream_mapping(payload, dataset_id)
        return self._query_engine_mapping(payload, dataset_id)

    @staticmethod
    def _clickhouse_stream_mapping(
        payload: dict[str, Any],
        dataset_id: str,
    ) -> dict[str, Any]:
        mapping = payload.get("clickhouseTable") or payload.get("clickhouse_table")
        storage_format = str(
            payload.get("storageFormat") or payload.get("storage_format") or ""
        ).strip().casefold()
        if not isinstance(mapping, dict) or storage_format != "clickhouse":
            raise ContinuousSqlValidationError(
                "CONTINUOUS_SQL_STREAM_NOT_CLICKHOUSE_BOUND",
                "ClickHouse V2 streaming relations require an active ClickHouse table binding.",
                {"datasetId": dataset_id},
            )
        database = str(mapping.get("database") or "").strip()
        table = str(mapping.get("table") or "").strip()
        if not database or not table:
            raise ContinuousSqlValidationError(
                "CONTINUOUS_SQL_STREAM_NOT_CLICKHOUSE_BOUND",
                "ClickHouse V2 streaming relations require an active ClickHouse table binding.",
                {"datasetId": dataset_id},
            )
        active_binding = next(
            (
                item
                for item in payload.get("physicalBindings") or []
                if isinstance(item, dict)
                and str(item.get("role") or "").strip().casefold() in {"raw", "serving"}
                and str(item.get("engine") or "").strip().casefold() == "clickhouse"
                and str(item.get("status") or "").strip().casefold() == "active"
                and str(item.get("database") or "").strip() == database
                and str(item.get("table") or "").strip() == table
            ),
            None,
        )
        if active_binding is None:
            raise ContinuousSqlValidationError(
                "CONTINUOUS_SQL_STREAM_NOT_CLICKHOUSE_BOUND",
                "ClickHouse V2 streaming relations require an active ClickHouse table binding.",
                {"datasetId": dataset_id},
            )
        return {
            "catalog": "clickhouse",
            "schema": database,
            "table": table,
            "format": "clickhouse",
            "partitionColumns": [],
        }

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


def is_kafka_producer_job(job: ETLJobModel) -> bool:
    if "kafka" in str(job.source_type or "").casefold():
        return True
    fields = source_config_fields(job.source_config or [])
    return bool(
        (fields.get("broker / endpoint") or fields.get("broker"))
        and (fields.get("topic / queue name") or fields.get("topic"))
    )


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
