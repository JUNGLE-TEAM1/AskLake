from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from sqlalchemy import create_engine, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.models.catalog import CatalogDatasetModel
from app.models.dashboard_live import DatasetFreshnessModel, DatasetRevisionCommitModel
from app.models.realtime import (
    RealtimeEventModel,
    RealtimeRecoveryOperationModel,
    RealtimeRoutingAssignmentModel,
)
from app.realtime.domain.archive import (
    ArchiveParityReport,
    ParityEvidence,
    RebuildCompletionEvidence,
    RebuildPlan,
)
from app.realtime.domain.cutover import (
    BindingSwitchRequest,
    CutoverGateEvidence,
    PhysicalBindingTarget,
)
from app.realtime.domain.source_boundary import PartitionBoundary, SourceBoundary
from app.realtime.repositories.recovery_repository import RealtimeRecoveryRepository
from app.repositories.catalog_repository import dataset_model_to_payload
from tests.test_clickhouse_realtime_alembic import _run_alembic


@compiles(JSONB, "sqlite")
def compile_jsonb_for_sqlite(_type, _compiler, **_kwargs):
    return "JSON"


class ArchiveParityDomainTests(unittest.TestCase):
    def boundary(self, final_offset: int = 9) -> SourceBoundary:
        return SourceBoundary.build((
            PartitionBoundary("clicks.v2", 0, -1, final_offset),
            PartitionBoundary("clicks.v2", 1, -1, final_offset),
        ))

    def evidence(
        self,
        role: str,
        version: str,
        *,
        final_offset: int = 9,
        checksum: str = "canonical-checksum",
    ) -> ParityEvidence:
        return ParityEvidence(
            role=role,  # type: ignore[arg-type]
            dataset_id="joined",
            pipeline_version_id="pipeline-v1",
            binding_version_id=version,
            boundary=self.boundary(final_offset),
            dimension_version_ids={"products": "products-v3", "users": "users-v2"},
            row_count=20,
            checksum=checksum,
            distinct_source_position_count=20,
            schema_fingerprint="schema-v1",
            null_count=0,
            error_count=0,
            numeric_sums={"amount": "20.000", "quantity": 10},
            sample_hash="sample-v1",
        )

    def test_boundary_mismatch_fails_even_when_counts_and_checksum_match(self) -> None:
        report = ArchiveParityReport.compare(
            self.evidence("hot", "serving-v2", final_offset=9),
            self.evidence("archive", "archive-v1", final_offset=10),
        )
        self.assertFalse(report.matched)
        self.assertIn("sourceBoundary", report.mismatch_fields)

    def test_matched_report_and_rebuild_plan_are_deterministic(self) -> None:
        report = ArchiveParityReport.compare(
            self.evidence("hot", "serving-v2"),
            self.evidence("archive", "archive-v1"),
        )
        first = RebuildPlan.build(
            report,
            shadow_binding_version_id="serving-shadow-v3",
            physical_database="asklake_realtime_v2",
            physical_table="joined_shadow_v3",
        )
        second = RebuildPlan.build(
            report,
            shadow_binding_version_id="serving-shadow-v3",
            physical_database="asklake_realtime_v2",
            physical_table="joined_shadow_v3",
        )
        self.assertTrue(report.matched)
        self.assertEqual(first, second)
        self.assertEqual([item["nextOffset"] for item in first.tail_start_offsets], [10, 10])

    def test_cutover_rejects_incomplete_production_gate(self) -> None:
        gate = approved_gate(shadow_observation_hours=71)
        with self.assertRaisesRegex(ValueError, "shadow72Hours"):
            BindingSwitchRequest(
                idempotency_key="cutover-incomplete",
                action="cutover",
                dataset_id="joined",
                expected_binding_epoch=4,
                expected_binding_version_id="serving-v1",
                target=target("serving-v2", self.boundary()),
                parity_report_id="parity-1",
                requested_by="operator",
                reason="approved operational cutover",
                correlation_id="correlation-1",
                gate=gate,
            )


def approved_gate(**overrides) -> CutoverGateEvidence:
    values = {
        "deterministic_fixture_rows": 100_000,
        "lost_source_positions": 0,
        "logical_duplicate_count": 0,
        "shadow_observation_hours": 72,
        "shadow_parity_passed": True,
        "p95_slo_passed": True,
        "restart_chaos_passed": True,
        "security_passed": True,
        "rollback_drill_passed": True,
        "operations_dashboard_ready": True,
        "runbook_ready": True,
    }
    values.update(overrides)
    return CutoverGateEvidence(**values)


