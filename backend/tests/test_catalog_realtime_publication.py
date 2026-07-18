from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
import tempfile
import unittest

from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.models.catalog import CatalogDatasetModel
from app.models.dashboard_live import DatasetFreshnessModel, DatasetRevisionCommitModel
from app.models.realtime import RealtimeEventModel
from app.realtime.domain.publication import RealtimePublication
from app.realtime.domain.source_boundary import PartitionBoundary, SourceBoundary
from app.realtime.repositories.publication_repository import RealtimePublicationRepository
from app.repositories.catalog_repository import dataset_model_to_payload
from app.repositories.realtime_event_repository import RealtimeEventRepository
from app.schemas.catalog import CatalogDatasetResponse
from tests.test_clickhouse_realtime_alembic import _run_alembic


@compiles(JSONB, "sqlite")
def compile_jsonb_for_sqlite(_type, _compiler, **_kwargs):
    return "JSON"


class CatalogRealtimePublicationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_directory = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temp_directory.name) / "publication.sqlite"
        self.engine = create_engine(f"sqlite+pysqlite:///{self.database_path}")
        _run_alembic(self.database_path, "upgrade", "head")
        CatalogDatasetModel.__table__.create(self.engine, checkfirst=True)
        self.boundary = SourceBoundary.build((PartitionBoundary("events.v2", 0, -1, 2),))
        self.fingerprint = self.boundary.fingerprint("pipeline-v1")
        self.materialization_id = self.boundary.materialization_id("pipeline-v1")
        self._seed()

    def tearDown(self) -> None:
        self.engine.dispose()
        self.temp_directory.cleanup()

    def _seed(self) -> None:
        with Session(self.engine) as session, session.begin():
            session.add(CatalogDatasetModel(
                id="joined",
                name="joined",
                payload={
                    "id": "joined",
                    "name": "joined",
                    "physicalBindings": [{
                        "role": "archive", "engine": "trino", "status": "active",
                        "bindingEpoch": 3, "catalog": "iceberg", "schema": "gold",
                        "table": "joined", "snapshotId": "77",
                    }],
                },
            ))
            session.add(DatasetFreshnessModel(
                dataset_id="joined",
                latest_revision=4,
                binding_epoch=3,
                active_serving_engine="clickhouse",
                active_serving_version_id="serving-v1",
            ))
            session.execute(text("""
                INSERT INTO realtime_pipelines
                    (id, logical_dataset_id, name, execution_mode, owner_user_id)
                VALUES ('pipeline', 'joined', 'joined realtime', 'realtime_incremental', 'tester')
            """))
            session.execute(text("""
                INSERT INTO realtime_pipeline_versions
                    (id, pipeline_id, version, pipeline_generation, normalized_sql,
                     sql_fingerprint, source_dataset_id, schema_fingerprint, status, created_by)
                VALUES ('pipeline-v1', 'pipeline', 1, 1, 'SELECT 1', 'sql-fingerprint',
                        'events', 'schema-fingerprint', 'active', 'tester')
            """))
            session.execute(text("""
                INSERT INTO realtime_partition_checkpoints
                    (pipeline_version_id, topic, partition, last_observed_offset,
                     last_contiguously_received_offset, last_applied_offset, lease_generation)
                VALUES ('pipeline-v1', 'events.v2', 0, 2, 2, -1, 7)
            """))
            session.execute(text("""
                INSERT INTO realtime_materializations
                    (id, pipeline_version_id, source_boundary, source_fingerprint,
                     dimension_version_ids, clickhouse_query_id, lease_generation,
                     target_row_count, target_checksum, status, committed_at)
                VALUES (:id, 'pipeline-v1', :boundary, :fingerprint,
                        :dimensions, 'query-v1', 7, 2, 'checksum-v1',
                        'materialized', CURRENT_TIMESTAMP)
            """), {
                "id": self.materialization_id,
                "boundary": self.boundary.canonical_json(),
                "fingerprint": self.fingerprint,
                "dimensions": '{"users":"users-v1"}',
            })

    def publication(self, **changes) -> RealtimePublication:
        values = {
            "dataset_id": "joined",
            "pipeline_version_id": "pipeline-v1",
            "serving_version_id": "serving-v1",
            "materialization_id": self.materialization_id,
            "source_fingerprint": self.fingerprint,
            "boundary": self.boundary,
            "dimension_version_ids": {"users": "users-v1"},
            "lease_generation": 7,
            "binding_epoch": 3,
            "physical_database": "asklake_realtime_v2",
            "physical_table": "serving_current_v2",
            "row_count": 2,
            "checksum": "checksum-v1",
            "mutation_type": "append",
            "correlation_id": "correlation-v1",
        }
        values.update(changes)
        return RealtimePublication(**values)

    def test_migration_adds_publication_columns_and_keeps_single_head(self) -> None:
        inspector = inspect(self.engine)
        freshness = {item["name"] for item in inspector.get_columns("dataset_freshness")}
        revisions = {item["name"] for item in inspector.get_columns("dataset_revision_commits")}
        self.assertTrue({
            "binding_epoch", "active_serving_engine", "latest_source_boundary",
            "latest_checksum", "latest_mutation_type",
        }.issubset(freshness))
        self.assertTrue({
            "materialization_id", "source_boundary", "serving_engine",
            "serving_version_id", "dimension_version_ids", "mutation_type",
        }.issubset(revisions))
        heads = _run_alembic(self.database_path, "heads").stdout
        self.assertEqual(heads.count("(head)"), 1)
        self.assertIn("0014_realtime_archive_recovery (head)", heads)

    def test_publication_advances_all_evidence_atomically_and_is_idempotent(self) -> None:
        with Session(self.engine) as session, session.begin():
            first = RealtimePublicationRepository(session).publish(self.publication())
        with Session(self.engine) as session, session.begin():
            repeated = RealtimePublicationRepository(session).publish(self.publication())

        self.assertTrue(first.created)
        self.assertFalse(repeated.created)
        self.assertEqual((first.revision, first.event_cursor), (repeated.revision, repeated.event_cursor))
        self.assertEqual(first.revision, 5)

        with Session(self.engine) as session:
            freshness = session.get(DatasetFreshnessModel, "joined")
            commit = session.scalar(select(DatasetRevisionCommitModel))
            event = session.scalar(select(RealtimeEventModel))
            catalog = session.get(CatalogDatasetModel, "joined")
            checkpoint = session.execute(text(
                "SELECT last_applied_offset FROM realtime_partition_checkpoints"
            )).scalar_one()
            materialization = session.execute(text(
                "SELECT status, published_revision FROM realtime_materializations"
            )).one()

        self.assertEqual(freshness.latest_revision, 5)
        self.assertEqual(freshness.latest_checksum, "checksum-v1")
        self.assertEqual(commit.materialization_id, self.materialization_id)
        self.assertEqual(commit.binding_epoch, 3)
        self.assertEqual(event.schema_version, 2)
        self.assertEqual(event.payload["mutationType"], "append")
        self.assertEqual(checkpoint, 2)
        self.assertEqual(tuple(materialization), ("published", 5))
        bindings = dataset_model_to_payload(catalog)["physicalBindings"]
        self.assertEqual({item["role"] for item in bindings if item["status"] == "active"}, {"archive", "serving"})

    def test_stale_binding_fails_without_partial_publication(self) -> None:
        with Session(self.engine) as session:
            with self.assertRaisesRegex(ValueError, "binding"):
                with session.begin():
                    RealtimePublicationRepository(session).publish(
                        self.publication(binding_epoch=2)
                    )
        with Session(self.engine) as session:
            self.assertEqual(session.scalar(select(DatasetRevisionCommitModel)), None)
            self.assertEqual(session.execute(text(
                "SELECT status FROM realtime_materializations"
            )).scalar_one(), "materialized")
            self.assertEqual(session.execute(text(
                "SELECT last_applied_offset FROM realtime_partition_checkpoints"
            )).scalar_one(), -1)

    def test_catalog_schema_preserves_legacy_archive_as_dual_binding(self) -> None:
        payload = {
            "createdBy": None, "description": "", "downstream": [], "freshness": "latest",
            "id": "legacy", "layer": "GOLD", "lastUpdated": "", "name": "legacy",
            "nextRefresh": "-", "owner": "owner", "quality": "passed", "rag": False,
            "rows": "0", "sampleRows": [], "schema": [["id", "string"]], "size": "0",
            "source": "sql", "status": "available", "tags": [], "upstream": [],
            "queryEngineStatus": "available",
            "queryEngineTable": {
                "catalog": "iceberg", "schema": "gold", "table": "legacy",
                "format": "iceberg", "partitionColumns": [],
            },
            "clickhouseTable": {"database": "asklake_realtime_v2", "table": "serving_current_v2"},
        }
        normalized = dataset_model_to_payload(CatalogDatasetModel(id="legacy", payload=payload))
        response = CatalogDatasetResponse.model_validate(normalized)
        self.assertEqual({item.role for item in response.physical_bindings}, {"archive", "serving"})

    def test_event_repository_preserves_schema_v2_in_envelope(self) -> None:
        with Session(self.engine) as session:
            now = datetime.now(UTC)
            model = RealtimeEventModel(
                id=99,
                scope_id="deployment",
                event_type="dataset.revision.committed",
                schema_version=2,
                resource_type="dataset",
                resource_id="joined",
                aggregate_revision=5,
                correlation_id="correlation-v1",
                idempotency_key="manual-v2",
                invalidations=["dataset:joined"],
                payload={},
                occurred_at=now,
                expires_at=now,
            )
            envelope = RealtimeEventRepository.to_envelope(model)
        self.assertEqual(envelope.schema_version, 2)
        self.assertEqual(envelope.scope_id, "deployment")


if __name__ == "__main__":
    unittest.main()
