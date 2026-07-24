#!/usr/bin/env python3
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import os
from uuid import uuid4

from sqlalchemy import delete, select, text

from app.core.config import settings
from app.core.database import SessionLocal
from app.models.catalog import CatalogDatasetModel
from app.models.dashboard_live import DatasetFreshnessModel, DatasetRevisionCommitModel
from app.models.realtime import (
    RealtimeEventModel,
    RealtimeParityCheckModel,
    RealtimeRecoveryOperationModel,
    RealtimeRoutingAssignmentModel,
)
from app.realtime.domain.archive import ArchiveParityReport, ParityEvidence
from app.realtime.domain.cutover import (
    BindingSwitchRequest,
    CutoverGateEvidence,
    PhysicalBindingTarget,
)
from app.realtime.domain.source_boundary import PartitionBoundary, SourceBoundary
from app.realtime.repositories.recovery_repository import RealtimeRecoveryRepository


def main() -> None:
    if os.environ.get("ASKLAKE_VERIFY_REALTIME_POSTGRES", "").lower() != "true":
        raise RuntimeError("Set ASKLAKE_VERIFY_REALTIME_POSTGRES=true with a disposable PostgreSQL DATABASE_URL.")
    if not settings.database_url.startswith(("postgresql://", "postgresql+", "postgres://")):
        raise RuntimeError("Recovery concurrency verification requires PostgreSQL.")

    suffix = uuid4().hex[:12]
    dataset_id = f"verify_recovery_{suffix}"
    pipeline_id = f"pipeline_{suffix}"
    pipeline_version_id = f"pipeline_version_{suffix}"
    old_version = f"serving_old_{suffix}"
    new_version = f"serving_new_{suffix}"
    archive_version = f"archive_{suffix}"
    boundary = SourceBoundary.build((PartitionBoundary(f"clicks.{suffix}", 0, -1, 99),))
    dimensions = {"users": f"users_{suffix}"}
    report = ArchiveParityReport.compare(
        evidence("hot", dataset_id, pipeline_version_id, new_version, boundary, dimensions),
        evidence("archive", dataset_id, pipeline_version_id, archive_version, boundary, dimensions),
    )
    request = BindingSwitchRequest(
        idempotency_key=f"postgres-cutover-{suffix}",
        action="cutover",
        dataset_id=dataset_id,
        expected_binding_epoch=2,
        expected_binding_version_id=old_version,
        target=PhysicalBindingTarget(
            engine="clickhouse",
            version_id=new_version,
            pipeline_version_id=pipeline_version_id,
            materialization_id=f"materialization_{suffix}",
            boundary=boundary,
            dimension_version_ids=dimensions,
            checksum="checksum-100",
            row_count=100,
            database="asklake_realtime_v2",
            table=f"serving_{suffix}",
        ),
        parity_report_id=report.report_id,
        requested_by="postgres-verifier",
        reason="verify concurrent boundary-safe cutover fencing",
        correlation_id=f"correlation-{suffix}",
        gate=approved_gate(),
    )

    try:
        seed(
            dataset_id,
            pipeline_id,
            pipeline_version_id,
            old_version,
            archive_version,
            boundary,
            dimensions,
            report,
        )

        def publish():
            with SessionLocal() as session, session.begin():
                return RealtimeRecoveryRepository(session).switch_binding(request)

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _index: publish(), range(2)))
        assert sorted(result.created for result in results) == [False, True]
        assert len({(result.binding_epoch, result.revision, result.event_cursor) for result in results}) == 1
        with SessionLocal() as session:
            freshness = session.get(DatasetFreshnessModel, dataset_id)
            commits = session.scalars(
                select(DatasetRevisionCommitModel).where(
                    DatasetRevisionCommitModel.dataset_id == dataset_id
                )
            ).all()
            events = session.scalars(
                select(RealtimeEventModel).where(RealtimeEventModel.resource_id == dataset_id)
            ).all()
            assert (freshness.binding_epoch, freshness.latest_revision) == (3, 1)
            assert len(commits) == 1 and len(events) == 1
        print("verify-realtime-recovery-postgres: ok")
    finally:
        cleanup(dataset_id, pipeline_id, pipeline_version_id, report.report_id)


