from __future__ import annotations

from collections.abc import Callable, Iterable
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
import hashlib
import json
import os
import socket
from typing import Any
from uuid import uuid4

from fastapi import status
from sqlalchemy import select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings, settings
from app.core.database import SessionLocal
from app.core.errors import ApiError
from app.core.permission_metadata import permission_grants_from_roles, resource_permissions
from app.models.catalog import CatalogDatasetModel
from app.models.continuous_sql import ContinuousSqlJobModel, ContinuousSqlRunModel
from app.models.dashboard_live import DatasetFreshnessModel
from app.realtime.application.dimension_publish_worker import DimensionPublishEvidence
from app.realtime.application.ingest_service import RealtimeIngestService
from app.realtime.application.materializer import RealtimeMaterializer
from app.realtime.domain.dimension import DimensionRow, default_missing_policy
from app.realtime.domain.publication import RealtimePublication
from app.realtime.domain.receipt import audit_receipt_range
from app.realtime.domain.source_boundary import PartitionBoundary, SourceBoundary
from app.realtime.domain.source_position import SourcePosition
from app.realtime.infrastructure.kafka_connect_gateway import (
    KafkaConnectError,
    KafkaConnectGateway,
)
from app.realtime.repositories.dimension_repository import DimensionRepository
from app.realtime.repositories.materialization_repository import MaterializationRepository
from app.realtime.repositories.publication_repository import RealtimePublicationRepository
from app.realtime.repositories.receipt_repository import ReceiptRepository
from app.realtime.sql.clickhouse_compiler import ClickHouseRealtimeCompiler
from app.realtime.sql.validator import RealtimeRelation, RealtimeSqlPlan
from app.repositories.catalog_repository import (
    dataset_model_to_payload,
    dataset_payload_to_model_values,
)
from app.services.clickhouse_client import (
    ClickHouseClient,
    ClickHouseError,
    qualified_clickhouse_table,
    quote_clickhouse_string,
)
from app.services.clickhouse_continuous_sql import (
    continuous_sql_static_join_columns,
    relation_schema,
)
from app.services.continuous_sql_planner import CompiledContinuousSqlPlan
from app.services.iceberg_dataset_reader import execute_trino_rows, quote_trino_identifier
from app.services.realtime_feature_flags import validate_clickhouse_consumer_ownership
from app.services.trino_client import TrinoClient


SessionFactory = Callable[[], Session]
ClientFactory = Callable[[], ClickHouseClient]
_OWNER_ID = f"{socket.gethostname()}:{os.getpid()}:{uuid4().hex[:8]}"
_SERVING_TABLE = "serving_events_v2"
_SERVING_VIEW = "serving_current_v2"
_RAW_VIEW = "raw_events_v2_current"
_DIMENSION_INSERT_BATCH_ROWS = 5_000