def target(version: str, boundary: SourceBoundary) -> PhysicalBindingTarget:
    return PhysicalBindingTarget(
        engine="clickhouse",
        version_id=version,
        pipeline_version_id="pipeline-v1",
        materialization_id=f"materialization-{version}",
        boundary=boundary,
        dimension_version_ids={"products": "products-v3", "users": "users-v2"},
        checksum="canonical-checksum",
        row_count=20,
        database="asklake_realtime_v2",
        table=f"joined_{version.replace('-', '_')}",
    )


class RealtimeRecoveryRepositoryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_directory = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temp_directory.name) / "recovery.sqlite"
        self.engine = create_engine(f"sqlite+pysqlite:///{self.database_path}")
        _run_alembic(self.database_path, "upgrade", "head")
        CatalogDatasetModel.__table__.create(self.engine, checkfirst=True)
        self.boundary = SourceBoundary.build((
            PartitionBoundary("clicks.v2", 0, -1, 9),
            PartitionBoundary("clicks.v2", 1, -1, 9),
        ))
        self._seed()

    def tearDown(self) -> None:
        self.engine.dispose()
        self.temp_directory.cleanup()

    def _seed(self) -> None:
        with self.engine.begin() as connection:
            connection.execute(text("""
                INSERT INTO realtime_pipelines
                    (id, logical_dataset_id, name, execution_mode, owner_user_id)
                VALUES
                    ('pipeline', 'joined', 'joined realtime',
                     'realtime_incremental', 'operator')
            """))
            connection.execute(text("""
                INSERT INTO realtime_pipeline_versions
                    (id, pipeline_id, version, pipeline_generation, normalized_sql,
                     sql_fingerprint, source_dataset_id, schema_fingerprint,
                     status, created_by)
                VALUES
                    ('pipeline-v1', 'pipeline', 1, 1, 'SELECT 1',
                     'sql-v1', 'clicks', 'schema-v1', 'active', 'operator')
            """))
        with Session(self.engine) as session, session.begin():
            session.add(CatalogDatasetModel(
                id="joined",
                name="joined",
                payload={
                    "id": "joined",
                    "name": "joined",
                    "physicalBindings": [
                        {
                            "role": "archive", "engine": "trino", "status": "active",
                            "bindingEpoch": 4, "versionId": "archive-v1",
                            "pipelineVersionId": "pipeline-v1", "catalog": "iceberg",
                            "schema": "gold", "table": "joined", "snapshotId": "77",
                            "sourceBoundary": self.boundary.document(),
                            "checksum": "canonical-checksum",
                            "dimensionVersionIds": {
                                "products": "products-v3", "users": "users-v2",
                            },
                        },
                        {
                            "role": "serving", "engine": "clickhouse", "status": "active",
                            "bindingEpoch": 4, "versionId": "serving-v1",
                            "pipelineVersionId": "pipeline-v1",
                            "database": "asklake_realtime_v2", "table": "joined_v1",
                            "sourceBoundary": self.boundary.document(),
                            "checksum": "canonical-checksum",
                            "dimensionVersionIds": {
                                "products": "products-v3", "users": "users-v2",
                            },
                        },
                    ],
                },
            ))
            session.add(DatasetFreshnessModel(
                dataset_id="joined",
                latest_revision=9,
                latest_run_id="rt:old",
                binding_epoch=4,
                active_serving_engine="clickhouse",
                active_serving_version_id="serving-v1",
                active_archive_snapshot_id="77",
                latest_source_boundary=self.boundary.document(),
                latest_checksum="canonical-checksum",
                latest_mutation_type="append",
            ))

    def evidence(self, role: str, version: str, *, checksum: str = "canonical-checksum") -> ParityEvidence:
        return ParityEvidence(
            role=role,  # type: ignore[arg-type]
            dataset_id="joined",
            pipeline_version_id="pipeline-v1",
            binding_version_id=version,
            boundary=self.boundary,
            dimension_version_ids={"products": "products-v3", "users": "users-v2"},
            row_count=20,
            checksum=checksum,
            distinct_source_position_count=20,
            schema_fingerprint="schema-v1",
            null_count=0,
            error_count=0,
            numeric_sums={"amount": "20"},
            sample_hash="sample-v1",
        )

    def report(self, hot_version: str = "serving-v2") -> ArchiveParityReport:
        return ArchiveParityReport.compare(
            self.evidence("hot", hot_version),
            self.evidence("archive", "archive-v1"),
        )

    def test_rebuild_reservation_retry_and_completion_are_idempotent(self) -> None:
        initial = self.report("serving-v1")
        plan = RebuildPlan.build(
            initial,
            shadow_binding_version_id="serving-shadow-v3",
            physical_database="asklake_realtime_v2",
            physical_table="joined_shadow_v3",
        )
        with Session(self.engine) as session, session.begin():
            repository = RealtimeRecoveryRepository(session)
            repository.record_parity(initial)
            first, created = repository.reserve_rebuild(
                plan,
                expected_binding_epoch=4,
                requested_by="operator",
                reason="restore ClickHouse from verified archive",
                correlation_id="rebuild-1",
            )
            second, retried = repository.reserve_rebuild(
                plan,
                expected_binding_epoch=4,
                requested_by="operator",
                reason="restore ClickHouse from verified archive",
                correlation_id="rebuild-1",
            )
            self.assertTrue(created)
            self.assertFalse(retried)
            self.assertEqual(first.id, second.id)
            self.assertTrue(repository.mark_rebuild_running(plan.operation_id))
            self.assertFalse(repository.mark_rebuild_running(plan.operation_id))
            rebuilt = self.report("serving-shadow-v3")
            repository.record_parity(rebuilt)
            self.assertTrue(repository.mark_rebuild_ready(
                plan.operation_id,
                RebuildCompletionEvidence(rebuilt.report_id, 0, 0),
            ))
            self.assertFalse(repository.mark_rebuild_ready(
                plan.operation_id,
                RebuildCompletionEvidence(rebuilt.report_id, 0, 0),
            ))
        with Session(self.engine) as session:
            operation = session.get(RealtimeRecoveryOperationModel, plan.operation_id)
            self.assertEqual(operation.status, "ready")
            self.assertEqual(operation.attempt_count, 1)
            self.assertEqual([item["nextOffset"] for item in operation.tail_start_offsets], [10, 10])

    def test_cutover_and_retry_publish_one_atomic_epoch(self) -> None:
        report = self.report()
        request = BindingSwitchRequest(
            idempotency_key="cutover-joined-v2",
            action="cutover",
            dataset_id="joined",
            expected_binding_epoch=4,
            expected_binding_version_id="serving-v1",
            target=target("serving-v2", self.boundary),
            parity_report_id=report.report_id,
            requested_by="operator",
            reason="promote verified ClickHouse shadow binding",
            correlation_id="cutover-correlation",
            gate=approved_gate(),
        )
        with Session(self.engine) as session, session.begin():
            repository = RealtimeRecoveryRepository(session)
            repository.record_parity(report)
            first = repository.switch_binding(request)
        with Session(self.engine) as session, session.begin():
            second = RealtimeRecoveryRepository(session).switch_binding(request)

        self.assertTrue(first.created)
        self.assertFalse(second.created)
        self.assertEqual((first.binding_epoch, first.revision), (5, 10))
        self.assertEqual(first.event_cursor, second.event_cursor)
        with Session(self.engine) as session:
            freshness = session.get(DatasetFreshnessModel, "joined")
            events = session.scalars(select(RealtimeEventModel)).all()
            commits = session.scalars(select(DatasetRevisionCommitModel)).all()
            assignment = session.get(
                RealtimeRoutingAssignmentModel, ("deployment", "dataset", "joined")
            )
            catalog = session.get(CatalogDatasetModel, "joined")
            bindings = dataset_model_to_payload(catalog)["physicalBindings"]
        self.assertEqual((freshness.binding_epoch, freshness.latest_revision), (5, 10))
        self.assertEqual((freshness.active_serving_engine, freshness.active_serving_version_id), (
            "clickhouse", "serving-v2",
        ))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].payload["mutationType"], "replace")
        self.assertEqual(len(commits), 1)
        self.assertEqual((commits[0].binding_epoch, commits[0].mutation_type), (5, "replace"))
        self.assertEqual((assignment.desired_engine, assignment.binding_epoch), ("clickhouse", 5))
        active_serving = [item for item in bindings if item["role"] == "serving" and item["status"] == "active"]
        self.assertEqual([item["versionId"] for item in active_serving], ["serving-v2"])

    def test_rollback_to_archive_uses_new_public_epoch_and_revision(self) -> None:
        self._cutover()
        report = self.report()
        archive_target = PhysicalBindingTarget(
            engine="trino",
            version_id="archive-v1",
            pipeline_version_id="pipeline-v1",
            materialization_id="archive-snapshot-77",
            boundary=self.boundary,
            dimension_version_ids={"products": "products-v3", "users": "users-v2"},
            checksum="canonical-checksum",
            row_count=20,
            catalog="iceberg",
            schema="gold",
            table="joined",
            archive_snapshot_id="77",
        )
        request = BindingSwitchRequest(
            idempotency_key="rollback-joined-v1",
            action="rollback",
            dataset_id="joined",
            expected_binding_epoch=5,
            expected_binding_version_id="serving-v2",
            target=archive_target,
            parity_report_id=report.report_id,
            requested_by="operator",
            reason="rollback to last verified Gold archive binding",
            correlation_id="rollback-correlation",
        )
        with Session(self.engine) as session, session.begin():
            result = RealtimeRecoveryRepository(session).switch_binding(request)
        self.assertEqual((result.binding_epoch, result.revision), (6, 11))
        with Session(self.engine) as session:
            freshness = session.get(DatasetFreshnessModel, "joined")
            catalog = session.get(CatalogDatasetModel, "joined")
            bindings = dataset_model_to_payload(catalog)["physicalBindings"]
            assignment = session.get(
                RealtimeRoutingAssignmentModel, ("deployment", "dataset", "joined")
            )
            events = session.scalars(select(RealtimeEventModel).order_by(RealtimeEventModel.id)).all()
        self.assertEqual((freshness.active_serving_engine, freshness.binding_epoch), ("trino", 6))
        self.assertEqual(freshness.latest_revision, 11)
        self.assertEqual(assignment.desired_engine, "trino")
        self.assertEqual([item["versionId"] for item in bindings if item["role"] == "archive" and item["status"] == "active"], ["archive-v1"])
        self.assertFalse(any(item["role"] == "serving" and item["status"] == "active" for item in bindings))
        self.assertEqual([event.payload["bindingEpoch"] for event in events], [5, 6])

        recutover = BindingSwitchRequest(
            idempotency_key="recutover-joined-v2",
            action="cutover",
            dataset_id="joined",
            expected_binding_epoch=6,
            expected_binding_version_id="archive-v1",
            target=target("serving-v2", self.boundary),
            parity_report_id=report.report_id,
            requested_by="operator",
            reason="restore verified ClickHouse binding after rollback",
            correlation_id="recutover-correlation",
            gate=approved_gate(),
        )
        with Session(self.engine) as session, session.begin():
            restored = RealtimeRecoveryRepository(session).switch_binding(recutover)
        self.assertEqual((restored.binding_epoch, restored.revision), (7, 12))

    def test_mismatched_parity_and_stale_epoch_leave_publication_unchanged(self) -> None:
        mismatch = ArchiveParityReport.compare(
            self.evidence("hot", "serving-v2"),
            self.evidence("archive", "archive-v1", checksum="different"),
        )
        with Session(self.engine) as session:
            with self.assertRaisesRegex(ValueError, "matched parity"):
                with session.begin():
                    repository = RealtimeRecoveryRepository(session)
                    repository.record_parity(mismatch)
                    repository.switch_binding(BindingSwitchRequest(
                        idempotency_key="mismatch-cutover",
                        action="cutover",
                        dataset_id="joined",
                        expected_binding_epoch=4,
                        expected_binding_version_id="serving-v1",
                        target=target("serving-v2", self.boundary),
                        parity_report_id=mismatch.report_id,
                        requested_by="operator",
                        reason="attempt mismatched archive cutover",
                        correlation_id="mismatch-correlation",
                        gate=approved_gate(),
                    ))
        with Session(self.engine) as session:
            freshness = session.get(DatasetFreshnessModel, "joined")
            self.assertEqual((freshness.binding_epoch, freshness.latest_revision), (4, 9))
            self.assertEqual(session.scalar(select(RealtimeEventModel)), None)

    def _cutover(self) -> None:
        report = self.report()
        request = BindingSwitchRequest(
            idempotency_key="cutover-before-rollback",
            action="cutover",
            dataset_id="joined",
            expected_binding_epoch=4,
            expected_binding_version_id="serving-v1",
            target=target("serving-v2", self.boundary),
            parity_report_id=report.report_id,
            requested_by="operator",
            reason="promote verified binding before rollback drill",
            correlation_id="cutover-before-rollback",
            gate=approved_gate(),
        )
        with Session(self.engine) as session, session.begin():
            repository = RealtimeRecoveryRepository(session)
            repository.record_parity(report)
            repository.switch_binding(request)


if __name__ == "__main__":
    unittest.main()
