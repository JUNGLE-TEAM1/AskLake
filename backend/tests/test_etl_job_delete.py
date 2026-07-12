import unittest
from types import SimpleNamespace
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.models import (
    AuditEventModel,
    ETLJobModel,
    ETLRunModel,
    KafkaContinuousBatchModel,
    KafkaContinuousMaintenanceRunModel,
    KafkaContinuousRuntimeModel,
    KafkaContinuousSessionModel,
    KafkaSnapshotModel,
    PermissionGrantModel,
    PrincipalControlModel,
    ResourceLockModel,
)
from app.models.base import Base
from app.services.etl_service import delete_job


def delete_fixture_job(job_id: str = "JOB-DELETE-TEST") -> ETLJobModel:
    return ETLJobModel(
        id=job_id,
        name="Delete regression fixture",
        owner="Test Admin",
        status="scheduled",
        tag="test",
        source="unknown",
        target="unknown",
        schedule="manual",
        source_config=[],
        source_label="Unknown source",
        source_type="unknown",
        execution_mode="snapshot",
        schema_columns=[],
        schema_sample_rows=[],
        target_format="parquet",
        target_layer="RAW",
        rag=False,
        transform_output_columns=[],
        transform_steps=[],
        quality_invalid_rows=[],
        quality_rules=[],
        last_run="-",
        last_state="waiting",
        next_run="-",
        stats={},
        dag_steps=[],
    )


class EtlJobDeleteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:")
        Base.metadata.create_all(
            self.engine,
            tables=[
                ETLJobModel.__table__,
                ETLRunModel.__table__,
                KafkaSnapshotModel.__table__,
                KafkaContinuousRuntimeModel.__table__,
                KafkaContinuousSessionModel.__table__,
                KafkaContinuousBatchModel.__table__,
                KafkaContinuousMaintenanceRunModel.__table__,
                PermissionGrantModel.__table__,
                PrincipalControlModel.__table__,
                ResourceLockModel.__table__,
                AuditEventModel.__table__,
            ],
        )
        self.db = Session(self.engine)

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_delete_removes_job_grants_and_keeps_audit_event(self) -> None:
        job = delete_fixture_job()
        grant = PermissionGrantModel(
            id="grant-delete-test",
            resource_type="etl_job",
            resource_id=job.id,
            principal_type="user",
            principal_id="Test Admin",
            actions=["view", "run", "manage", "delete"],
            source="test",
        )
        self.db.add_all([job, grant])
        self.db.commit()

        with patch("app.repositories.etl_repository.ensure_schema", return_value=None):
            deleted_job_id = delete_job(self.db, job.id, ActorContext(name="Test Admin", role="admin"))

        self.assertEqual(deleted_job_id, job.id)
        self.assertIsNone(self.db.get(ETLJobModel, job.id))
        self.assertIsNone(self.db.get(PermissionGrantModel, grant.id))
        audit_event = self.db.scalar(select(AuditEventModel).where(
            AuditEventModel.action == "etl_job.deleted",
            AuditEventModel.target_id == job.id,
        ))
        self.assertIsNotNone(audit_event)
        self.assertEqual(audit_event.result, "success")

    def test_delete_authorizes_before_disclosing_active_run(self) -> None:
        job = delete_fixture_job("JOB-ACTIVE-PRIVATE")
        self.db.add(job)
        self.db.commit()
        active_run = SimpleNamespace(run_id="secret-run", status="running")

        with (
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.etl_repository.list_run_models_for_job", return_value=[active_run]) as list_runs,
            patch("app.services.etl_service.reconcile_stale_continuous_maintenance_runs") as reconcile,
        ):
            with self.assertRaises(ApiError) as raised:
                delete_job(self.db, job.id, ActorContext(name="Unauthorized User", role="viewer"))

        self.assertEqual(raised.exception.status_code, 403)
        self.assertNotIn("secret-run", str(raised.exception.details or ""))
        list_runs.assert_not_called()
        reconcile.assert_not_called()
        self.assertIsNotNone(self.db.get(ETLJobModel, job.id))

    def test_authorized_delete_reports_active_run(self) -> None:
        job = delete_fixture_job("JOB-ACTIVE-AUTHORIZED")
        self.db.add(job)
        self.db.commit()
        active_run = SimpleNamespace(run_id="visible-run", status="running")

        with (
            patch("app.repositories.etl_repository.ensure_schema", return_value=None),
            patch("app.services.etl_service.etl_repository.list_run_models_for_job", return_value=[active_run]) as list_runs,
            patch("app.services.etl_service.reconcile_stale_continuous_maintenance_runs") as reconcile,
        ):
            with self.assertRaises(ApiError) as raised:
                delete_job(self.db, job.id, ActorContext(name="Test Admin", role="admin"))

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.details, {"runId": "visible-run", "runStatus": "running"})
        list_runs.assert_called_once_with(self.db, job.id)
        reconcile.assert_not_called()
        self.assertIsNotNone(self.db.get(ETLJobModel, job.id))


if __name__ == "__main__":
    unittest.main()
