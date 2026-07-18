import hashlib
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
import unittest

from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext
from app.core.config import Settings
from app.models.continuous_sql import ContinuousSqlBatchModel, ContinuousSqlJobModel
from app.models.etl import ETLJobModel
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.continuous_sql_repository import ContinuousSqlRepository
from app.repositories.dashboard_live_repository import ensure_dashboard_live_schema
from app.repositories.realtime_event_repository import ensure_realtime_event_schema
from app.schemas.continuous_sql import (
    ContinuousSqlCommandRequest,
    ContinuousSqlCreateRequest,
)
from app.schemas.iceberg import IcebergCommitEvidence
from app.services.continuous_sql_planner import CatalogRelation, ContinuousSqlPlanner
from app.services.continuous_sql_catalog import parse_row_count, unique_key_sets
from app.services.continuous_sql_publication import (
    ContinuousSqlPublicationError,
    ContinuousSqlPublicationService,
    validate_publication_identity,
)
from app.services.continuous_sql_service import (
    ContinuousSqlService,
    continuous_sql_startup_grace_active,
    worker_identity_error,
)


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))
from continuous_sql_runtime import (  # noqa: E402
    binding_manifest_path,
    validate_binding_manifest,
    validate_runtime_plan,
)


@compiles(JSONB, "sqlite")
def compile_jsonb_for_sqlite(_type, _compiler, **_kwargs):
    return "JSON"


class FakeGateway:
    def __init__(self) -> None:
        self.calls: list[tuple[str, int | None, dict | None]] = []
        self.status_result = {"containerState": "running", "report": None}

    def manage(self, _job, run, action, options=None):
        self.calls.append((action, run.generation if run else None, options))
        if action == "status":
            return self.status_result
        if action == "ack":
            return {"containerState": "running", "acknowledgedBatchId": options["batchId"]}
        return {
            "containerId": f"worker-{run.generation if run else 0}",
            "containerState": "running" if action == "start" else f"{action}Requested",
        }


class FakeIcebergWriter:
    def __init__(self) -> None:
        self.verified_runs: list[str] = []

    def verify_commit(
        self,
        target,
        *,
        created_table,
        job_id,
        run_id,
        expected_snapshot_id,
        schema_fingerprint,
        rule_fingerprint,
        source_boundary,
    ):
        return IcebergCommitEvidence(
            createdTable=created_table,
            jobId=job_id,
            runId=run_id,
            target=target,
            queryEngineTable=target.query_engine_table(),
            snapshotId=expected_snapshot_id,
            committedAt="2026-07-16T00:00:01Z",
            warehouseLocation="s3://warehouse/asklake/orders_users",
            schemaFingerprint=schema_fingerprint,
            ruleFingerprint=rule_fingerprint,
            sourceBoundary=source_boundary,
        )

    def verify_snapshot_run_row_count(
        self,
        _target,
        *,
        snapshot_id,
        run_id,
        expected_row_count,
    ):
        self.verified_runs.append(run_id)
        self.last_verification = (snapshot_id, expected_row_count)
        return expected_row_count


class ContinuousSqlRuntimeContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:")
        self.db = Session(self.engine)
        ensure_dashboard_live_schema(self.db)
        ensure_realtime_event_schema(self.db)
        self.repository = ContinuousSqlRepository(self.db)
        self.gateway = FakeGateway()
        self.settings = Settings(
            _env_file=None,
            app_env="test",
            continuous_sql_join_enabled=True,
            latest_static_per_batch_enabled=True,
        )
        self.service = ContinuousSqlService(
            self.db,
            runtime_settings=self.settings,
            gateway=self.gateway,
        )
        self.actor = ActorContext(name="owner", role="admin")
        self.plan = self._plan()
        self.job = ContinuousSqlJobModel(
            id="csql-job",
            name="orders with users",
            owner="owner",
            created_by="owner",
            original_sql=self.plan["normalizedSql"],
            normalized_sql=self.plan["normalizedSql"],
            plan_version=self.plan["planVersion"],
            plan_hash=self.plan["planHash"],
            compiled_plan=self.plan,
            relation_bindings=self.plan["relations"],
            static_binding_policy="PINNED_AT_START",
            trigger_interval_seconds=10,
            checkpoint_path="s3a://lake/checkpoints/csql-job",
            output_dataset_id="dataset-output",
            output_dataset_name="orders_users",
            output_layer="GOLD",
            output_storage_path="s3a://lake/continuous-sql/orders-users",
            output_target={
                "catalog": "iceberg",
                "namespace": "asklake",
                "table": "orders_users",
                "writeMode": "append",
                "partitionColumns": [],
            },
            desired_state="stopped",
            observed_state="stopped",
            generation=0,
        )
        self.repository.add_job(self.job)
        self.db.commit()
        self.service._resolve_run_bindings = lambda _job: [
            {"datasetId": "dataset-users", "snapshotId": "101", "schemaFingerprint": "users-schema"}
        ]
        self.service._require_relation_access = lambda _job, _actor: None

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    @staticmethod
    def _plan():
        stream = CatalogRelation(
            "dataset-events", "events", ("events",), "streaming",
            {"catalog": "iceberg", "schema": "asklake", "table": "events", "format": "iceberg"},
            (("event_id", "bigint"), ("user_id", "bigint")), "events-schema", None,
            {"broker": "redpanda:9092", "topic": "events", "consumerGroupId": "csql"}, (),
        )
        users = CatalogRelation(
            "dataset-users", "users", ("users",), "static",
            {"catalog": "iceberg", "schema": "asklake", "table": "users", "format": "iceberg"},
            (("id", "bigint"), ("name", "string")), "users-schema", "101", None, (("id",),),
        )
        return ContinuousSqlPlanner().compile(
            "SELECT e.event_id, u.name AS user_name FROM events e LEFT JOIN users u ON e.user_id = u.id",
            [stream, users],
        ).plan

    def test_runtime_plan_and_binding_manifest_are_generation_fenced(self) -> None:
        runtime_plan = {
            **self.plan,
            "runGeneration": 3,
            "fencingToken": "fence-token",
            "staticBindings": [{"datasetId": "dataset-users", "snapshotId": "101"}],
        }
        validate_runtime_plan(runtime_plan)
        self.assertEqual(
            binding_manifest_path("s3a://lake/output", 3, 7),
            "s3a://lake/output/_continuous-sql-bindings/generation=3/batch_id=7",
        )
        manifest = {
            "batchId": 7,
            "fencingTokenHash": hashlib.sha256(b"fence-token").hexdigest(),
            "planHash": self.plan["planHash"],
            "runGeneration": 3,
            "staticBindingPolicy": "PINNED_AT_START",
            "staticSnapshots": [{"datasetId": "dataset-users", "snapshotId": "101"}],
        }
        validate_binding_manifest(manifest, runtime_plan, 7)
        with self.assertRaisesRegex(RuntimeError, "IDENTITY_MISMATCH"):
            validate_binding_manifest({**manifest, "runGeneration": 2}, runtime_plan, 7)

    def test_catalog_uniqueness_and_statistics_require_explicit_evidence(self) -> None:
        self.assertEqual(unique_key_sets({"indexColumns": ["id"]}), [])
        self.assertEqual(
            unique_key_sets({"indexColumns": ["id"], "indexColumnsUnique": True}),
            [("id",)],
        )
        self.assertEqual(unique_key_sets({"uniqueKeySets": [["tenant_id", "id"]]}), [("tenant_id", "id")])
        self.assertEqual(parse_row_count("12,345"), 12_345)
        self.assertIsNone(parse_row_count("Pending"))

    def test_start_is_persisted_before_gateway_and_duplicate_command_is_idempotent(self) -> None:
        first = self.service.command(
            self.job.id,
            ContinuousSqlCommandRequest(command="start", commandId="command-1"),
            self.actor,
        )
        second = self.service.command(
            self.job.id,
            ContinuousSqlCommandRequest(command="start", commandId="command-1"),
            self.actor,
        )

        self.assertEqual(first.job.generation, 1)
        self.assertEqual(first.job.desired_state, "running")
        self.assertEqual(first.job.observed_state, "running")
        self.assertEqual(
            first.job.active_run.fencing_token_hash,
            hashlib.sha256(self.repository.get_run(first.job.active_run_id).fencing_token.encode()).hexdigest(),
        )
        self.assertFalse(hasattr(first.job.active_run, "fencing_token"))
        self.assertTrue(second.idempotent_replay)
        self.assertEqual([call[0] for call in self.gateway.calls], ["start"])
        run = self.repository.get_run(first.job.active_run_id)
        self.assertEqual(run.static_bindings[0]["snapshotId"], "101")

    def test_starting_job_does_not_fail_while_worker_is_being_provisioned(self) -> None:
        started = self.service.command(
            self.job.id,
            ContinuousSqlCommandRequest(command="start", commandId="start-slow-worker"),
            self.actor,
        )
        job = self.repository.get_job(self.job.id)
        run = self.repository.get_run(started.job.active_run_id)
        job.observed_state = "starting"
        run.status = "starting"
        job.last_error_code = None
        job.last_error_message = None
        self.db.add(job)
        self.db.add(run)
        self.db.commit()
        self.gateway.status_result = {"containerState": "missing", "report": None}

        reconciled = self.service.reconcile(job)

        self.assertEqual(reconciled.observed_state, "starting")
        self.assertIsNone(reconciled.last_error_code)
        self.assertFalse(
            continuous_sql_startup_grace_active(
                reconciled,
                grace_seconds=300,
                now=reconciled.updated_at.replace(tzinfo=UTC) + timedelta(seconds=301),
            )
        )

    def test_transient_clickhouse_broker_failure_stays_recoverable(self) -> None:
        started = self.service.command(
            self.job.id,
            ContinuousSqlCommandRequest(command="start", commandId="start-broker-recovery"),
            self.actor,
        )
        job = self.repository.get_job(self.job.id)
        run = self.repository.get_run(started.job.active_run_id)
        job.output_target = {
            "engine": "clickhouse",
            "database": "asklake",
            "table": "orders_users",
        }
        self.db.add(job)
        self.db.commit()
        self.gateway.status_result = {
            "containerState": "recovering",
            "lastErrorCode": "CLICKHOUSE_KAFKA_RECOVERING",
            "lastErrorMessage": "Local: Broker transport failure",
        }

        reconciled = self.service.reconcile(job)

        self.assertEqual(reconciled.desired_state, "running")
        self.assertEqual(reconciled.observed_state, "recovering")
        self.assertIsNone(reconciled.last_error_code)
        self.assertEqual(run.generation, 1)

    def test_invalid_duplicate_start_and_lifecycle_transitions(self) -> None:
        self.service.command(
            self.job.id,
            ContinuousSqlCommandRequest(command="start", commandId="start-1"),
            self.actor,
        )
        with self.assertRaisesRegex(Exception, "invalid for the current"):
            self.service.command(
                self.job.id,
                ContinuousSqlCommandRequest(command="start", commandId="start-2"),
                self.actor,
            )
        paused = self.service.command(
            self.job.id,
            ContinuousSqlCommandRequest(command="pause", commandId="pause-1"),
            self.actor,
        )
        self.assertEqual(paused.job.desired_state, "paused")
        self.assertEqual(paused.job.observed_state, "pausing")

        current = self.repository.get_job(self.job.id)
        current.observed_state = "paused"
        self.db.add(current)
        self.db.commit()
        resumed = self.service.command(
            self.job.id,
            ContinuousSqlCommandRequest(command="resume", commandId="resume-1"),
            self.actor,
        )
        self.assertEqual(resumed.job.generation, 1)
        self.assertEqual(resumed.job.desired_state, "running")

    def test_new_generation_pins_refreshed_static_snapshot(self) -> None:
        snapshots = ["101", "102"]
        self.service._resolve_run_bindings = lambda _job: [{
            "datasetId": "dataset-users",
            "snapshotId": snapshots.pop(0),
            "schemaFingerprint": "users-schema",
        }]
        first = self.service.command(
            self.job.id,
            ContinuousSqlCommandRequest(command="start", commandId="refresh-start-1"),
            self.actor,
        )
        self.service.command(
            self.job.id,
            ContinuousSqlCommandRequest(command="stop", commandId="refresh-stop-1"),
            self.actor,
        )
        current = self.repository.get_job(self.job.id)
        current.desired_state = "stopped"
        current.observed_state = "stopped"
        self.db.add(current)
        self.db.commit()

        refreshed = self.service.command(
            self.job.id,
            ContinuousSqlCommandRequest(command="start", commandId="refresh-start-2"),
            self.actor,
        )

        self.assertEqual(first.job.active_run.static_bindings[0]["snapshotId"], "101")
        self.assertEqual(refreshed.job.generation, 2)
        self.assertEqual(refreshed.job.active_run.static_bindings[0]["snapshotId"], "102")

    def test_create_retry_is_idempotent_and_same_display_name_is_allowed(self) -> None:
        ETLJobModel.__table__.create(self.engine, checkfirst=True)
        catalog = CatalogRepository(self.db)
        common = {
            "description": "fixture",
            "downstream": [],
            "freshness": "latest",
            "lastUpdated": "2026-07-18T00:00:00Z",
            "layer": "BRONZE",
            "nextRefresh": "-",
            "owner": self.actor.name,
            "quality": "verified",
            "queryEngineStatus": "available",
            "rag": False,
            "rows": "2",
            "sampleRows": [],
            "size": "fixture",
            "source": "fixture",
            "status": "available",
            "storageFormat": "iceberg",
            "tags": [],
            "upstream": [],
        }
        catalog.save_dataset_payload({
            **common,
            "id": "retry-events",
            "name": "retry_events",
            "relationMode": "streaming",
            "schema": [["event_id", "bigint"], ["user_id", "bigint"]],
            "queryEngineTable": {
                "catalog": "iceberg", "schema": "asklake", "table": "retry_events", "format": "iceberg"
            },
            "streamingSource": {
                "broker": "redpanda:9092", "topic": "retry-events", "consumerGroupId": "retry-group"
            },
        })
        catalog.save_dataset_payload({
            **common,
            "id": "retry-users",
            "name": "retry_users",
            "relationMode": "static",
            "schema": [["id", "bigint"], ["name", "string"]],
            "schemaFingerprint": "retry-users-v1",
            "icebergSnapshotId": "101",
            "uniqueKeySets": [["id"]],
            "queryEngineTable": {
                "catalog": "iceberg", "schema": "asklake", "table": "retry_users", "format": "iceberg"
            },
        })

        def request(client_id: str, dataset_id: str, table: str):
            return ContinuousSqlCreateRequest.model_validate({
                "name": "same JOIN name",
                "query": (
                    "SELECT e.event_id, u.name AS user_name FROM retry_events e "
                    "LEFT JOIN retry_users u ON e.user_id = u.id"
                ),
                "relationDatasetIds": ["retry-events", "retry-users"],
                "clientRequestId": client_id,
                "output": {
                    "datasetId": dataset_id,
                    "datasetName": "same catalog display name",
                    "storagePath": f"s3a://lake/{table}",
                    "icebergTarget": {
                        "catalog": "iceberg",
                        "namespace": "asklake",
                        "table": table,
                        "writeMode": "append",
                    },
                },
            })

        first_request = request("same-name-request-1", "same-name-output-1", "same_name_one")
        first = self.service.create(first_request, self.actor)
        replay = self.service.create(first_request, self.actor)
        second = self.service.create(
            request("same-name-request-2", "same-name-output-2", "same_name_two"),
            self.actor,
        )

        self.assertEqual(replay.id, first.id)
        self.assertNotEqual(second.id, first.id)
        self.assertEqual(second.output_dataset_name, first.output_dataset_name)

    def test_stale_worker_report_is_rejected_by_generation_and_fence(self) -> None:
        started = self.service.command(
            self.job.id,
            ContinuousSqlCommandRequest(command="start", commandId="start-identity"),
            self.actor,
        )
        job = self.repository.get_job(self.job.id)
        run = self.repository.get_run(started.job.active_run_id)
        valid = {
            "continuousSqlPlanHash": job.plan_hash,
            "continuousSqlRunGeneration": run.generation,
            "continuousSqlFencingTokenHash": hashlib.sha256(run.fencing_token.encode()).hexdigest(),
        }
        self.assertIsNone(worker_identity_error(job, run, valid))
        self.assertEqual(
            worker_identity_error(job, run, {**valid, "continuousSqlRunGeneration": 0}),
            "CONTINUOUS_SQL_WORKER_GENERATION_STALE",
        )

    def test_publication_identity_binds_offsets_static_snapshots_plan_and_fence(self) -> None:
        started = self.service.command(
            self.job.id,
            ContinuousSqlCommandRequest(command="start", commandId="start-publication"),
            self.actor,
        )
        job = self.repository.get_job(self.job.id)
        run = self.repository.get_run(started.job.active_run_id)
        fence_hash = hashlib.sha256(run.fencing_token.encode()).hexdigest()
        source_ranges = [{"topic": "events", "partition": 0, "startOffset": 0, "endOffset": 2}]
        static_snapshots = [{"datasetId": "dataset-users", "snapshotId": "101"}]
        boundary = {
            "batchId": 0,
            "fencingTokenHash": fence_hash,
            "jobId": job.id,
            "kind": "continuous_sql_batch",
            "planHash": job.plan_hash,
            "runGeneration": run.generation,
            "runId": "continuous-sql:batch:0",
            "sourceRanges": source_ranges,
            "staticSnapshots": static_snapshots,
        }
        publication = {
            "batchId": 0,
            "continuousSqlFencingTokenHash": fence_hash,
            "continuousSqlPlanHash": job.plan_hash,
            "continuousSqlRunGeneration": run.generation,
            "icebergCommit": {"snapshotId": "500", "sourceBoundary": boundary},
            "manifestPath": "s3a://lake/output/_batch-manifests/batch_id=0",
            "publishedAt": "2026-07-16T00:00:00Z",
            "runId": boundary["runId"],
            "sourceBoundary": boundary,
            "sourceRanges": source_ranges,
            "staticSnapshots": static_snapshots,
            "storedCount": 2,
        }
        evidence = validate_publication_identity(job, run, publication)
        self.assertEqual(evidence["rowCount"], 2)
        with self.assertRaises(ContinuousSqlPublicationError):
            validate_publication_identity(job, run, {**publication, "continuousSqlRunGeneration": 999})

    def test_batch_identity_cannot_be_reused_with_different_row_count(self) -> None:
        started = self.service.command(
            self.job.id,
            ContinuousSqlCommandRequest(command="start", commandId="start-batch-identity"),
            self.actor,
        )
        run = self.repository.get_run(started.job.active_run_id)
        batch = ContinuousSqlBatchModel(
            id=f"{self.job.id}:{run.generation}:1",
            job_id=self.job.id,
            run_id=run.run_id,
            generation=run.generation,
            batch_id=1,
            stage="output_committed",
            plan_hash=self.job.plan_hash,
            input_offsets=[],
            static_snapshots=[],
            source_boundary={"boundaryId": "one"},
            output_commit_id="publication-one",
            row_count=2,
        )
        self.repository.stage_batch(batch)
        self.db.commit()

        conflicting = ContinuousSqlBatchModel(
            id=batch.id,
            job_id=batch.job_id,
            run_id=batch.run_id,
            generation=batch.generation,
            batch_id=batch.batch_id,
            stage=batch.stage,
            plan_hash=batch.plan_hash,
            input_offsets=[],
            static_snapshots=[],
            source_boundary={"boundaryId": "one"},
            output_commit_id="publication-one",
            row_count=3,
        )
        with self.assertRaisesRegex(ValueError, "different lineage evidence"):
            self.repository.stage_batch(conflicting)

    def test_publication_advances_once_after_exact_iceberg_verification(self) -> None:
        started = self.service.command(
            self.job.id,
            ContinuousSqlCommandRequest(command="start", commandId="start-publication-once"),
            self.actor,
        )
        job = self.repository.get_job(self.job.id)
        run = self.repository.get_run(started.job.active_run_id)
        fence_hash = hashlib.sha256(run.fencing_token.encode()).hexdigest()
        source_ranges = [{"topic": "events", "partition": 0, "startOffset": 0, "endOffset": 2}]
        static_snapshots = [{"datasetId": "dataset-users", "snapshotId": "101"}]
        boundary = {
            "batchId": 2,
            "fencingTokenHash": fence_hash,
            "jobId": job.id,
            "kind": "continuous_sql_batch",
            "planHash": job.plan_hash,
            "runGeneration": run.generation,
            "runId": "continuous-sql:batch:2",
            "sourceRanges": source_ranges,
            "staticSnapshots": static_snapshots,
        }
        publication = {
            "batchId": 2,
            "continuousSqlFencingTokenHash": fence_hash,
            "continuousSqlPlanHash": job.plan_hash,
            "continuousSqlRunGeneration": run.generation,
            "icebergCommit": {"snapshotId": "502", "sourceBoundary": boundary},
            "manifestPath": "s3a://lake/output/_batch-manifests/batch_id=2",
            "publishedAt": "2026-07-16T00:00:01Z",
            "runId": boundary["runId"],
            "sourceBoundary": boundary,
            "sourceRanges": source_ranges,
            "staticSnapshots": static_snapshots,
            "storedCount": 2,
        }
        writer = FakeIcebergWriter()
        publication_service = ContinuousSqlPublicationService(self.db, writer=writer)

        first = publication_service.reconcile_manifest(job, run, publication)
        second = publication_service.reconcile_manifest(job, run, publication)

        self.assertEqual(first.stage, "dashboard_ready")
        self.assertEqual(first.dataset_revision, 1)
        self.assertEqual(second.dataset_revision, 1)
        self.assertEqual(writer.verified_runs, [boundary["runId"]])
        payload = publication_service.catalog_repository.get_dataset_payload(job.output_dataset_id)
        self.assertEqual(len(payload["materializationRuns"]), 1)
        self.assertEqual(payload["sourceRunId"], boundary["runId"])


if __name__ == "__main__":
    unittest.main()
