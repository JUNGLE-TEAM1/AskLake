from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.models.base import Base
from app.models.continuous_sql import (
    ContinuousSqlDependencyModel,
    ContinuousSqlTreeJobLockModel,
    ContinuousSqlTreeRunModel,
)
from app.models.etl import ETLJobModel
from app.repositories.continuous_sql_repository import (
    ContinuousSqlRepository,
    job_to_schema_with_tree,
)
from app.repositories.execution_tree_lock_repository import require_standalone_job_unlocked
from app.services.continuous_sql_service import ContinuousSqlService
from app.schemas.continuous_sql import ContinuousSqlCommandRequest
from tests.test_dashboard_job_binding_schema_removal import _run_alembic
from tests.test_sql_execution_tree_persistence import continuous_job


PREVIOUS_REVISION = "0023_sql_job_execution_tree_persistence"
HEAD_REVISION = "0024_sql_execution_tree_locking"


def producer_job(job_id: str, dataset_id: str, *, status: str = "scheduled") -> ETLJobModel:
    return ETLJobModel(
        id=job_id,
        name=job_id,
        owner="owner",
        status=status,
        tag="test",
        source="fixture",
        target=dataset_id,
        schedule="manual",
        source_config=[],
        source_label="fixture",
        source_type="SQL Result",
        job_kind="trino_sql_materialization",
        execution_mode="snapshot",
        schema_columns=[],
        schema_sample_rows=[],
        target_format="iceberg",
        target_layer="SILVER",
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
        dataset_id=dataset_id,
    )


def parent_job(job_id: str, output_dataset_id: str):
    job = continuous_job(job_id)
    job.output_dataset_id = output_dataset_id
    job.output_dataset_name = output_dataset_id
    return job


class SqlExecutionTreeLockingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:")
        Base.metadata.create_all(self.engine, tables=[ETLJobModel.__table__])
        self.settings = Settings(
            _env_file=None,
            app_env="test",
            continuous_sql_join_enabled=True,
            continuous_sql_tree_lock_lease_seconds=120,
        )

    def tearDown(self) -> None:
        self.engine.dispose()

    def _seed_parent(self, db: Session, job_id: str, output_id: str, child_ids: list[str]):
        repository = ContinuousSqlRepository(db)
        job = repository.add_job(parent_job(job_id, output_id))
        repository.replace_dependencies(job.id, [
            ContinuousSqlDependencyModel(
                sql_job_id=job.id,
                input_dataset_id=f"dataset-{child_id}",
                child_job_id=child_id,
                input_type="batch",
                execution_policy="run_on_tree_start",
                required=True,
            )
            for child_id in child_ids
        ])
        db.commit()
        return job

    def test_parent_acquires_complete_sorted_lock_set_and_blocks_standalone(self) -> None:
        with Session(self.engine) as db:
            db.add_all([
                producer_job("JOB-A", "dataset-JOB-A"),
                producer_job("JOB-B", "dataset-JOB-B"),
            ])
            db.commit()
            job = self._seed_parent(db, "csql-parent", "output-parent", ["JOB-B", "JOB-A"])
            service = ContinuousSqlService(db, runtime_settings=self.settings)

            tree = service._acquire_execution_tree(job, SimpleNamespace(run_id="csql-run-1"))
            db.commit()

            locks = service.repository.list_tree_locks(tree.tree_run_id)
            self.assertEqual([item.job_id for item in locks], ["JOB-A", "JOB-B", "csql-parent"])
            self.assertTrue(all(item.active for item in locks))
            response = job_to_schema_with_tree(job, service.repository)
            self.assertEqual(response.execution_tree.active_tree_run_id, tree.tree_run_id)
            parent_node = next(
                item for item in response.active_tree_run.nodes if item.node_type == "parent"
            )
            child_node = next(
                item for item in response.active_tree_run.nodes if item.node_type == "batch"
            )
            self.assertIsNone(parent_node.parent_run_id)
            self.assertEqual(child_node.parent_run_id, tree.tree_run_id)
            self.assertEqual(len(response.active_tree_run.fencing_token_hash), 64)
            self.assertNotEqual(response.active_tree_run.fencing_token_hash, tree.fencing_token)
            with self.assertRaises(ApiError) as raised:
                require_standalone_job_unlocked(db, "JOB-A", action="command:run")
            self.assertEqual(raised.exception.code, "CONTINUOUS_SQL_DEPENDENCY_CONFLICT")

    def test_start_command_persists_tree_before_starting_worker(self) -> None:
        class Gateway:
            def __init__(self) -> None:
                self.lock_visible_during_start = False

            def manage(self, job, _run, action, _options=None):
                if action == "start":
                    with Session(self_engine) as verification_db:
                        lock = verification_db.get(ContinuousSqlTreeJobLockModel, job.id)
                        self.lock_visible_during_start = bool(lock and lock.active)
                    return {"containerState": "running", "containerId": "worker-tree"}
                return {"containerState": "missing"}

        self_engine = self.engine
        with Session(self.engine) as db:
            db.add(producer_job("JOB-A", "dataset-JOB-A"))
            db.commit()
            job = self._seed_parent(db, "csql-parent", "output-parent", ["JOB-A"])
            gateway = Gateway()
            service = ContinuousSqlService(
                db,
                runtime_settings=self.settings,
                gateway=gateway,
            )

            response = service.command(
                job.id,
                ContinuousSqlCommandRequest(command="start", commandId="start-tree-1"),
                ActorContext(name="owner", role="admin"),
            )

            self.assertTrue(gateway.lock_visible_during_start)
            self.assertEqual(response.job.observed_state, "running")
            self.assertIsNotNone(response.job.active_tree_run)
            self.assertEqual(response.job.active_tree_run.status, "running")
            self.assertEqual(
                set(response.job.execution_tree.locked_job_ids),
                {"csql-parent", "JOB-A"},
            )
            stopped = service.command(
                job.id,
                ContinuousSqlCommandRequest(command="stop", commandId="stop-tree-1"),
                ActorContext(name="owner", role="admin"),
            )
            self.assertEqual(stopped.job.observed_state, "stopped")
            self.assertIsNone(stopped.job.active_tree_run)
            self.assertTrue(all(
                not item.active
                for item in service.repository.list_tree_locks(
                    response.job.active_tree_run.tree_run_id
                )
            ))

    def test_conflict_rolls_back_every_lock_and_tree_row(self) -> None:
        with Session(self.engine) as db:
            db.add_all([
                producer_job("JOB-A", "dataset-JOB-A"),
                producer_job("JOB-B", "dataset-JOB-B"),
            ])
            db.commit()
            first = self._seed_parent(db, "csql-first", "output-first", ["JOB-A"])
            second = self._seed_parent(db, "csql-second", "output-second", ["JOB-A", "JOB-B"])
            service = ContinuousSqlService(db, runtime_settings=self.settings)
            first_tree = service._acquire_execution_tree(first, SimpleNamespace(run_id="run-first"))
            db.commit()

            with self.assertRaises(ApiError) as raised:
                service._acquire_execution_tree(second, SimpleNamespace(run_id="run-second"))
            db.rollback()

            self.assertEqual(raised.exception.code, "CONTINUOUS_SQL_DEPENDENCY_CONFLICT")
            locks = list(db.scalars(select(ContinuousSqlTreeJobLockModel)).all())
            self.assertEqual({item.job_id for item in locks}, {"csql-first", "JOB-A"})
            self.assertEqual(
                db.scalar(select(ContinuousSqlTreeRunModel).where(
                    ContinuousSqlTreeRunModel.sql_job_id == second.id
                )),
                None,
            )
            self.assertEqual(service.repository.get_tree_run(first_tree.tree_run_id).status, "starting")

    def test_active_standalone_child_rejects_parent_before_any_tree_row(self) -> None:
        with Session(self.engine) as db:
            db.add(producer_job("JOB-A", "dataset-JOB-A", status="running"))
            db.commit()
            job = self._seed_parent(db, "csql-parent", "output-parent", ["JOB-A"])
            service = ContinuousSqlService(db, runtime_settings=self.settings)

            with self.assertRaises(ApiError) as raised:
                service._acquire_execution_tree(job, SimpleNamespace(run_id="run-parent"))
            db.rollback()

            self.assertEqual(raised.exception.code, "CONTINUOUS_SQL_DEPENDENCY_CONFLICT")
            self.assertEqual(db.scalar(select(ContinuousSqlTreeRunModel)), None)

    def test_expired_lock_can_be_taken_over_with_monotonic_generation(self) -> None:
        with Session(self.engine) as db:
            db.add(producer_job("JOB-A", "dataset-JOB-A"))
            db.commit()
            first = self._seed_parent(db, "csql-first", "output-first", ["JOB-A"])
            second = self._seed_parent(db, "csql-second", "output-second", ["JOB-A"])
            service = ContinuousSqlService(db, runtime_settings=self.settings)
            first_tree = service._acquire_execution_tree(first, SimpleNamespace(run_id="run-first"))
            db.commit()
            for lock in service.repository.list_tree_locks(first_tree.tree_run_id):
                lock.lease_expires_at = datetime.now(UTC).replace(tzinfo=None) - timedelta(seconds=1)
                db.add(lock)
            db.commit()

            second_tree = service._acquire_execution_tree(second, SimpleNamespace(run_id="run-second"))
            db.commit()

            child_lock = db.get(ContinuousSqlTreeJobLockModel, "JOB-A")
            self.assertEqual(child_lock.tree_run_id, second_tree.tree_run_id)
            self.assertEqual(child_lock.generation, 2)


class SqlExecutionTreeLockingMigrationTests(unittest.TestCase):
    def test_upgrade_and_downgrade_preserve_phase_two_tables(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / "tree-locking.sqlite"
            engine = create_engine(f"sqlite+pysqlite:///{database_path}")
            try:
                _run_alembic(database_path, "upgrade", PREVIOUS_REVISION)
                _run_alembic(database_path, "upgrade", "head")
                tables = set(inspect(engine).get_table_names())
                self.assertTrue({
                    "continuous_sql_tree_runs",
                    "continuous_sql_tree_node_runs",
                    "continuous_sql_tree_job_locks",
                }.issubset(tables))
                with engine.connect() as connection:
                    self.assertEqual(
                        connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one(),
                        HEAD_REVISION,
                    )

                _run_alembic(database_path, "downgrade", PREVIOUS_REVISION)
                tables = set(inspect(engine).get_table_names())
                self.assertNotIn("continuous_sql_tree_runs", tables)
                self.assertIn("continuous_sql_dependencies", tables)
            finally:
                engine.dispose()


if __name__ == "__main__":
    unittest.main()