def evidence(role, dataset_id, pipeline_version_id, version_id, boundary, dimensions):
    return ParityEvidence(
        role=role,
        dataset_id=dataset_id,
        pipeline_version_id=pipeline_version_id,
        binding_version_id=version_id,
        boundary=boundary,
        dimension_version_ids=dimensions,
        row_count=100,
        checksum="checksum-100",
        distinct_source_position_count=100,
        schema_fingerprint="schema-100",
        null_count=0,
        error_count=0,
        numeric_sums={"amount": "100"},
        sample_hash="sample-100",
    )


def approved_gate() -> CutoverGateEvidence:
    return CutoverGateEvidence(
        deterministic_fixture_rows=100_000,
        lost_source_positions=0,
        logical_duplicate_count=0,
        shadow_observation_hours=72,
        shadow_parity_passed=True,
        p95_slo_passed=True,
        restart_chaos_passed=True,
        security_passed=True,
        rollback_drill_passed=True,
        operations_dashboard_ready=True,
        runbook_ready=True,
    )


def seed(dataset_id, pipeline_id, pipeline_version_id, old_version, archive_version, boundary, dimensions, report):
    with SessionLocal() as session, session.begin():
        session.execute(text("""
            INSERT INTO realtime_pipelines
                (id, logical_dataset_id, name, execution_mode, owner_user_id)
            VALUES (:id, :dataset_id, :name, 'realtime_incremental', 'postgres-verifier')
        """), {"id": pipeline_id, "dataset_id": dataset_id, "name": pipeline_id})
        session.execute(text("""
            INSERT INTO realtime_pipeline_versions
                (id, pipeline_id, version, pipeline_generation, normalized_sql,
                 sql_fingerprint, source_dataset_id, schema_fingerprint, status, created_by)
            VALUES
                (:id, :pipeline_id, 1, 1, 'SELECT 1', :sql_fingerprint,
                 :source_dataset_id, 'schema-100', 'active', 'postgres-verifier')
        """), {
            "id": pipeline_version_id,
            "pipeline_id": pipeline_id,
            "sql_fingerprint": f"sql-{pipeline_version_id}",
            "source_dataset_id": f"source-{dataset_id}",
        })
        session.add(CatalogDatasetModel(
            id=dataset_id,
            name=dataset_id,
            payload={
                "id": dataset_id,
                "name": dataset_id,
                "physicalBindings": [
                    {
                        "role": "archive", "engine": "trino", "status": "active",
                        "bindingEpoch": 2, "versionId": archive_version,
                        "pipelineVersionId": pipeline_version_id, "catalog": "iceberg",
                        "schema": "gold", "table": dataset_id,
                    },
                    {
                        "role": "serving", "engine": "clickhouse", "status": "active",
                        "bindingEpoch": 2, "versionId": old_version,
                        "pipelineVersionId": pipeline_version_id,
                        "database": "asklake_realtime_v2", "table": f"old_{dataset_id}",
                    },
                ],
            },
        ))
        session.add(DatasetFreshnessModel(
            dataset_id=dataset_id,
            latest_revision=0,
            binding_epoch=2,
            active_serving_engine="clickhouse",
            active_serving_version_id=old_version,
            latest_source_boundary=boundary.document(),
            latest_checksum="checksum-100",
        ))
        RealtimeRecoveryRepository(session).record_parity(report)


def cleanup(dataset_id, pipeline_id, pipeline_version_id, report_id):
    with SessionLocal() as session, session.begin():
        session.execute(delete(RealtimeEventModel).where(RealtimeEventModel.resource_id == dataset_id))
        session.execute(delete(DatasetRevisionCommitModel).where(DatasetRevisionCommitModel.dataset_id == dataset_id))
        session.execute(delete(RealtimeRoutingAssignmentModel).where(RealtimeRoutingAssignmentModel.resource_id == dataset_id))
        session.execute(delete(RealtimeRecoveryOperationModel).where(RealtimeRecoveryOperationModel.dataset_id == dataset_id))
        session.execute(delete(RealtimeParityCheckModel).where(RealtimeParityCheckModel.id == report_id))
        session.execute(delete(DatasetFreshnessModel).where(DatasetFreshnessModel.dataset_id == dataset_id))
        session.execute(delete(CatalogDatasetModel).where(CatalogDatasetModel.id == dataset_id))
        session.execute(text("DELETE FROM realtime_pipeline_versions WHERE id = :id"), {"id": pipeline_version_id})
        session.execute(text("DELETE FROM realtime_pipelines WHERE id = :id"), {"id": pipeline_id})


if __name__ == "__main__":
    main()
