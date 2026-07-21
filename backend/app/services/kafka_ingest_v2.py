"""Kafka Continuous ingestion through Kafka Connect and ClickHouse Realtime V2.

This adapter deliberately owns only the source-ingestion path.  It keeps the
existing ETL lifecycle API, but replaces the Spark Structured Streaming side
effect when the deployment has selected ``kafka_connect_v2`` as the canonical
Kafka consumer owner.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
import hashlib
import json
from typing import Any

from fastapi import status
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings, settings
from app.core.database import SessionLocal
from app.core.errors import ApiError
from app.core.permission_metadata import permission_grants_from_roles, resource_permissions
from app.models.catalog import CatalogDatasetModel
from app.models.dashboard_live import DatasetFreshnessModel, DatasetRevisionCommitModel
from app.models.etl import ETLJobModel, KafkaContinuousRuntimeModel
from app.realtime.application.ingest_service import RealtimeIngestService
from app.realtime.infrastructure.kafka_connect_gateway import (
    ConnectorProbe,
    KafkaConnectError,
    KafkaConnectGateway,
)
from app.repositories.catalog_repository import (
    dataset_model_to_payload,
    dataset_payload_to_model_values,
)
from app.repositories.realtime_event_repository import RealtimeEventRepository
from app.services.clickhouse_client import (
    ClickHouseClient,
    ClickHouseError,
    qualified_clickhouse_table,
    quote_clickhouse_string,
)
from app.services.clickhouse_realtime_v2_support import (
    realtime_v2_connector_name,
    realtime_v2_dlq_topic,
)
from app.services.realtime_feature_flags import validate_clickhouse_consumer_ownership


SessionFactory = Callable[[], Session]
ClientFactory = Callable[[], ClickHouseClient]
ConnectorFactory = Callable[[str], KafkaConnectGateway]
IngestServiceFactory = Callable[[Settings], RealtimeIngestService]
_RAW_VIEW = "raw_events_v2_current"
_RAW_TABLE = "raw_events_v2"


def kafka_ingest_v2_enabled(
    job: ETLJobModel,
    runtime_settings: Settings | None = None,
) -> bool:
    """Return whether this regular Kafka Continuous Job must avoid Spark."""

    resolved = runtime_settings or settings
    return (
        job.execution_mode == "continuous"
        and bool(resolved.clickhouse_realtime_v2_enabled)
        and bool(resolved.kafka_connect_sink_enabled)
        and resolved.clickhouse_realtime_consumer_owner == "kafka_connect_v2"
    )


def run_clickhouse_kafka_ingest_v2(
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    action: str,
    options: dict[str, Any] | None = None,
    *,
    runtime_settings: Settings | None = None,
) -> dict[str, Any]:
    return ClickHouseKafkaIngestV2Gateway(runtime_settings).manage(
        job, runtime, action, options
    )


class ClickHouseKafkaIngestV2Gateway:
    """Provision and observe one ETL Kafka topic through the V2 raw sink."""

    def __init__(
        self,
        runtime_settings: Settings | None = None,
        *,
        session_factory: SessionFactory | sessionmaker = SessionLocal,
        client_factory: ClientFactory | None = None,
        connector_factory: ConnectorFactory | None = None,
        ingest_service_factory: IngestServiceFactory | None = None,
    ) -> None:
        self.settings = runtime_settings or settings
        self.session_factory = session_factory
        self.client_factory = client_factory or (
            lambda: ClickHouseClient.realtime_v2_reader(self.settings)
        )
        self.connector_factory = connector_factory or (
            lambda connector_name: KafkaConnectGateway(
                self.settings, connector_name=connector_name
            )
        )
        self.ingest_service_factory = ingest_service_factory or RealtimeIngestService

    def manage(
        self,
        job: ETLJobModel,
        runtime: KafkaContinuousRuntimeModel,
        action: str,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        del options
        if not kafka_ingest_v2_enabled(job, self.settings):
            raise ApiError(
                "CLICKHOUSE_KAFKA_INGEST_V2_DISABLED",
                "Kafka Connect ClickHouse V2 ingestion is not enabled.",
                status.HTTP_409_CONFLICT,
                {"jobId": job.id},
            )
        try:
            if action == "start":
                self._ensure_catalog(job, runtime, published=False, total_rows=0)
                self._register_and_resume(job, runtime)
                return self._status(job, runtime)
            if action == "status":
                return self._status(job, runtime)
            if action in {"pause", "stop", "terminate"}:
                self._pause(job, runtime)
                return self._result(job, "exited", requested_action=action)
            if action == "logs":
                probe = self._probe(job, runtime)
                return {
                    **self._result(job, self._container_state(probe)),
                    "lines": [
                        "Kafka Connect ClickHouse V2 connector "
                        f"{self._connector_name(job, runtime)}: {probe.connector_state}"
                    ],
                    "truncated": False,
                }
            raise ValueError(f"Unsupported Kafka Connect V2 action: {action}")
        except ApiError:
            raise
        except (ClickHouseError, KafkaConnectError, SQLAlchemyError, ValueError) as exc:
            raise ApiError(
                "CLICKHOUSE_KAFKA_INGEST_V2_FAILED",
                str(exc)[:1000],
                status.HTTP_503_SERVICE_UNAVAILABLE,
                {"action": action, "jobId": job.id},
            ) from exc

    def _status(
        self,
        job: ETLJobModel,
        runtime: KafkaContinuousRuntimeModel,
    ) -> dict[str, Any]:
        probe = self._probe(job, runtime)
        if not probe.registered:
            self._ensure_catalog(job, runtime, published=False, total_rows=0)
            self._register_and_resume(job, runtime)
            return self._result(job, "starting")
        if probe.connector_state == "PAUSED":
            return self._result(job, "exited", requested_action="pause")
        states = {probe.connector_state, *probe.task_states}
        if "FAILED" in states:
            connector = self.connector_factory(self._connector_name(job, runtime))
            try:
                connector.restart_failed()
            finally:
                connector.close()
            return self._result(job, "starting")
        if not probe.ready:
            return self._result(job, "starting")

        progress, total_rows = self._raw_progress(runtime.topic)
        if total_rows > 0:
            revision = self._publish_catalog(job, runtime, progress, total_rows)
        else:
            self._ensure_catalog(job, runtime, published=False, total_rows=0)
            revision = None
        return {
            **self._result(job, "running"),
            "clickhouseOffsets": progress,
            "consumedCount": total_rows,
            "storedCount": total_rows,
            "publicationRevision": revision,
        }

    def _register_and_resume(
        self,
        job: ETLJobModel,
        runtime: KafkaContinuousRuntimeModel,
    ) -> None:
        connector_name = self._connector_name(job, runtime)
        validate_clickhouse_consumer_ownership(
            job_id=job.id,
            generation=1,
            configured_owner=self.settings.clickhouse_realtime_consumer_owner,
            claimed_owners=("kafka_connect_v2",),
        )
        self.ingest_service_factory(self.settings).register(
            topic=runtime.topic,
            table=_RAW_TABLE,
            dlq_topic=realtime_v2_dlq_topic(runtime.topic),
            generation=1,
            connector_name=connector_name,
            state_path=self._state_path(job),
        )
        connector = self.connector_factory(connector_name)
        try:
            connector.resume_connector()
        finally:
            connector.close()

    def _pause(
        self,
        job: ETLJobModel,
        runtime: KafkaContinuousRuntimeModel,
    ) -> None:
        connector = self.connector_factory(self._connector_name(job, runtime))
        try:
            probe = connector.probe()
            if probe.registered and probe.connector_state != "PAUSED":
                connector.pause_connector()
        finally:
            connector.close()

    def _probe(
        self,
        job: ETLJobModel,
        runtime: KafkaContinuousRuntimeModel | None,
    ) -> ConnectorProbe:
        connector = self.connector_factory(self._connector_name(job, runtime))
        try:
            return connector.probe()
        finally:
            connector.close()

    def _raw_progress(self, topic: str) -> tuple[list[dict[str, Any]], int]:
        client = self.client_factory()
        try:
            target = qualified_clickhouse_table(self.settings.clickhouse_v2_database, _RAW_VIEW)
            result = client.query(
                "SELECT kafka_partition, min(kafka_offset), max(kafka_offset), "
                "count(), max(ingested_at) "
                f"FROM {target} WHERE scope_id = 'deployment' "
                f"AND kafka_topic = {quote_clickhouse_string(topic)} "
                "GROUP BY kafka_partition ORDER BY kafka_partition"
            )
        finally:
            client.close()
        progress = [
            {
                "partition": int(row[0]),
                "minOffset": int(row[1]),
                "maxOffset": int(row[2]),
                "rowCount": int(row[3]),
                "latestIngestedAt": str(row[4] or ""),
            }
            for row in result.rows
            if len(row) >= 5
        ]
        return progress, sum(item["rowCount"] for item in progress)

    def _ensure_catalog(
        self,
        job: ETLJobModel,
        runtime: KafkaContinuousRuntimeModel,
        *,
        published: bool,
        total_rows: int,
        progress: list[dict[str, Any]] | None = None,
    ) -> tuple[str, int]:
        with self.session_factory() as db:
            result = self._upsert_catalog(
                db,
                job,
                runtime,
                published=published,
                total_rows=total_rows,
                progress=progress or [],
            )
            db.commit()
            return result

    def _publish_catalog(
        self,
        job: ETLJobModel,
        runtime: KafkaContinuousRuntimeModel,
        progress: list[dict[str, Any]],
        total_rows: int,
    ) -> int | None:
        with self.session_factory() as db:
            dataset_id, binding_epoch = self._upsert_catalog(
                db,
                job,
                runtime,
                published=True,
                total_rows=total_rows,
                progress=progress,
            )
            freshness = db.get(DatasetFreshnessModel, dataset_id)
            if freshness is None:
                raise ValueError("Kafka V2 Catalog freshness binding is missing")
            source_boundary = self._source_boundary(job, runtime, progress)
            checksum = hashlib.sha256(
                json.dumps(source_boundary, sort_keys=True, separators=(",", ":")).encode("utf-8")
            ).hexdigest()
            if freshness.latest_checksum == checksum:
                db.commit()
                return int(freshness.latest_revision or 0) or None
            revision = int(freshness.latest_revision or 0) + 1
            version_id = self._version_id(job)
            materialization_id = f"kafka-ingest-v2:{job.id}:{checksum[:32]}"
            now = datetime.now(UTC)
            freshness.latest_revision = revision
            freshness.latest_run_id = materialization_id
            freshness.latest_source_boundary = source_boundary
            freshness.latest_checksum = checksum
            freshness.latest_mutation_type = "append"
            freshness.updated_at = now
            db.add(freshness)
            db.add(DatasetRevisionCommitModel(
                dataset_id=dataset_id,
                revision=revision,
                run_id=materialization_id,
                storage_location=(
                    f"clickhouse://{self.settings.clickhouse_v2_database}/{_RAW_VIEW}"
                ),
                storage_format="clickhouse",
                materialization_mode="delta",
                commit_kind="realtime",
                row_count=total_rows,
                source_ranges=list(source_boundary["partitions"]),
                source_fingerprint=checksum,
                materialization_id=materialization_id,
                source_boundary=source_boundary,
                serving_engine="clickhouse",
                serving_version_id=version_id,
                binding_epoch=binding_epoch,
                dimension_version_ids={},
                mutation_type="append",
                committed_at=now,
            ))
            RealtimeEventRepository(db).append(
                event_type="dataset.revision.committed",
                resource_type="dataset",
                resource_id=dataset_id,
                aggregate_revision=revision,
                correlation_id=materialization_id,
                idempotency_key=f"kafka-ingest-v2:{dataset_id}:{checksum}",
                invalidations=[f"dataset:{dataset_id}"],
                payload={
                    "bindingEpoch": binding_epoch,
                    "materializationId": materialization_id,
                    "mutationType": "append",
                    "sourceBoundary": source_boundary,
                    "servingVersionId": version_id,
                    "pipelineVersionId": version_id,
                },
                occurred_at=now,
                schema_version=2,
            )
            db.commit()
            return revision

    def _upsert_catalog(
        self,
        db: Session,
        job: ETLJobModel,
        runtime: KafkaContinuousRuntimeModel,
        *,
        published: bool,
        total_rows: int,
        progress: list[dict[str, Any]],
    ) -> tuple[str, int]:
        dataset_id = str(job.dataset_id or f"ds_{job.id.lower()}")
        model = db.scalars(
            select(CatalogDatasetModel)
            .where(CatalogDatasetModel.id == dataset_id)
            .with_for_update()
        ).first()
        previous = dataset_model_to_payload(model) if model is not None else {}
        version_id, binding_epoch = self._bind_catalog_freshness(db, job, dataset_id)
        payload = self._catalog_payload(
            job,
            runtime,
            previous,
            dataset_id=dataset_id,
            version_id=version_id,
            binding_epoch=binding_epoch,
            published=published,
            total_rows=total_rows,
        )
        values = dataset_payload_to_model_values(payload)
        if model is None:
            model = CatalogDatasetModel(id=dataset_id, **values)
        else:
            for key, value in values.items():
                setattr(model, key, value)
        db.add(model)
        return dataset_id, binding_epoch

    def _bind_catalog_freshness(
        self,
        db: Session,
        job: ETLJobModel,
        dataset_id: str,
    ) -> tuple[str, int]:
        freshness = db.get(DatasetFreshnessModel, dataset_id)
        version_id = self._version_id(job)
        if freshness is None:
            freshness = DatasetFreshnessModel(
                dataset_id=dataset_id,
                latest_revision=0,
                next_check_after_ms=max(
                    1_000,
                    int((job.continuous_config or {}).get("triggerIntervalSeconds") or 30)
                    * 1_000,
                ),
                binding_epoch=1,
            )
        elif freshness.active_serving_version_id != version_id:
            freshness.binding_epoch = int(freshness.binding_epoch or 0) + 1
        freshness.active_serving_engine = "clickhouse"
        freshness.active_serving_version_id = version_id
        freshness.updated_at = datetime.now(UTC)
        binding_epoch = int(freshness.binding_epoch or 1)
        db.add(freshness)
        return version_id, binding_epoch

    def _catalog_payload(
        self,
        job: ETLJobModel,
        runtime: KafkaContinuousRuntimeModel,
        previous: dict[str, Any],
        *,
        dataset_id: str,
        version_id: str,
        binding_epoch: int,
        published: bool,
        total_rows: int,
    ) -> dict[str, Any]:
        bindings = [
            dict(item)
            for item in previous.get("physicalBindings") or []
            if isinstance(item, dict) and item.get("role") != "serving"
        ]
        bindings.append({
            "role": "serving",
            "engine": "clickhouse",
            "status": "active" if published else "pending",
            "bindingEpoch": binding_epoch,
            "versionId": version_id,
            "pipelineVersionId": version_id,
            "database": self.settings.clickhouse_v2_database,
            "table": _RAW_VIEW,
        })
        now = datetime.now(UTC).isoformat()
        schema = self._schema(job)
        return {
            **previous,
            "clickhouseTable": {
                "database": self.settings.clickhouse_v2_database,
                "table": _RAW_VIEW,
            },
            "createdBy": previous.get("createdBy") or job.created_by,
            "description": previous.get("description") or job.target_description or (
                f"Kafka Connect ClickHouse V2 output for {job.name}"
            ),
            "downstream": previous.get("downstream") or ["Dashboard"],
            "freshness": "realtime",
            "id": dataset_id,
            "lastUpdated": now,
            "layer": job.target_layer,
            "name": job.target,
            "nextRefresh": f"Every {(job.continuous_config or {}).get('triggerIntervalSeconds') or 30} seconds",
            "owner": job.owner,
            "permissionGrants": previous.get("permissionGrants") or permission_grants_from_roles(
                job.owner, default_actions=["view", "query"]
            ),
            "permissions": previous.get("permissions") or resource_permissions(
                can_query=True
            ),
            "physicalBindings": bindings,
            "quality": (
                "Kafka Connect ClickHouse V2 publication verified"
                if published
                else "Kafka Connect ClickHouse V2 waiting for first publication"
            ),
            "queryEngineStatus": "unavailable",
            "rag": bool(previous.get("rag", job.rag)),
            "relationMode": "streaming",
            "rows": f"{total_rows:,}",
            "sampleRows": previous.get("sampleRows") or [],
            "schema": schema,
            "size": "ClickHouse managed",
            "source": job.name,
            "producerJobId": job.id,
            "producerJobKind": getattr(job, "job_kind", None) or "pipeline",
            "executionMode": "continuous",
            "sourceKind": "kafka",
            "runtimeStatus": getattr(runtime, "status", None) or "starting",
            "status": "available" if published else "preparing",
            "storageFormat": "clickhouse",
            "storageLocation": (
                f"clickhouse://{self.settings.clickhouse_v2_database}/{_RAW_VIEW}"
            ),
            "streamingSource": {
                "broker": runtime.broker,
                "consumerGroupId": runtime.consumer_group_id,
                "recordParsing": dict(getattr(job, "record_parsing", None) or {}),
                "topic": runtime.topic,
            },
            "tags": previous.get("tags") or ["kafka", "clickhouse", "realtime-v2"],
            "upstream": previous.get("upstream") or [job.source_label, job.name],
        }

    def _connector_name(
        self,
        job: ETLJobModel,
        runtime: KafkaContinuousRuntimeModel | None,
    ) -> str:
        topic = runtime.topic if runtime is not None else self._topic_from_job(job)
        return realtime_v2_connector_name(
            self.settings.kafka_connect_connector_name,
            f"ingest:{job.id}:{topic}",
        )

    def _state_path(self, job: ETLJobModel) -> str:
        digest = hashlib.sha256(job.id.encode("utf-8")).hexdigest()[:32]
        return f"/asklake/realtime-v2/ingest/{digest}"

    @staticmethod
    def _topic_from_job(job: ETLJobModel) -> str:
        for item in job.source_config or []:
            if not isinstance(item, (list, tuple)) or len(item) < 2:
                continue
            if str(item[0]).strip().casefold() in {"topic", "topic / queue name"}:
                value = str(item[1]).strip()
                if value:
                    return value
        raise ValueError("Kafka V2 ingestion topic is missing")

    @staticmethod
    def _schema(job: ETLJobModel) -> list[list[str]]:
        columns: list[list[str]] = []
        for item in job.schema_columns or []:
            if not isinstance(item, dict) or item.get("included", True) is False:
                continue
            name = str(item.get("targetName") or item.get("sourceName") or "").strip()
            if name:
                columns.append([name, str(item.get("type") or "string").strip() or "string"])
        return columns or [["payload", "string"]]

    @staticmethod
    def _version_id(job: ETLJobModel) -> str:
        return "kiv2_" + hashlib.sha256(job.id.encode("utf-8")).hexdigest()[:48]

    def _source_boundary(
        self,
        job: ETLJobModel,
        runtime: KafkaContinuousRuntimeModel,
        progress: list[dict[str, Any]],
    ) -> dict[str, Any]:
        return {
            "kind": "kafka_connect_clickhouse_v2",
            "jobId": job.id,
            "topic": runtime.topic,
            "partitions": [
                {
                    "partition": item["partition"],
                    "startOffset": item["minOffset"],
                    "endOffset": item["maxOffset"] + 1,
                }
                for item in progress
            ],
        }

    def _result(
        self,
        job: ETLJobModel,
        container_state: str,
        *,
        requested_action: str | None = None,
    ) -> dict[str, Any]:
        result: dict[str, Any] = {
            "containerState": container_state,
            "worker": "kafka_connect_clickhouse_v2",
            "workerAttemptId": f"kafka-connect-v2:{self._version_id(job)}",
        }
        if requested_action:
            result["requestedAction"] = requested_action
        return result

    @staticmethod
    def _container_state(probe: ConnectorProbe) -> str:
        if probe.connector_state == "PAUSED":
            return "exited"
        if probe.ready:
            return "running"
        return "starting"
