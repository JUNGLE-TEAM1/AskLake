from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta
import hashlib
import json
import os
import socket
from typing import Any
from uuid import uuid4

from fastapi import status
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings, settings
from app.core.database import SessionLocal
from app.core.errors import ApiError
from app.models.continuous_sql import ContinuousSqlJobModel, ContinuousSqlRunModel
from app.models.dashboard_live import DatasetFreshnessModel
from app.realtime.application.dimension_publish_worker import DimensionPublishEvidence
from app.realtime.application.ingest_service import RealtimeIngestService
from app.realtime.application.materializer import RealtimeMaterializer
from app.realtime.domain.dimension import DimensionRow
from app.realtime.domain.publication import RealtimePublication
from app.realtime.domain.source_position import SourcePosition
from app.realtime.infrastructure.kafka_connect_gateway import (
    KafkaConnectError,
    KafkaConnectGateway,
)
from app.realtime.repositories.dimension_repository import DimensionRepository
from app.realtime.repositories.materialization_repository import MaterializationRepository
from app.realtime.repositories.publication_repository import RealtimePublicationRepository
from app.realtime.sql.clickhouse_compiler import ClickHouseRealtimeCompiler
from app.realtime.sql.validator import RealtimeSqlPlan
from app.services.clickhouse_client import (
    ClickHouseClient,
    ClickHouseError,
    qualified_clickhouse_table,
    quote_clickhouse_string,
)
from app.services.realtime_feature_flags import validate_clickhouse_consumer_ownership
from app.services.trino_client import TrinoClient
from app.services.clickhouse_realtime_v2_support import (
    activate_realtime_v2_serving_binding,
    build_realtime_v2_materialization_context,
    build_realtime_v2_plan,
    pending_realtime_v2_positions,
    prepare_dimension_snapshot,
    realtime_json_value,
    realtime_v2_connector_name,
    realtime_v2_dimension_version_id,
    realtime_v2_dimension_versions,
    realtime_v2_dlq_topic,
    realtime_v2_pipeline_ids,
    realtime_v2_schema_fingerprint,
    realtime_v2_topic,
    realtime_v2_worker_result,
    save_realtime_v2_receipts,
    upsert_realtime_v2_pipeline,
    update_realtime_v2_catalog_rows,
)


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
                    return realtime_v2_worker_result(job, "missing")
                if not self._control_plane_ready(job, run):
                    self._provision(job, run)
                return self._status(job, run)
            if action == "pause":
                self._set_pipeline_state(job, run, desired_state="paused", retire=False)
                return realtime_v2_worker_result(job, "not_running")
            if action in {"stop", "terminate"}:
                self._set_pipeline_state(job, run, desired_state="stopped", retire=True)
                return realtime_v2_worker_result(job, "not_running")
            if action == "ack":
                return realtime_v2_worker_result(job, "running")
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
            dlq_topic=(
                self.settings.kafka_connect_dlq_topic
                or realtime_v2_dlq_topic(topic)
            ),
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
            return realtime_v2_worker_result(job, "starting")
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
            return realtime_v2_worker_result(job, "starting")
        if not probe.ready:
            return realtime_v2_worker_result(job, "starting")

        client = self.client_factory()
        try:
            publication = self._materialize_once(client, job, run)
            progress = self._raw_progress(client, realtime_v2_topic(job))
            output_row_count = self._output_row_count(client, job, run)
        finally:
            client.close()
        return realtime_v2_worker_result(
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
        columns, join_columns, dataset_id, total_rows, page = prepare_dimension_snapshot(
            self.trino_client,
            self.settings,
            job,
            relation,
            binding,
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
            upsert_realtime_v2_pipeline(db, job, pipeline_id=pipeline_id)
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

            activate_realtime_v2_serving_binding(
                db,
                job,
                plan,
                version_id=version_id,
                updated_at=now,
                database=self.settings.clickhouse_v2_database,
                serving_view=_SERVING_VIEW,
            )
            db.commit()

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
        _pipeline_id, version_id, _deployment_id = realtime_v2_pipeline_ids(job, run)
        lease = self._acquire_partition_lease(version_id, topic, progress)
        if lease is None:
            return None
        lease_generation, checkpoint_state = lease
        positions_by_partition = pending_realtime_v2_positions(
            client, database=self.settings.clickhouse_v2_database, raw_view=_RAW_VIEW, topic=topic,
            checkpoint_state=checkpoint_state,
            max_positions=int(self.settings.clickhouse_realtime_v2_batch_max_positions),
        )
        if not positions_by_partition:
            return None

        dimension_versions, plan, boundary = build_realtime_v2_materialization_context(
            job, run, database=self.settings.clickhouse_v2_database, topic=topic,
            positions_by_partition=positions_by_partition,
            checkpoint_state=checkpoint_state,
        )
        with self.session_factory() as db:
            self._assert_partition_lease(
                db,
                version_id,
                topic,
                positions_by_partition,
                lease_generation,
            )
            save_realtime_v2_receipts(
                db, version_id=version_id,
                positions_by_partition=positions_by_partition,
                checkpoint_state=checkpoint_state,
            )
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
            update_realtime_v2_catalog_rows(
                db, job, total_rows=total_rows,
                updated_at=datetime.now(UTC).isoformat(),
            )
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
