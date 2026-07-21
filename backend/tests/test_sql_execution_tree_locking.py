from __future__ import annotations

from datetime import UTC, datetime, timedelta
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

from fastapi import status
from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.models.base import Base
from app.models.continuous_sql import (
    ContinuousSqlDependencyModel,
    ContinuousSqlRunModel,
    ContinuousSqlTreeJobLockModel,
    ContinuousSqlTreeNodeRunModel,
    ContinuousSqlTreeRunModel,
)
from app.models.etl import ETLJobModel
from app.repositories.continuous_sql_repository import (
    ContinuousSqlRepository,
    job_to_schema_with_tree,
)
from app.repositories.execution_tree_lock_repository import (
    require_standalone_job_unlocked,
    require_tree_owned_job,
)
from app.repositories.dashboard_live_repository import DashboardLiveRepository
from app.services.continuous_sql_revision_runner import ContinuousSqlRevisionRunner
from app.services.continuous_sql_service import ContinuousSqlService
from app.schemas.continuous_sql import ContinuousSqlCommandRequest
from tests.test_dashboard_job_binding_schema_removal import _run_alembic
from tests.test_sql_execution_tree_persistence import continuous_job


PREVIOUS_REVISION = "0023_sql_job_execution_tree_persistence"
HEAD_REVISION = "0025_dataset_revision_snapshot_identity"


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

    def _seed_parent(
        self,
        db: Session,
        job_id: str,
        output_id: str,
        child_ids: list[str],
        *,
        input_types: dict[str, str] | None = None,
    ):
        repository = ContinuousSqlRepository(db)
        job = repository.add_job(parent_job(job_id, output_id))
        repository.replace_dependencies(job.id, [
            ContinuousSqlDependencyModel(
                sql_job_id=job.id,
                input_dataset_id=f"dataset-{child_id}",
                child_job_id=child_id,
                input_type=(input_types or {}).get(child_id, "batch"),
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
            require_tree_owned_job(
                db,
                "JOB-A",
                tree_run_id=tree.tree_run_id,
                fencing_token=tree.fencing_token,
                action="command:run",
            )
            with self.assertRaises(ApiError) as wrong_owner:
                require_tree_owned_job(
                    db,
                    "JOB-A",
                    tree_run_id=tree.tree_run_id,
                    fencing_token="stale-fence",
                    action="command:run",
                )
            self.assertEqual(wrong_owner.exception.code, "CONTINUOUS_SQL_DEPENDENCY_CONFLICT")

    def test_parent_starts_batch_then_realtime_child_before_sql_worker(self) -> None:
        events: list[str] = []

        class Gateway:
            def manage(self, _job, _run, action, _options=None):
                events.append(f"parent:{action}")
                return {"containerState": "running", "containerId": "parent-worker"}

        def child_commander(_db, child_id, command, _actor, **context):
            self.assertEqual(context["tree_run_id"].startswith("tree_csql-parent_"), True)
            self.assertTrue(context["tree_fencing_token"])
            events.append(f"{child_id}:{command}")
            if command == "run":
                return SimpleNamespace(
                    run=SimpleNamespace(run_id=f"run-{child_id}", status="queued"),
                    processing_result={},
                )
            return SimpleNamespace(
                run=None,
                processing_result={"runtimeStatus": "starting", "workerResult": {"workerAttemptId": f"worker-{child_id}"}},
            )

        with Session(self.engine) as db:
            db.add_all([
                producer_job("JOB-BATCH", "dataset-JOB-BATCH"),
                producer_job("JOB-REALTIME", "dataset-JOB-REALTIME"),
            ])
            db.commit()
            job = self._seed_parent(
                db,
                "csql-parent",
                "output-parent",
                ["JOB-REALTIME", "JOB-BATCH"],
                input_types={"JOB-REALTIME": "realtime", "JOB-BATCH": "batch"},
            )
            service = ContinuousSqlService(
                db,
                runtime_settings=self.settings,
                gateway=Gateway(),
                child_commander=child_commander,
            )

            response = service.command(
                job.id,
                ContinuousSqlCommandRequest(command="start", commandId="start-tree-children"),
                ActorContext(name="owner", role="admin"),
            )

            self.assertEqual(
                events,
                ["JOB-BATCH:run", "JOB-REALTIME:startContinuous", "parent:start"],
            )
            nodes = {node.job_id: node for node in response.job.active_tree_run.nodes}
            self.assertEqual(nodes["JOB-BATCH"].producer_run_id, "run-JOB-BATCH")
            self.assertEqual(nodes["JOB-BATCH"].status, "queued")
            self.assertEqual(nodes["JOB-REALTIME"].producer_run_id, "worker-JOB-REALTIME")
            self.assertEqual(nodes["JOB-REALTIME"].status, "starting")

    def test_child_start_failure_skips_parent_worker_and_releases_tree_locks(self) -> None:
        class Gateway:
            def __init__(self) -> None:
                self.start_calls = 0

            def manage(self, _job, _run, action, _options=None):
                if action == "start":
                    self.start_calls += 1
                return {"containerState": "running"}

        def child_commander(_db, _child_id, _command, _actor, **_context):
            raise ApiError("KAFKA_START_FAILED", "producer start failed", status.HTTP_502_BAD_GATEWAY)

        with Session(self.engine) as db:
            db.add(producer_job("JOB-A", "dataset-JOB-A"))
            db.commit()
            job = self._seed_parent(db, "csql-parent", "output-parent", ["JOB-A"])
            gateway = Gateway()
            service = ContinuousSqlService(
                db,
                runtime_settings=self.settings,
                gateway=gateway,
                child_commander=child_commander,
            )

            with self.assertRaises(ApiError) as raised:
                service.command(
                    job.id,
                    ContinuousSqlCommandRequest(command="start", commandId="start-tree-child-fails"),
                    ActorContext(name="owner", role="admin"),
                )

            self.assertEqual(raised.exception.code, "CONTINUOUS_SQL_DEPENDENCY_UNAVAILABLE")
            self.assertEqual(gateway.start_calls, 0)
            refreshed = service.repository.get_job(job.id)
            self.assertEqual(refreshed.observed_state, "failed")
            self.assertIsNone(service.repository.active_tree_run(job.id))
            self.assertTrue(all(
                not item.active
                for item in db.scalars(select(ContinuousSqlTreeJobLockModel)).all()
            ))

    def test_dataset_revision_tree_rejects_before_starting_any_child(self) -> None:
        events: list[str] = []

        class Gateway:
            def manage(self, _job, _run, action, _options=None):
                events.append(f"parent:{action}")
                return {"containerState": "running"}

        def child_commander(_db, child_id, command, _actor, **_context):
            events.append(f"{child_id}:{command}")
            return SimpleNamespace(run=None, processing_result={})

        with Session(self.engine) as db:
            db.add(producer_job("JOB-REALTIME", "dataset-JOB-REALTIME"))
            db.commit()
            job = self._seed_parent(
                db,
                "csql-parent",
                "output-parent",
                ["JOB-REALTIME"],
                input_types={"JOB-REALTIME": "realtime"},
            )
            job.compiled_plan = {"executionInputMode": "dataset_revision"}
            db.add(job)
            db.commit()
            service = ContinuousSqlService(
                db,
                runtime_settings=self.settings,
                gateway=Gateway(),
                child_commander=child_commander,
            )

            with self.assertRaises(ApiError) as raised:
                service.command(
                    job.id,
                    ContinuousSqlCommandRequest(command="start", commandId="start-needs-runner"),
                    ActorContext(name="owner", role="admin"),
                )

            self.assertEqual(raised.exception.code, "CONTINUOUS_SQL_REVISION_RUNNER_REQUIRED")
            self.assertEqual(events, [])
            self.assertEqual(db.scalar(select(ContinuousSqlTreeRunModel)), None)
            self.assertEqual(db.scalar(select(ContinuousSqlTreeJobLockModel)), None)

    def test_revision_transform_request_uses_only_dataset_revisions_and_snapshots(self) -> None:
        with Session(self.engine) as db:
            db.add(producer_job("JOB-REALTIME", "dataset-JOB-REALTIME"))
            db.commit()
            job = self._seed_parent(
                db,
                "csql-parent",
                "output-parent",
                ["JOB-REALTIME"],
                input_types={"JOB-REALTIME": "realtime"},
            )
            job.compiled_plan = {
                "executionInputMode": "dataset_revision",
                "streamingSource": {
                    "broker": "kafka:9092",
                    "topic": "events",
                    "consumerGroupId": "must-not-leak",
                    "maxOffsetsPerTrigger": 100,
                },
            }
            repository = ContinuousSqlRepository(db)
            repository.replace_dependencies(job.id, [
                ContinuousSqlDependencyModel(
                    sql_job_id=job.id,
                    input_dataset_id="dataset-JOB-REALTIME",
                    child_job_id="JOB-REALTIME",
                    input_type="realtime",
                    execution_policy="run_on_tree_start",
                    required=True,
                ),
                ContinuousSqlDependencyModel(
                    sql_job_id=job.id,
                    input_dataset_id="dataset-static",
                    child_job_id=None,
                    input_type="static",
                    execution_policy="reuse_snapshot",
                    required=True,
                ),
            ])
            db.add(job)
            db.commit()
            service = ContinuousSqlService(db, runtime_settings=self.settings)
            run = service._new_run(job, observed_state="starting")
            run.static_bindings = [{"datasetId": "dataset-static", "snapshotId": "snap-101"}]
            tree = service._acquire_execution_tree(job, run)
            tree.input_dataset_revisions = {"dataset-JOB-REALTIME": 42}
            db.add_all([run, tree])
            db.commit()

            payload = service._revision_transform_request(job, run).model_dump(
                by_alias=True,
                mode="json",
            )

            self.assertEqual(payload["executionInputMode"], "dataset_revision")
            self.assertEqual(payload["treeRunId"], tree.tree_run_id)
            self.assertEqual(payload["continuousSqlRunId"], run.run_id)
            self.assertEqual(payload["inputDatasets"], [
                {
                    "inputDatasetId": "dataset-JOB-REALTIME",
                    "inputType": "realtime",
                    "childJobId": "JOB-REALTIME",
                    "executionPolicy": "run_on_tree_start",
                    "required": True,
                    "revision": 42,
                    "snapshotId": None,
                },
                {
                    "inputDatasetId": "dataset-static",
                    "inputType": "static",
                    "childJobId": None,
                    "executionPolicy": "reuse_snapshot",
                    "required": True,
                    "revision": None,
                    "snapshotId": "snap-101",
                },
            ])
            serialized = json.dumps(payload, sort_keys=True)
            self.assertNotIn("kafka:9092", serialized)
            self.assertNotIn("consumerGroupId", serialized)
            self.assertNotIn("maxOffsetsPerTrigger", serialized)

    def test_revision_runner_pins_exact_revision_snapshot_on_tree(self) -> None:
        with Session(self.engine) as db:
            db.add(producer_job("JOB-REALTIME", "dataset-JOB-REALTIME"))
            db.commit()
            job = self._seed_parent(
                db,
                "csql-parent",
                "output-parent",
                ["JOB-REALTIME"],
                input_types={"JOB-REALTIME": "realtime"},
            )
            repository = ContinuousSqlRepository(db)
            run = ContinuousSqlRunModel(
                run_id="run-1", job_id=job.id, generation=1, fencing_token="fence-1",
                plan_hash=job.plan_hash, status="starting", static_bindings=[],
                checkpoint_path=job.checkpoint_path, started_at="2026-07-21T00:00:00+00:00",
            )
            repository.add_run(run)
            tree = ContinuousSqlTreeRunModel(
                tree_run_id="tree-1", sql_job_id=job.id,
                continuous_sql_run_id=run.run_id, generation=1, trigger_type="parent_tree",
                status="starting", fencing_token="tree-fence",
                lease_expires_at=datetime.now(UTC) + timedelta(minutes=1),
                input_dataset_revisions={}, started_at="2026-07-21T00:00:00+00:00",
            )
            repository.add_tree_run(tree)
            repository.add_tree_nodes([
                ContinuousSqlTreeNodeRunModel(
                    node_run_id="node-parent", tree_run_id=tree.tree_run_id,
                    job_id=job.id, node_type="parent", input_dataset_revisions={},
                    started_at="2026-07-21T00:00:00+00:00",
                ),
                ContinuousSqlTreeNodeRunModel(
                    node_run_id="node-child", tree_run_id=tree.tree_run_id,
                    job_id="JOB-REALTIME", node_type="realtime", input_dataset_revisions={},
                    started_at="2026-07-21T00:00:00+00:00",
                ),
            ])
            DashboardLiveRepository(db).record_dataset_commit(
                dataset_id="dataset-JOB-REALTIME", run_id="producer-run-7",
                storage_location="s3a://lake/realtime", storage_format="iceberg",
                materialization_mode="delta", row_count=10, next_check_after_ms=1_000,
                commit_kind="legacy", snapshot_id="snapshot-7",
            )
            db.commit()

            pinned = ContinuousSqlRevisionRunner(db).pin_inputs(job, run)

            self.assertEqual(pinned[0].dataset_id, "dataset-JOB-REALTIME")
            self.assertEqual(pinned[0].revision, 1)
            self.assertEqual(pinned[0].snapshot_id, "snapshot-7")
            self.assertEqual(tree.input_dataset_revisions, {"dataset-JOB-REALTIME": 1})
            child = next(item for item in repository.list_tree_nodes(tree.tree_run_id) if item.job_id == "JOB-REALTIME")
            self.assertEqual(child.input_dataset_revisions, {"dataset-JOB-REALTIME": 1})

    def test_parent_start_failure_compensates_started_realtime_children(self) -> None:
        events: list[str] = []

        class Gateway:
            def manage(self, _job, _run, action, _options=None):
                events.append(f"parent:{action}")
                if action == "start":
                    raise ApiError(
                        "PARENT_START_FAILED",
                        "parent worker start failed",
                        status.HTTP_502_BAD_GATEWAY,
                    )
                return {"containerState": "missing"}

        def child_commander(_db, child_id, command, _actor, **_context):
            events.append(f"{child_id}:{command}")
            if command == "startContinuous":
                return SimpleNamespace(
                    run=None,
                    processing_result={"runtimeStatus": "starting", "workerResult": {"workerAttemptId": "child-worker"}},
                )
            return SimpleNamespace(
                run=None,
                processing_result={"runtimeStatus": "stopping"},
            )

        with Session(self.engine) as db:
            db.add(producer_job("JOB-REALTIME", "dataset-JOB-REALTIME"))
            db.commit()
            job = self._seed_parent(
                db,
                "csql-parent",
                "output-parent",
                ["JOB-REALTIME"],
                input_types={"JOB-REALTIME": "realtime"},
            )
            service = ContinuousSqlService(
                db,
                runtime_settings=self.settings,
                gateway=Gateway(),
                child_commander=child_commander,
            )

            with self.assertRaises(ApiError) as raised:
                service.command(
                    job.id,
                    ContinuousSqlCommandRequest(command="start", commandId="start-parent-fails"),
                    ActorContext(name="owner", role="admin"),
                )

            self.assertEqual(raised.exception.code, "PARENT_START_FAILED")
            self.assertEqual(
                events,
                [
                    "JOB-REALTIME:startContinuous",
                    "parent:start",
                    "JOB-REALTIME:stopContinuous",
                ],
            )
            refreshed = service.repository.get_job(job.id)
            self.assertEqual(refreshed.observed_state, "failed")
            self.assertIsNone(service.repository.active_tree_run(job.id))
            self.assertTrue(all(
                not item.active
                for item in db.scalars(select(ContinuousSqlTreeJobLockModel)).all()
            ))
            tree = db.scalar(select(ContinuousSqlTreeRunModel))
            self.assertEqual(tree.status, "failed")
            self.assertTrue(all(
                item.status == "failed"
                for item in db.scalars(select(ContinuousSqlTreeNodeRunModel)).all()
            ))

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
                child_commander=lambda _db, child_id, _command, _actor, **_context: SimpleNamespace(
                    run=SimpleNamespace(run_id=f"run-{child_id}", status="queued"),
                    processing_result={},
                ),
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

    def test_parent_lifecycle_propagates_only_to_tree_owned_realtime_child(self) -> None:
        events: list[tuple[str, str]] = []

        def child_commander(_db, child_id, command, _actor, **context):
            events.append((child_id, command))
            self.assertTrue(context["tree_fencing_token"])
            return SimpleNamespace(run=None, processing_result={"runtimeStatus": "stopping"})

        with Session(self.engine) as db:
            db.add_all([
                producer_job("JOB-BATCH", "dataset-JOB-BATCH"),
                producer_job("JOB-REALTIME", "dataset-JOB-REALTIME"),
            ])
            db.commit()
            job = self._seed_parent(
                db,
                "csql-parent",
                "output-parent",
                ["JOB-BATCH", "JOB-REALTIME"],
                input_types={"JOB-REALTIME": "realtime", "JOB-BATCH": "batch"},
            )
            service = ContinuousSqlService(
                db,
                runtime_settings=self.settings,
                child_commander=child_commander,
            )
            tree = service._acquire_execution_tree(job, SimpleNamespace(run_id="run-parent"))
            db.commit()

            service._manage_execution_tree_realtime_children(
                job,
                ActorContext(name="owner", role="admin"),
                "stopContinuous",
            )

            self.assertEqual(events, [("JOB-REALTIME", "stopContinuous")])
            nodes = {item.job_id: item for item in service.repository.list_tree_nodes(tree.tree_run_id)}
            self.assertEqual(nodes["JOB-REALTIME"].status, "stopping")
            self.assertEqual(nodes["JOB-BATCH"].status, "locked")


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