class ClickHouseRealtimeV2WorkerGateway:
    """Connect Continuous SQL Jobs to the Kafka Connect -> V2 serving path."""

    def __init__(
        self,
        runtime_settings: Settings | None = None,
        *,
        client_factory: ClientFactory | None = None,
        trino_client: TrinoClient | None = None,
        session_factory: SessionFactory | sessionmaker = SessionLocal,
    ) -> None:
        self.settings = runtime_settings or settings
        self.client_factory = client_factory or (
            lambda: ClickHouseClient.realtime_v2_materializer(self.settings)
        )
        self.trino_client = trino_client or TrinoClient(self.settings)
        self.session_factory = session_factory

    def manage(
        self,
        job: ContinuousSqlJobModel,
        run: ContinuousSqlRunModel | None,
        action: str,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        del options
        try:
            if action == "start":
                if run is None:
                    raise ValueError("ClickHouse Realtime V2 start requires an active run")
                self._provision(job, run)
                return self._status(job, run)
            if action == "status":
                if run is None:
                    return self._worker_result(job, "missing")
                if not self._control_plane_ready(job, run):
                    self._provision(job, run)
                return self._status(job, run)
            if action == "pause":
                self._set_pipeline_state(job, run, desired_state="paused", retire=False)
                return self._worker_result(job, "not_running")
            if action in {"stop", "terminate"}:
                self._set_pipeline_state(job, run, desired_state="stopped", retire=True)
                return self._worker_result(job, "not_running")
            if action == "ack":
                return self._worker_result(job, "running")
            raise ValueError(f"Unsupported ClickHouse Realtime V2 action: {action}")
        except ApiError:
            raise
        except (
            ClickHouseError,
            KafkaConnectError,
            RuntimeError,
            SQLAlchemyError,
            ValueError,
        ) as exc:
            code = getattr(exc, "code", "CLICKHOUSE_REALTIME_V2_FAILED")
            raise ApiError(
                str(code),
                str(exc)[:1000],
                status.HTTP_503_SERVICE_UNAVAILABLE,
                {"jobId": job.id, "action": action},
            ) from exc

    def _provision(
        self,
        job: ContinuousSqlJobModel,
        run: ContinuousSqlRunModel,
    ) -> None:
        validate_clickhouse_consumer_ownership(
            job_id=job.id,
            generation=int(run.generation),
            configured_owner=self.settings.clickhouse_realtime_consumer_owner,
            claimed_owners=("kafka_connect_v2",),
        )
        client = self.client_factory()
        try:
            dimension_versions = self._publish_dimensions(client, job, run)
            plan = build_realtime_v2_plan(
                job,
                run,
                dimension_version_ids=dimension_versions,
                database=self.settings.clickhouse_v2_database,
            )
            self._initialize_control_plane(job, run, plan)
        finally:
            client.close()
        self._register_connector(job, run)

    def _register_connector(
        self,
        job: ContinuousSqlJobModel,
        run: ContinuousSqlRunModel,
    ) -> None:
        topic = realtime_v2_topic(job)
        RealtimeIngestService(self.settings).register(
            topic=topic,
            table="raw_events_v2",
            dlq_topic=realtime_v2_dlq_topic(topic),
            generation=int(run.generation),
            connector_name=realtime_v2_connector_name(
                self.settings.kafka_connect_connector_name,
                topic,
            ),
            state_path="/asklake/realtime-v2/connect-state",
        )
        gateway = KafkaConnectGateway(
            self.settings,
            connector_name=realtime_v2_connector_name(
                self.settings.kafka_connect_connector_name,
                topic,
            ),
        )
        try:
            gateway.resume_connector()
        finally:
            gateway.close()

    def _status(
        self,
        job: ContinuousSqlJobModel,
        run: ContinuousSqlRunModel,
    ) -> dict[str, Any]:
        connector_name = realtime_v2_connector_name(
            self.settings.kafka_connect_connector_name,
            realtime_v2_topic(job),
        )
        ingest = RealtimeIngestService(self.settings)
        probe = ingest.probe(connector_name=connector_name)
        if not probe.registered:
            self._register_connector(job, run)
            return self._worker_result(job, "starting")
        states = {probe.connector_state, *probe.task_states}
        if "FAILED" in states:
            gateway = KafkaConnectGateway(
                self.settings,
                connector_name=connector_name,
            )
            try:
                gateway.restart_failed()
            finally:
                gateway.close()
            return self._worker_result(job, "starting")
        if not probe.ready:
            return self._worker_result(job, "starting")

        client = self.client_factory()
        try:
            publication = self._materialize_once(client, job, run)
            progress = self._raw_progress(client, realtime_v2_topic(job))
            output_row_count = self._output_row_count(client, job, run)
        finally:
            client.close()
        return self._worker_result(
            job,
            "running",
            progress=progress,
            output_row_count=output_row_count,
            publication_revision=(publication.revision if publication is not None else None),
        )

    def _publish_dimensions(
        self,
        client: ClickHouseClient,
        job: ContinuousSqlJobModel,
        run: ContinuousSqlRunModel,
    ) -> dict[str, str]:
        bindings = {
            str(item.get("datasetId") or ""): item
            for item in run.static_bindings or []
            if isinstance(item, dict)
        }
        versions: dict[str, str] = {}
        for relation in job.relation_bindings or []:
            if not isinstance(relation, dict) or relation.get("mode") != "static":
                continue
            dataset_id = str(relation.get("datasetId") or "").strip()
            binding = bindings.get(dataset_id)
            if not dataset_id or binding is None:
                raise ValueError("Pinned V2 dimension binding is missing")
            snapshot_id = str(binding.get("snapshotId") or "").strip()
            if not snapshot_id.lstrip("-").isdigit():
                raise ValueError("Pinned V2 dimension snapshot is invalid")
            version_id = realtime_v2_dimension_version_id(
                dataset_id,
                snapshot_id,
                str(relation.get("schemaFingerprint") or ""),
            )
            versions[dataset_id] = version_id
            expected_count = self._active_dimension_row_count(version_id)
            physical_count = self._dimension_row_count(client, dataset_id, version_id)
            if expected_count is not None and physical_count == expected_count:
                continue
            self._stage_dimension_version(
                version_id=version_id,
                relation=relation,
                snapshot_id=snapshot_id,
                created_by=job.created_by,
            )
            try:
                evidence = self._publish_dimension_snapshot(
                    client,
                    job,
                    relation,
                    binding,
                    version_id=version_id,
                )
                with self.session_factory() as db:
                    DimensionRepository(db).activate(
                        dimension_version_id=version_id,
                        scope_id="deployment",
                        dataset_id=dataset_id,
                        row_count=evidence.row_count,
                        checksum=evidence.checksum,
                    )
                    db.commit()
            except Exception:
                with self.session_factory() as db:
                    db.execute(
                        text("""
                            UPDATE realtime_dimension_versions
                            SET status = 'failed'
                            WHERE id = :version_id AND status <> 'active'
                        """),
                        {"version_id": version_id},
                    )
                    db.commit()
                raise
        if not versions:
            raise ValueError("ClickHouse Realtime V2 requires at least one dimension")
        return versions

    def _active_dimension_row_count(self, version_id: str) -> int | None:
        with self.session_factory() as db:
            row = db.execute(
                text("""
                    SELECT row_count FROM realtime_dimension_versions
                    WHERE id = :version_id AND status = 'active'
                """),
                {"version_id": version_id},
            ).first()
        return int(row[0]) if row is not None and row[0] is not None else None

    def _dimension_row_count(
        self,
        client: ClickHouseClient,
        dataset_id: str,
        version_id: str,
    ) -> int:
        target = qualified_clickhouse_table(
            self.settings.clickhouse_v2_database,
            "dimension_current_v2_latest",
        )
        result = client.query(
            f"SELECT count() AS row_count FROM {target} "
            "WHERE scope_id = 'deployment' "
            f"AND dimension_dataset_id = {quote_clickhouse_string(dataset_id)} "
            f"AND dimension_version_id = {quote_clickhouse_string(version_id)}"
        )
        return int(result.rows[0][0]) if result.rows else 0

    def _stage_dimension_version(
        self,
        *,
        version_id: str,
        relation: dict[str, Any],
        snapshot_id: str,
        created_by: str,
    ) -> None:
        dataset_id = str(relation.get("datasetId") or "")
        with self.session_factory() as db:
            existing = db.execute(
                text("SELECT status FROM realtime_dimension_versions WHERE id = :id FOR UPDATE"),
                {"id": version_id},
            ).first()
            if existing is None:
                next_version = int(db.execute(
                    text("""
                        SELECT COALESCE(MAX(version), 0) + 1
                        FROM realtime_dimension_versions
                        WHERE scope_id = 'deployment'
                          AND dimension_dataset_id = :dataset_id
                    """),
                    {"dataset_id": dataset_id},
                ).scalar_one())
                db.execute(text("""
                    INSERT INTO realtime_dimension_versions (
                        id, scope_id, dimension_dataset_id, version, semantics,
                        schema_fingerprint, source_snapshot_id, physical_database,
                        physical_table, status, created_by
                    ) VALUES (
                        :id, 'deployment', :dataset_id, :version, 'current',
                        :schema_fingerprint, :snapshot_id, :database,
                        'dimension_current_v2', 'publishing', :created_by
                    )
                    ON CONFLICT (id) DO UPDATE SET
                        schema_fingerprint = EXCLUDED.schema_fingerprint,
                        source_snapshot_id = EXCLUDED.source_snapshot_id,
                        physical_database = EXCLUDED.physical_database,
                        physical_table = EXCLUDED.physical_table,
                        status = 'publishing'
                """), {
                    "id": version_id,
                    "dataset_id": dataset_id,
                    "version": next_version,
                    "schema_fingerprint": realtime_v2_schema_fingerprint(
                        str(relation.get("schemaFingerprint") or "")
                    ),
                    "snapshot_id": snapshot_id,
                    "database": self.settings.clickhouse_v2_database,
                    "created_by": created_by,
                })
            else:
                db.execute(text("""
                    UPDATE realtime_dimension_versions
                    SET status = 'publishing', physical_database = :database,
                        physical_table = 'dimension_current_v2'
                    WHERE id = :id
                """), {
                    "id": version_id,
                    "database": self.settings.clickhouse_v2_database,
                })
            db.commit()

    def _control_plane_ready(
        self,
        job: ContinuousSqlJobModel,
        run: ContinuousSqlRunModel,
    ) -> bool:
        _pipeline_id, version_id, _deployment_id = realtime_v2_pipeline_ids(job, run)
        with self.session_factory() as db:
            return db.execute(
                text("SELECT 1 FROM realtime_pipeline_versions WHERE id = :version_id"),
                {"version_id": version_id},
            ).first() is not None

    def _publish_dimension_snapshot(
        self,
        client: ClickHouseClient,
        job: ContinuousSqlJobModel,
        relation: dict[str, Any],
        binding: dict[str, Any],
        *,
        version_id: str,
    ) -> DimensionPublishEvidence:
        mapping = relation.get("queryEngineTable")
        if not isinstance(mapping, dict):
            raise ValueError("V2 dimension has no Iceberg mapping")
        schema = relation_schema(relation)
        columns = [item[0] for item in schema]
        if not columns:
            raise ValueError("V2 dimension schema is empty")
        snapshot_id = int(str(binding.get("snapshotId")))
        source = ".".join(
            quote_trino_identifier(mapping.get(key))
            for key in ("catalog", "schema", "table")
        )
        projection = ", ".join(quote_trino_identifier(item) for item in columns)
        count = execute_trino_rows(
            self.trino_client,
            f"SELECT count(*) FROM {source} FOR VERSION AS OF {snapshot_id}",
            timeout_seconds=self.settings.trino_query_timeout_seconds,
        )
        if not count.rows or not count.rows[0]:
            raise ValueError("V2 dimension snapshot count is unavailable")
        total_rows = int(count.rows[0][0])
        if total_rows > int(self.settings.continuous_sql_static_cache_max_rows):
            raise ValueError("V2 dimension exceeds CONTINUOUS_SQL_STATIC_CACHE_MAX_ROWS")
        join_columns = continuous_sql_static_join_columns(
            job,
            str(relation.get("datasetId") or ""),
        )
        indexes = {name: index for index, name in enumerate(columns)}
        if any(item not in indexes for item in join_columns):
            raise ValueError("V2 dimension JOIN key is missing from the snapshot")

        dataset_id = str(relation.get("datasetId") or "")
        order_by = ", ".join(quote_trino_identifier(item) for item in join_columns)
        page = self.trino_client.submit(
            f"SELECT {projection} FROM {source} FOR VERSION AS OF {snapshot_id} "
            f"ORDER BY {order_by}",
            timeout_seconds=self.settings.trino_query_timeout_seconds,
        )
        page_count = 0
        inserted_rows = 0
        previous_key: str | None = None
        checksum = hashlib.sha256()
        batch: list[tuple[object, ...]] = []
        insert_columns = (
            "scope_id",
            "dimension_dataset_id",
            "dimension_version_id",
            "dimension_key",
            "payload",
            "row_version",
        )

        def flush_batch() -> None:
            nonlocal inserted_rows
            if not batch:
                return
            inserted_rows += client.insert_json_rows(
                self.settings.clickhouse_v2_database,
                "dimension_current_v2",
                insert_columns,
                batch,
            )
            batch.clear()

        while True:
            if page.error is not None:
                raise RuntimeError(f"{page.error.code}: {page.error.message}")
            for values in page.rows:
                payload = {
                    name: realtime_json_value(values[index] if index < len(values) else None)
                    for index, name in enumerate(columns)
                }
                keys = [payload[item] for item in join_columns]
                if any(item is None or str(item).strip() == "" for item in keys):
                    raise ValueError("V2 dimension JOIN keys cannot be null or empty")
                row = DimensionRow(
                    key=json.dumps(keys, ensure_ascii=False, separators=(",", ":")),
                    payload=payload,
                )
                if row.key == previous_key:
                    raise ValueError("V2 dimension JOIN keys must be unique")
                previous_key = row.key
                checksum.update(json.dumps({
                    "key": row.key,
                    "payload": row.payload,
                    "validFrom": None,
                    "validTo": None,
                    "rowVersion": row.row_version,
                }, sort_keys=True, separators=(",", ":")).encode("utf-8"))
                checksum.update(b"\n")
                batch.append((
                    "deployment",
                    dataset_id,
                    version_id,
                    row.key,
                    row.canonical_payload(),
                    row.row_version,
                ))
                if len(batch) >= _DIMENSION_INSERT_BATCH_ROWS:
                    flush_batch()
            if not page.next_uri:
                break
            page_count += 1
            if page_count >= int(self.settings.trino_max_result_pages):
                raise RuntimeError("V2 dimension snapshot exceeded the Trino page limit")
            page = self.trino_client.fetch(
                page.next_uri,
                timeout_seconds=self.settings.trino_query_timeout_seconds,
            )
        flush_batch()
        if inserted_rows != total_rows:
            raise RuntimeError(
                f"V2 dimension row count mismatch: expected={total_rows} actual={inserted_rows}"
            )
        return DimensionPublishEvidence(
            row_count=inserted_rows,
            checksum=checksum.hexdigest(),
            physical_table="dimension_current_v2",
        )

    def _initialize_control_plane(
        self,
        job: ContinuousSqlJobModel,
        run: ContinuousSqlRunModel,
        plan: RealtimeSqlPlan,
    ) -> None:
        pipeline_id, version_id, deployment_id = realtime_v2_pipeline_ids(job, run)
        now = datetime.now(UTC).isoformat()
        reference_ids = [item.dataset_id for item in plan.relations if item.role == "dimension"]
        source_id = next(item.dataset_id for item in plan.relations if item.role == "fact")
        with self.session_factory() as db:
            db.execute(text("""
                INSERT INTO realtime_pipelines (
                    id, scope_id, logical_dataset_id, name, execution_mode,
                    desired_state, owner_user_id
                ) VALUES (
                    :id, 'deployment', :dataset_id, :name, 'realtime_incremental',
                    'running', :owner
                )
                ON CONFLICT (id) DO UPDATE SET
                    name = EXCLUDED.name, desired_state = 'running',
                    updated_at = CURRENT_TIMESTAMP
            """), {
                "id": pipeline_id,
                "dataset_id": job.output_dataset_id,
                "name": job.name,
                "owner": job.owner,
            })
            db.execute(text("""
                UPDATE realtime_pipeline_versions
                SET status = 'retired'
                WHERE pipeline_id = :pipeline_id AND status = 'active' AND id <> :id
            """), {"pipeline_id": pipeline_id, "id": version_id})
            db.execute(text("""
                INSERT INTO realtime_pipeline_versions (
                    id, pipeline_id, version, normalized_sql, sql_fingerprint,
                    compiled_clickhouse_sql, source_dataset_id,
                    reference_dataset_ids, join_semantics, correction_policy,
                    schema_fingerprint, status, created_by, activated_at
                ) VALUES (
                    :id, :pipeline_id, :version, :normalized_sql, :sql_fingerprint,
                    :compiled_sql, :source_dataset_id,
                    CAST(:reference_ids AS JSONB), CAST(:join_semantics AS JSONB),
                    'bounded_repair', :schema_fingerprint, 'active', :created_by,
                    CURRENT_TIMESTAMP
                )
                ON CONFLICT (id) DO UPDATE SET
                    compiled_clickhouse_sql = EXCLUDED.compiled_clickhouse_sql,
                    reference_dataset_ids = EXCLUDED.reference_dataset_ids,
                    join_semantics = EXCLUDED.join_semantics,
                    status = 'active', activated_at = CURRENT_TIMESTAMP
            """), {
                "id": version_id,
                "pipeline_id": pipeline_id,
                "version": int(run.generation),
                "normalized_sql": plan.normalized_sql,
                "sql_fingerprint": plan.sql_fingerprint,
                "compiled_sql": plan.runtime_plan.runtime_sql,
                "source_dataset_id": source_id,
                "reference_ids": json.dumps(reference_ids, separators=(",", ":")),
                "join_semantics": json.dumps(list(plan.join_keys), separators=(",", ":")),
                "schema_fingerprint": job.plan_hash,
                "created_by": job.created_by,
            })
            db.execute(text("""
                UPDATE realtime_pipelines
                SET active_version_id = :version_id, desired_state = 'running',
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = :pipeline_id
            """), {"pipeline_id": pipeline_id, "version_id": version_id})
            db.execute(text("""
                INSERT INTO realtime_pipeline_deployments (
                    id, pipeline_version_id, environment, physical_database,
                    physical_table, deployed_sql_hash, status, deployed_at,
                    last_health_at
                ) VALUES (
                    :id, :version_id, 'production', :database,
                    :table, :sql_hash, 'available', CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP
                )
                ON CONFLICT (pipeline_version_id, environment) DO UPDATE SET
                    physical_database = EXCLUDED.physical_database,
                    physical_table = EXCLUDED.physical_table,
                    deployed_sql_hash = EXCLUDED.deployed_sql_hash,
                    status = 'available', deployed_at = CURRENT_TIMESTAMP,
                    last_health_at = CURRENT_TIMESTAMP, last_error_code = NULL,
                    last_error_detail_safe = NULL, updated_at = CURRENT_TIMESTAMP
            """), {
                "id": deployment_id,
                "version_id": version_id,
                "database": self.settings.clickhouse_v2_database,
                "table": _SERVING_VIEW,
                "sql_hash": hashlib.sha256(
                    plan.runtime_plan.runtime_sql.encode("utf-8")
                ).hexdigest(),
            })

            freshness = db.get(DatasetFreshnessModel, job.output_dataset_id)
            if freshness is None:
                freshness = DatasetFreshnessModel(
                    dataset_id=job.output_dataset_id,
                    latest_revision=0,
                    next_check_after_ms=max(1_000, int(job.trigger_interval_seconds) * 1_000),
                    binding_epoch=1,
                )
            elif (
                freshness.active_serving_engine != "clickhouse"
                or freshness.active_serving_version_id != version_id
            ):
                freshness.binding_epoch = int(freshness.binding_epoch or 0) + 1
            freshness.active_serving_engine = "clickhouse"
            freshness.active_serving_version_id = version_id
            freshness.updated_at = datetime.now(UTC)
            db.add(freshness)
            db.flush()
            self._upsert_catalog_dataset(
                db,
                job,
                plan,
                version_id=version_id,
                binding_epoch=int(freshness.binding_epoch),
                updated_at=now,
            )
            db.commit()

    def _upsert_catalog_dataset(
        self,
        db: Session,
        job: ContinuousSqlJobModel,
        plan: RealtimeSqlPlan,
        *,
        version_id: str,
        binding_epoch: int,
        updated_at: str,
    ) -> None:
        model = db.scalars(
            select(CatalogDatasetModel)
            .where(CatalogDatasetModel.id == job.output_dataset_id)
            .with_for_update()
        ).first()
        previous = dataset_model_to_payload(model) if model is not None else {}
        bindings = [
            dict(item)
            for item in previous.get("physicalBindings") or []
            if isinstance(item, dict) and item.get("role") != "serving"
        ]
        bindings.append({
            "role": "serving",
            "engine": "clickhouse",
            "status": "active",
            "bindingEpoch": binding_epoch,
            "versionId": version_id,
            "pipelineVersionId": version_id,
            "database": self.settings.clickhouse_v2_database,
            "table": _SERVING_VIEW,
        })
        relation_ids = [item.dataset_id for item in plan.relations]
        payload = {
            **previous,
            "clickhouseTable": {
                "database": self.settings.clickhouse_v2_database,
                "table": _SERVING_VIEW,
            },
            "createdBy": previous.get("createdBy") or job.created_by,
            "description": previous.get("description")
            or f"ClickHouse Realtime V2 output for {job.name}",
            "downstream": previous.get("downstream") or ["Dashboard"],
            "freshness": "realtime",
            "id": job.output_dataset_id,
            "indexColumns": ["kafka_partition", "kafka_offset"],
            "lastUpdated": updated_at,
            "layer": job.output_layer,
            "name": job.output_dataset_name,
            "nextRefresh": f"Every {job.trigger_interval_seconds} seconds",
            "owner": job.owner,
            "permissionGrants": previous.get("permissionGrants")
            or permission_grants_from_roles(job.owner, default_actions=["view", "query"]),
            "permissions": previous.get("permissions")
            or resource_permissions(can_query=True),
            "physicalBindings": bindings,
            "quality": "Realtime V2 serving binding ready",
            "queryEngineStatus": "unavailable",
            "rag": bool(previous.get("rag")),
            "relationMode": "static",
            "rows": previous.get("rows") or "0",
            "sampleRows": previous.get("sampleRows") or [],
            "schema": [list(item) for item in plan.output_schema],
            "size": previous.get("size") or "ClickHouse managed",
            "source": job.name,
            "status": "available",
            "storageFormat": "clickhouse",
            "storageLocation": (
                f"clickhouse://{self.settings.clickhouse_v2_database}/{_SERVING_VIEW}"
            ),
            "tags": previous.get("tags") or ["continuous-sql", "clickhouse", "realtime-v2"],
            "upstream": relation_ids,
        }
        values = dataset_payload_to_model_values(payload)
        if model is None:
            model = CatalogDatasetModel(id=job.output_dataset_id, **values)
        else:
            for key, value in values.items():
                setattr(model, key, value)
        db.add(model)

    def _raw_progress(
        self,
        client: ClickHouseClient,
        topic: str,
    ) -> list[dict[str, Any]]:
        target = qualified_clickhouse_table(
            self.settings.clickhouse_v2_database,
            _RAW_VIEW,
        )
        result = client.query(
            "SELECT kafka_partition, min(kafka_offset), max(kafka_offset), "
            "count(), max(ingested_at) "
            f"FROM {target} WHERE scope_id = 'deployment' "
            f"AND kafka_topic = {quote_clickhouse_string(topic)} "
            "GROUP BY kafka_partition ORDER BY kafka_partition"
        )
        return [
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

    def _materialize_once(
        self,
        client: ClickHouseClient,
        job: ContinuousSqlJobModel,
        run: ContinuousSqlRunModel,
    ):
        topic = realtime_v2_topic(job)
        progress = self._raw_progress(client, topic)
        if not progress:
            return None
        pipeline_id, version_id, _deployment_id = realtime_v2_pipeline_ids(job, run)
        del pipeline_id
        lease = self._acquire_partition_lease(version_id, topic, progress)
        if lease is None:
            return None
        lease_generation, checkpoint_state = lease
        positions_by_partition: dict[int, tuple[SourcePosition, ...]] = {}
        target = qualified_clickhouse_table(
            self.settings.clickhouse_v2_database,
            _RAW_VIEW,
        )
        max_positions = int(self.settings.clickhouse_realtime_v2_batch_max_positions)
        for partition, state in checkpoint_state.items():
            offsets = client.query(
                "SELECT kafka_offset "
                f"FROM {target} WHERE scope_id = 'deployment' "
                f"AND kafka_topic = {quote_clickhouse_string(topic)} "
                f"AND kafka_partition = {partition} "
                f"AND kafka_offset > {int(state['applied'])} "
                f"ORDER BY kafka_offset LIMIT {max_positions}"
            )
            items = tuple(
                SourcePosition(topic, partition, int(row[0]))
                for row in offsets.rows
                if row
            )
            if items:
                positions_by_partition[partition] = items
        if not positions_by_partition:
            return None

        dimension_versions = realtime_v2_dimension_versions(job, run)
        plan = build_realtime_v2_plan(
            job,
            run,
            dimension_version_ids=dimension_versions,
            database=self.settings.clickhouse_v2_database,
        )
        boundaries = [
            PartitionBoundary(
                topic,
                partition,
                int(checkpoint_state[partition]["applied"]),
                int(items[-1].offset),
            )
            for partition, items in positions_by_partition.items()
        ]
        boundary = SourceBoundary.build(boundaries)
        with self.session_factory() as db:
            self._assert_partition_lease(
                db,
                version_id,
                topic,
                positions_by_partition,
                lease_generation,
            )
            receipts = ReceiptRepository(db)
            for partition, positions in positions_by_partition.items():
                audit = audit_receipt_range(expected=positions, raw=positions)
                advanced = receipts.save_audit(
                    pipeline_version_id=version_id,
                    audit=audit,
                    expected_previous_contiguous=int(
                        checkpoint_state[partition]["contiguous"]
                    ),
                )
                if not advanced:
                    raise RuntimeError("V2 receipt checkpoint lost its lease")
            pipeline_generation = int(db.execute(
                text("""
                    SELECT pipeline_generation
                    FROM realtime_pipeline_versions
                    WHERE id = :version_id AND status = 'active'
                """),
                {"version_id": version_id},
            ).scalar_one())
            freshness = db.get(DatasetFreshnessModel, job.output_dataset_id)
            if freshness is None:
                raise RuntimeError("V2 serving binding is not initialized")
            compiled = ClickHouseRealtimeCompiler().compile(
                plan,
                boundary=boundary,
                serving_database=self.settings.clickhouse_v2_database,
                serving_table=_SERVING_TABLE,
                serving_dataset_id=job.output_dataset_id,
                pipeline_version_id=version_id,
                pipeline_generation=pipeline_generation,
            )
            evidence = RealtimeMaterializer(
                client,
                MaterializationRepository(db),
            ).run(
                compiled,
                pipeline_version_id=version_id,
                boundary=boundary,
                dimension_version_ids=dimension_versions,
                lease_generation=lease_generation,
                serving_database=self.settings.clickhouse_v2_database,
                serving_current_view=_SERVING_VIEW,
            )
            publication = RealtimePublicationRepository(db).publish(
                RealtimePublication(
                    dataset_id=job.output_dataset_id,
                    pipeline_version_id=version_id,
                    serving_version_id=version_id,
                    materialization_id=evidence.materialization_id,
                    source_fingerprint=evidence.source_fingerprint,
                    boundary=boundary,
                    dimension_version_ids=dimension_versions,
                    lease_generation=lease_generation,
                    binding_epoch=int(freshness.binding_epoch),
                    physical_database=self.settings.clickhouse_v2_database,
                    physical_table=_SERVING_VIEW,
                    row_count=evidence.target_row_count,
                    checksum=evidence.target_checksum,
                    mutation_type="append",
                    correlation_id=f"continuous-sql:{job.id}:{evidence.materialization_id}",
                )
            )
            total_rows = self._output_row_count(client, job, run)
            catalog = db.get(CatalogDatasetModel, job.output_dataset_id)
            if catalog is not None:
                payload = dataset_model_to_payload(catalog)
                payload["rows"] = f"{total_rows:,}"
                payload["lastUpdated"] = datetime.now(UTC).isoformat()
                payload["quality"] = "Realtime V2 offset publication verified"
                catalog.payload = payload
                catalog.rows = payload["rows"]
                catalog.last_updated = payload["lastUpdated"]
                catalog.quality = payload["quality"]
                db.add(catalog)
            db.commit()
        return publication

    def _acquire_partition_lease(
        self,
        version_id: str,
        topic: str,
        progress: list[dict[str, Any]],
    ) -> tuple[int, dict[int, dict[str, int]]] | None:
        partitions = [int(item["partition"]) for item in progress]
        observed = {int(item["partition"]): int(item["maxOffset"]) for item in progress}
        now = datetime.now(UTC)
        with self.session_factory() as db:
            for partition in partitions:
                db.execute(text("""
                    INSERT INTO realtime_partition_checkpoints (
                        pipeline_version_id, topic, partition, last_observed_offset
                    ) VALUES (:version_id, :topic, :partition, :observed)
                    ON CONFLICT (pipeline_version_id, topic, partition) DO UPDATE SET
                        last_observed_offset = GREATEST(
                            realtime_partition_checkpoints.last_observed_offset,
                            EXCLUDED.last_observed_offset
                        ), updated_at = CURRENT_TIMESTAMP
                """), {
                    "version_id": version_id,
                    "topic": topic,
                    "partition": partition,
                    "observed": observed[partition],
                })
            rows = db.execute(text("""
                SELECT partition, last_applied_offset,
                       last_contiguously_received_offset, lease_owner,
                       lease_generation, lease_expires_at
                FROM realtime_partition_checkpoints
                WHERE pipeline_version_id = :version_id AND topic = :topic
                ORDER BY partition
                FOR UPDATE
            """), {"version_id": version_id, "topic": topic}).mappings().all()
            candidates = [
                row for row in rows
                if int(row["partition"]) in observed
                and observed[int(row["partition"])] > int(row["last_applied_offset"])
            ]
            if not candidates:
                db.commit()
                return None
            for row in candidates:
                expires = row["lease_expires_at"]
                if expires is not None and expires.tzinfo is None:
                    expires = expires.replace(tzinfo=UTC)
                if row["lease_owner"] not in {None, _OWNER_ID} and expires is not None and expires > now:
                    db.rollback()
                    return None
            generation = max(int(row["lease_generation"] or 0) for row in candidates) + 1
            expires_at = now + timedelta(
                seconds=max(5, int(self.settings.continuous_control_lease_seconds))
            )
            state: dict[int, dict[str, int]] = {}
            for row in candidates:
                partition = int(row["partition"])
                db.execute(text("""
                    UPDATE realtime_partition_checkpoints
                    SET lease_owner = :owner, lease_generation = :generation,
                        lease_expires_at = :expires_at, updated_at = CURRENT_TIMESTAMP
                    WHERE pipeline_version_id = :version_id AND topic = :topic
                      AND partition = :partition
                """), {
                    "owner": _OWNER_ID,
                    "generation": generation,
                    "expires_at": expires_at,
                    "version_id": version_id,
                    "topic": topic,
                    "partition": partition,
                })
                state[partition] = {
                    "applied": int(row["last_applied_offset"]),
                    "contiguous": int(row["last_contiguously_received_offset"]),
                }
            db.commit()
        return generation, state

    @staticmethod
    def _assert_partition_lease(
        db: Session,
        version_id: str,
        topic: str,
        positions_by_partition: dict[int, tuple[SourcePosition, ...]],
        generation: int,
    ) -> None:
        for partition in positions_by_partition:
            row = db.execute(text("""
                SELECT lease_owner, lease_generation, lease_expires_at
                FROM realtime_partition_checkpoints
                WHERE pipeline_version_id = :version_id AND topic = :topic
                  AND partition = :partition
                FOR UPDATE
            """), {
                "version_id": version_id,
                "topic": topic,
                "partition": partition,
            }).first()
            if row is None or str(row[0] or "") != _OWNER_ID or int(row[1]) != generation:
                raise RuntimeError("V2 partition lease is stale")
            expires = row[2]
            if expires is not None and expires.tzinfo is None:
                expires = expires.replace(tzinfo=UTC)
            if expires is not None and expires <= datetime.now(UTC):
                raise RuntimeError("V2 partition lease expired")

    def _output_row_count(
        self,
        client: ClickHouseClient,
        job: ContinuousSqlJobModel,
        run: ContinuousSqlRunModel,
    ) -> int:
        _pipeline_id, version_id, _deployment_id = realtime_v2_pipeline_ids(job, run)
        target = qualified_clickhouse_table(
            self.settings.clickhouse_v2_database,
            _SERVING_VIEW,
        )
        result = client.query(
            f"SELECT count() FROM {target} WHERE scope_id = 'deployment' "
            f"AND serving_dataset_id = {quote_clickhouse_string(job.output_dataset_id)} "
            f"AND pipeline_version_id = {quote_clickhouse_string(version_id)}"
        )
        return int(result.rows[0][0]) if result.rows else 0

    def _set_pipeline_state(
        self,
        job: ContinuousSqlJobModel,
        run: ContinuousSqlRunModel | None,
        *,
        desired_state: str,
        retire: bool,
    ) -> None:
        if run is None:
            return
        pipeline_id, version_id, _deployment_id = realtime_v2_pipeline_ids(job, run)
        with self.session_factory() as db:
            db.execute(text("""
                UPDATE realtime_pipelines
                SET desired_state = :desired_state, updated_at = CURRENT_TIMESTAMP
                WHERE id = :pipeline_id
            """), {
                "desired_state": desired_state,
                "pipeline_id": pipeline_id,
            })
            if retire:
                db.execute(text("""
                    UPDATE realtime_pipeline_versions
                    SET status = 'retired'
                    WHERE id = :version_id AND status = 'active'
                """), {"version_id": version_id})
            db.commit()

    @staticmethod
    def _worker_result(
        job: ContinuousSqlJobModel,
        state: str,
        *,
        progress: list[dict[str, Any]] | None = None,
        output_row_count: int = 0,
        publication_revision: int | None = None,
    ) -> dict[str, Any]:
        return {
            "containerState": state,
            "workerAttemptId": f"clickhouse-v2:{job.id}",
            # The legacy publication service intentionally sees no V1 offsets;
            # V2 publishes Catalog + revision + SSE atomically itself.
            "clickhouseOffsets": [],
            "realtimeV2Offsets": progress or [],
            "servingMode": "clickhouse",
            "servingGeneration": "v2",
            "jobId": job.id,
            "clickhouseOutputRowCount": max(0, int(output_row_count)),
            "consumerMessagesRead": sum(
                max(0, int(item.get("rowCount") or 0))
                for item in progress or []
            ),
            "publicationRevision": publication_revision,
            "lastErrorCode": None,
            "lastErrorMessage": None,
        }


def realtime_v2_topic(job: ContinuousSqlJobModel) -> str:
    stream = next(
        (
            item for item in job.relation_bindings or []
            if isinstance(item, dict) and item.get("mode") == "streaming"
        ),
        None,
    )
    source = stream.get("streamingSource") if isinstance(stream, dict) else None
    topic = str(source.get("topic") or "").strip() if isinstance(source, dict) else ""
    if not topic:
        raise ValueError("ClickHouse Realtime V2 streaming topic is missing")
    return topic


def realtime_v2_connector_name(base: str, topic: str) -> str:
    digest = hashlib.sha256(topic.encode("utf-8")).hexdigest()[:16]
    prefix = str(base or "asklake-clickhouse-realtime-v2").strip()[:110].rstrip(".-_")
    return f"{prefix}-{digest}"


def realtime_v2_dlq_topic(topic: str) -> str:
    suffix = ".asklake-v2-dlq"
    if len(topic) + len(suffix) <= 249:
        return topic + suffix
    digest = hashlib.sha256(topic.encode("utf-8")).hexdigest()[:16]
    return f"{topic[:225].rstrip('.-_')}-{digest}.dlq"


def realtime_v2_pipeline_ids(
    job: ContinuousSqlJobModel,
    run: ContinuousSqlRunModel,
) -> tuple[str, str, str]:
    pipeline_hash = hashlib.sha256(job.id.encode("utf-8")).hexdigest()
    version_hash = hashlib.sha256(
        f"{job.id}|{run.generation}|{job.plan_hash}".encode("utf-8")
    ).hexdigest()
    pipeline_id = f"rtp_{pipeline_hash[:48]}"
    version_id = f"rtpv_{version_hash[:48]}"
    deployment_id = f"rtpd_{version_hash[:48]}"
    return pipeline_id, version_id, deployment_id


def realtime_v2_dimension_version_id(
    dataset_id: str,
    snapshot_id: str,
    schema_fingerprint: str,
) -> str:
    normalized_schema_fingerprint = realtime_v2_schema_fingerprint(schema_fingerprint)
    digest = hashlib.sha256(
        f"{dataset_id}|{snapshot_id}|{normalized_schema_fingerprint}".encode("utf-8")
    ).hexdigest()
    return f"rtdv_{digest[:48]}"


def realtime_v2_schema_fingerprint(value: str) -> str:
    normalized = str(value or "").strip().casefold()
    if len(normalized) == 64 and all(character in "0123456789abcdef" for character in normalized):
        return normalized
    return hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()


def realtime_v2_dimension_versions(
    job: ContinuousSqlJobModel,
    run: ContinuousSqlRunModel,
) -> dict[str, str]:
    bindings = {
        str(item.get("datasetId") or ""): item
        for item in run.static_bindings or []
        if isinstance(item, dict)
    }
    versions: dict[str, str] = {}
    for relation in job.relation_bindings or []:
        if not isinstance(relation, dict) or relation.get("mode") != "static":
            continue
        dataset_id = str(relation.get("datasetId") or "")
        binding = bindings.get(dataset_id)
        if binding is None:
            raise ValueError("Pinned V2 dimension binding is missing")
        versions[dataset_id] = realtime_v2_dimension_version_id(
            dataset_id,
            str(binding.get("snapshotId") or ""),
            str(relation.get("schemaFingerprint") or ""),
        )
    return versions


def build_realtime_v2_plan(
    job: ContinuousSqlJobModel,
    run: ContinuousSqlRunModel,
    *,
    dimension_version_ids: dict[str, str],
    database: str,
) -> RealtimeSqlPlan:
    relations: list[RealtimeRelation] = []
    for relation in job.relation_bindings or []:
        if not isinstance(relation, dict):
            continue
        dataset_id = str(relation.get("datasetId") or "")
        schema = tuple(relation_schema(relation))
        if relation.get("mode") == "streaming":
            source = relation.get("streamingSource")
            topic = str(source.get("topic") or "") if isinstance(source, dict) else ""
            relations.append(RealtimeRelation(
                dataset_id=dataset_id,
                logical_name=str(relation.get("datasetName") or dataset_id),
                role="fact",
                physical_database=database,
                physical_table=_RAW_VIEW,
                schema=schema,
                kafka_topic=topic,
            ))
            continue
        join_columns = tuple(continuous_sql_static_join_columns(job, dataset_id))
        unique_sets = tuple(
            tuple(str(column) for column in item)
            for item in relation.get("uniqueKeySets") or []
            if isinstance(item, (list, tuple))
        ) or (join_columns,)
        relations.append(RealtimeRelation(
            dataset_id=dataset_id,
            logical_name=str(relation.get("datasetName") or dataset_id),
            role="dimension",
            physical_database=database,
            physical_table="dimension_current_v2_latest",
            schema=schema,
            unique_key_sets=unique_sets,
            estimated_row_count=(
                int(relation["estimatedRowCount"])
                if relation.get("estimatedRowCount") is not None
                else None
            ),
            dimension_version_id=dimension_version_ids.get(dataset_id),
            dimension_semantics="current",
        ))
    facts = [item for item in relations if item.role == "fact"]
    dimensions = [item for item in relations if item.role == "dimension"]
    if len(facts) != 1 or not 1 <= len(dimensions) <= 3:
        raise ValueError("ClickHouse Realtime V2 requires one fact and one to three dimensions")
    if relations[0].role != "fact":
        raise ValueError("ClickHouse Realtime V2 fact relation must be left-most")
    output_schema = tuple(
        (str(item[0]), str(item[1]))
        for item in job.compiled_plan.get("outputSchema") or []
        if isinstance(item, (list, tuple)) and len(item) >= 2
    )
    runtime_sql = str(job.compiled_plan.get("runtimeSql") or "").strip()
    if not output_schema or not runtime_sql:
        raise ValueError("ClickHouse Realtime V2 compiled plan is incomplete")
    compiled = CompiledContinuousSqlPlan(
        normalized_sql=job.normalized_sql,
        runtime_sql=runtime_sql,
        plan_hash=job.plan_hash,
        plan=dict(job.compiled_plan or {}),
    )
    joins = tuple(
        dict(item)
        for item in job.compiled_plan.get("joins") or []
        if isinstance(item, dict)
    )
    return RealtimeSqlPlan(
        normalized_sql=job.normalized_sql,
        sql_fingerprint=hashlib.sha256(job.normalized_sql.encode("utf-8")).hexdigest(),
        execution_mode="realtime_incremental",
        referenced_dataset_ids=tuple(item.dataset_id for item in relations),
        join_keys=joins,
        missing_policies=tuple({
            "dimensionDatasetId": str(item.get("rightDatasetId") or ""),
            "joinType": str(item.get("type") or ""),
            "missingPolicy": default_missing_policy(str(item.get("type") or "")),
        } for item in joins),
        output_schema=output_schema,
        business_key_columns=(),
        event_time_column=None,
        warnings=(),
        estimated_cost={
            "sourceRowsPerSecond": 0,
            "dimensionRows": sum(max(0, item.estimated_row_count or 0) for item in dimensions),
            "estimatedP95Ms": min(5_000, 50 + len(dimensions) * 150),
        },
        runtime_plan=compiled,
        relations=tuple(relations),
    )


def realtime_json_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, datetime):
        return value.replace(tzinfo=value.tzinfo or UTC).astimezone(UTC).isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="strict")
    if isinstance(value, dict):
        return {str(key): realtime_json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [realtime_json_value(item) for item in value]
    return str(value)
