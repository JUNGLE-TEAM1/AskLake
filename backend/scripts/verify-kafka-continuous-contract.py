import json
import os
import sys
import tempfile
from contextlib import nullcontext
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.models.etl import ETLJobModel, KafkaContinuousMaintenanceRunModel
from app.repositories import etl_repository
from app.schemas.catalog import DatasetMaterializationRun
from app.schemas.etl import CanonicalRuleDraft, ContinuousCompactionRequest, ContinuousIcebergMaintenanceRequest, ContinuousReplayRequest, CreatePipelineRequest, SchemaColumnDraft, UpdatePipelineRequest
from app.services import etl_service
from app.services.iceberg_writer_service import build_iceberg_writer_target
from scripts.kafka_schema_paths import build_nested_schema_tree, expected_object_keys, json_path, split_source_path


def continuous_request() -> CreatePipelineRequest:
    return CreatePipelineRequest(
        id="continuous-contract",
        job_name="reviews_continuous",
        source_type="Stream / Kafka",
        source_label="Kafka reviews.continuous",
        source_config=[
            ("Broker / Endpoint", "redpanda:9092"),
            ("TOPIC / QUEUE NAME", "reviews.continuous"),
            ("Consumer Group ID", "asklake-continuous-contract"),
        ],
        schema_columns=[SchemaColumnDraft(source_name="event_id", target_name="event_id", type="String")],
        rule_contract_version="1.0",
        rules=[CanonicalRuleDraft(
            id="event-id-required",
            input_columns=["event_id"],
            kind="quality",
            on_error="quarantine",
            operation="not_null",
            severity="error",
        )],
        schedule_label="수동",
        target_dataset="reviews_continuous",
        target_layer="BRONZE",
        target_format="parquet",
        storage_path="s3a://asklake-output/reviews_continuous/bronze",
        owner="data-team-01",
        execution_mode="continuous",
    )


def continuous_job() -> ETLJobModel:
    request = continuous_request()
    compiled = etl_service.compile_pipeline_rules(request)
    etl_service.require_compiled_rules(compiled)
    etl_service.apply_compiled_rules(request, compiled)
    dataset_id = "ds_reviews_continuous_contract"
    iceberg_target = build_iceberg_writer_target(
        request.target_dataset,
        dataset_id,
        write_mode="append",
    )
    return ETLJobModel(
        id="JOB-CONTINUOUS-CONTRACT",
        name=request.job_name,
        owner=request.owner,
        status="scheduled",
        tag="[생성]",
        source="Stream / Kafka / Kafka reviews.continuous",
        target=request.target_dataset,
        schedule=request.schedule_label,
        source_config=[list(item) for item in request.source_config],
        source_label=request.source_label,
        source_type=request.source_type,
        execution_mode="continuous",
        continuous_config=etl_service.continuous_config_from_request(request, "JOB-CONTINUOUS-CONTRACT"),
        dataset_id=dataset_id,
        iceberg_target=iceberg_target.model_dump(mode="json", by_alias=True),
        schema_columns=[column.model_dump(mode="json", by_alias=True) for column in request.schema_columns],
        schema_fingerprint="schema-continuous-contract-v1",
        schema_sample_rows=[],
        target_format=request.target_format,
        target_layer=request.target_layer,
        storage_path=request.storage_path,
        target_path=request.storage_path,
        transform_output_columns=[],
        transform_steps=[],
        quality_invalid_rows=[],
        quality_rules=[],
        rule_contract_version=request.rule_contract_version,
        rules=[rule.model_dump(mode="json", by_alias=True) for rule in request.rules],
        last_run="생성 후 미실행",
        last_state="준비됨",
        next_run="-",
        stats={},
        dag_steps=[],
    )


def main() -> None:
    assert split_source_path("raw.reviewerID") == ("raw", "reviewerID")
    assert build_nested_schema_tree([
        ("event_id", "string"),
        ("raw.reviewerID", "string"),
        ("raw.overall", "long"),
    ]) == {
        "event_id": "string",
        "raw": {"reviewerID": "string", "overall": "long"},
    }
    assert expected_object_keys(["event_id", "raw.reviewerID", "raw.overall"]) == {
        "": ["event_id", "raw"],
        "raw": ["reviewerID", "overall"],
    }
    assert json_path("raw.reviewerID") == "$.raw.reviewerID"
    assert json_path("raw.review-value") == "$.raw['review-value']"
    try:
        build_nested_schema_tree([("raw", "string"), ("raw.reviewerID", "string")])
    except ValueError:
        pass
    else:
        raise AssertionError("Scalar/object source path collisions must be rejected.")

    assert ContinuousReplayRequest(offsets=["01:002", "1:2"]).offsets == ["1:2"]
    assert ContinuousReplayRequest(approve_unknown_fields=True).model_dump(mode="json", by_alias=True)["approveUnknownFields"] is True
    try:
        ContinuousReplayRequest(offsets=["bad-offset"])
    except ValueError:
        pass
    else:
        raise AssertionError("Replay offsets must use partition:offset format.")

    request = continuous_request()
    config = etl_service.continuous_config_from_request(request, "JOB-CONTINUOUS-CONTRACT")
    assert config == {
        "initialOffsetPolicy": "earliest",
        "triggerIntervalSeconds": 30,
        "maxOffsetsPerTrigger": 10000,
        "schemaEvolutionPolicy": {
            "additiveNullable": "allow",
            "missingRequired": "quarantine",
            "incompatibleType": "quarantine",
            "unknownField": "preserve",
        },
        "checkpointPath": "s3a://asklake-output/reviews_continuous/bronze/_checkpoints/JOB-CONTINUOUS-CONTRACT",
    }

    assert ContinuousIcebergMaintenanceRequest().rewrite_data_files is True
    try:
        ContinuousIcebergMaintenanceRequest(
            rewrite_data_files=False,
            expire_snapshots=False,
            remove_orphan_files=False,
        )
    except ValueError:
        pass
    else:
        raise AssertionError("Iceberg maintenance must enable at least one operation.")

    job = continuous_job()
    dispatched = {}
    original_execute_maintenance = etl_service.execute_kafka_continuous_maintenance
    try:
        def capture_maintenance(_db, job_id, kind, config, _actor, access_action="run"):
            dispatched.update({
                "accessAction": access_action,
                "config": config,
                "jobId": job_id,
                "kind": kind,
            })
            return dispatched

        etl_service.execute_kafka_continuous_maintenance = capture_maintenance
        result = etl_service.compact_kafka_continuous_target(
            None,
            job.id,
            ContinuousCompactionRequest(target_file_size_mb=128),
            ActorContext(role="admin"),
        )
        assert result["kind"] == "compaction"
        assert result["config"] == {"targetFileSizeMb": 128}
        assert result["accessAction"] == "run"
        result = etl_service.maintain_kafka_continuous_iceberg_target(
            None,
            job.id,
            ContinuousIcebergMaintenanceRequest(
                rewrite_data_files=False,
                expire_snapshots=True,
                snapshot_retention_hours=48,
            ),
            ActorContext(role="admin"),
        )
        assert result["kind"] == "iceberg_maintenance"
        assert result["config"]["expireSnapshots"] is True
        assert result["accessAction"] == "manage"
    finally:
        etl_service.execute_kafka_continuous_maintenance = original_execute_maintenance
    runtime = etl_service.continuous_runtime_from_job(job)
    assert runtime.topic == "reviews.continuous"
    assert runtime.consumer_group_id == "asklake-continuous-contract"
    assert runtime.status == "stopped"
    runtime.lag = 4
    runtime.stored_count = 5
    runtime.metrics = {
        "lagAvailable": True,
        "maxPartitionLag": 4,
        "laggingPartitionCount": 1,
        "partitionProgress": {"0": {"processedOffset": 6, "latestOffset": 10, "lag": 4}},
        "lastBatchDurationMs": 2000,
        "lastBatchInputRows": 20,
        "throughputRowsPerSecond": 10.0,
        "replayedCount": 1,
        "ruleContractVersion": "1.0",
        "ruleFingerprint": "rule-v1",
        "runtimeFingerprint": "runtime-v1",
        "ruleMetrics": {"qualityQuarantinedCount": 2, "failedBatchCount": 0},
        "lastRuleResult": {"status": "success"},
    }
    runtime.schema_state = {
        "schemaVersion": 1,
        "schemaFingerprint": "schema-v1",
        "schemaStatus": "drift_detected",
        "schemaChanges": [{"kind": "additive_unknown", "field": "language"}],
    }
    runtime_schema = etl_repository.continuous_runtime_to_schema(runtime)
    assert runtime_schema is not None
    assert runtime_schema.max_partition_lag == 4
    assert runtime_schema.partition_progress["0"]["lag"] == 4
    assert runtime_schema.replayed_count == 1
    assert runtime_schema.schema_status == "drift_detected"
    assert runtime_schema.rule_fingerprint == "rule-v1"
    assert runtime_schema.rule_metrics["qualityQuarantinedCount"] == 2

    captured_worker_payload = {}
    original_node_bridge = etl_service.run_node_bridge
    try:
        etl_service.run_node_bridge = lambda _script, _marker, payload, **_kwargs: captured_worker_payload.update(payload) or {"containerState": "starting"}
        etl_service.run_kafka_continuous_worker(job, runtime, "start")
    finally:
        etl_service.run_node_bridge = original_node_bridge
    assert captured_worker_payload["ruleContractVersion"] == "1.0"
    assert captured_worker_payload["rules"][0]["operation"] == "not_null"
    assert captured_worker_payload["ruleOutputSchema"] == [("event_id", "String")]
    assert len(captured_worker_payload["ruleFingerprint"]) == 64

    update_request = UpdatePipelineRequest(
        job_name=job.name,
        owner=job.owner,
        rule_contract_version=job.rule_contract_version,
        rules=job.rules,
        schedule_label=job.schedule,
        schema_columns=job.schema_columns,
        storage_path=job.storage_path,
        target_dataset=job.target,
        target_format=job.target_format,
        target_layer=job.target_layer,
    )
    assert etl_service.continuous_processing_contract_changed(job, update_request) is False
    pass_through_update = update_request.model_copy(update={"rules": [], "rule_contract_version": "1.0"})
    assert etl_service.continuous_processing_contract_changed(job, pass_through_update) is True
    assert etl_service.continuous_checkpoint_initialized(runtime) is True

    original_get = etl_repository.get_kafka_continuous_runtime
    original_lock = etl_repository.lock_kafka_continuous_runtime
    original_job_get_for_update = etl_repository.get_job_for_update
    original_find = etl_repository.find_conflicting_kafka_continuous_runtime
    original_snapshot_find = etl_repository.find_conflicting_kafka_snapshot
    original_list_runs = etl_repository.list_runs_for_job
    original_save = etl_repository.save_kafka_continuous_command
    original_permissions = etl_service.with_job_permissions
    original_worker = etl_service.run_kafka_continuous_worker
    original_status = etl_service.continuous_worker_status
    original_dataset_get = etl_repository.get_dataset_by_id
    original_dataset_get_for_update = etl_repository.get_dataset_by_id_for_update
    original_live_repository = etl_service.DashboardLiveRepository
    original_catalog_revision_save = etl_service.save_catalog_dataset_and_revision
    original_catalog_revision_backfill = etl_service.backfill_catalog_revision
    original_publication_storage_verify = etl_service.verify_continuous_publication_storage
    original_maintenance_list = etl_repository.list_kafka_continuous_maintenance_run_models
    original_failed_replay_list = etl_repository.list_failed_kafka_continuous_replay_models
    original_maintenance_save = etl_repository.save_kafka_continuous_maintenance_run
    original_maintenance_cleanup = etl_service.cleanup_kafka_continuous_maintenance
    original_session_sync = etl_service.sync_kafka_continuous_session
    original_session_stage = etl_repository.stage_kafka_continuous_session
    original_session_get = etl_repository.get_kafka_continuous_session
    original_active_session_get = etl_repository.get_latest_active_kafka_continuous_session
    original_batch_stage = etl_repository.stage_kafka_continuous_batch
    try:
        etl_repository.get_kafka_continuous_runtime = lambda _db, _job_id: runtime
        etl_repository.get_job_for_update = lambda _db, _job_id: job
        etl_service.verify_continuous_publication_storage = (
            lambda _data_path, _manifest_path, **_kwargs: None
        )
        etl_repository.lock_kafka_continuous_runtime = lambda _db, _job_id: runtime
        etl_repository.find_conflicting_kafka_continuous_runtime = lambda _db, **_kwargs: None
        etl_repository.find_conflicting_kafka_snapshot = lambda _db, **_kwargs: None
        etl_repository.list_runs_for_job = lambda _db, _job_id: []
        etl_repository.save_kafka_continuous_command = lambda _db, saved_job, _runtime: etl_repository.job_to_schema(None, saved_job)
        etl_service.with_job_permissions = lambda _db, job_schema, _actor: job_schema
        etl_service.run_kafka_continuous_worker = lambda _job, _runtime, action: {"action": action, "containerState": "starting"}

        response = etl_service.command_kafka_continuous_job(None, job, "startContinuous", ActorContext())
        assert response.action == "etl.continuous.start_requested"
        assert response.processing_result["controlPlaneOnly"] is False
        assert response.processing_result["runtimeStatus"] == "starting"
        assert response.processing_result["worker"] == "spark_structured_streaming"
        assert job.status == "running"
        assert runtime.status == "starting"

        try:
            etl_service.command_kafka_continuous_job(None, job, "startContinuous", ActorContext())
        except ApiError as exc:
            assert exc.status_code == 409
        else:
            raise AssertionError("Starting an active continuous Job must conflict.")

        runtime.status = "stopped"
        job.status = "stopped"
        etl_repository.find_conflicting_kafka_snapshot = lambda _db, **_kwargs: type("Snapshot", (), {"job_id": "JOB-SNAPSHOT", "snapshot_id": "snapshot-conflict"})()
        try:
            etl_service.command_kafka_continuous_job(None, job, "startContinuous", ActorContext())
        except ApiError as exc:
            assert exc.status_code == 409
            assert exc.details["activeSnapshotId"] == "snapshot-conflict"
        else:
            raise AssertionError("Starting against an active Snapshot must conflict.")

        etl_repository.find_conflicting_kafka_continuous_runtime = lambda _db, **_kwargs: runtime
        try:
            etl_service.kafka_request_with_durable_snapshot(None, {
                "broker": runtime.broker,
                "consumerGroupId": runtime.consumer_group_id,
                "timeoutMs": 1000,
                "topic": runtime.topic,
            }, "JOB-SNAPSHOT")
        except ApiError as exc:
            assert exc.status_code == 409
            assert exc.details["activeJobId"] == runtime.job_id
        else:
            raise AssertionError("Starting a Snapshot against an active Continuous worker must conflict.")
        etl_repository.find_conflicting_kafka_continuous_runtime = lambda _db, **_kwargs: None
        etl_repository.find_conflicting_kafka_snapshot = lambda _db, **_kwargs: None

        stored_sessions = {}
        stored_batches = {}
        etl_repository.stage_kafka_continuous_session = lambda _db, session: stored_sessions.setdefault(session.session_id, session)
        etl_repository.get_kafka_continuous_session = lambda _db, session_id: stored_sessions.get(session_id)
        etl_repository.get_latest_active_kafka_continuous_session = lambda _db, _job_id: next(
            (session for session in reversed(list(stored_sessions.values())) if session.status in {"starting", "running", "stopping"}),
            None,
        )
        etl_repository.stage_kafka_continuous_batch = lambda _db, batch: stored_batches.setdefault(batch.id, batch)
        etl_service.run_kafka_continuous_worker = lambda _job, _runtime, action: {
            "action": action,
            "containerState": "starting",
            "workerAttemptId": f"attempt-{len(stored_sessions) + 1}",
        }
        fake_db = type("FakeSession", (), {
            "add": lambda _self, _model: None,
            "commit": lambda _self: None,
            "no_autoflush": property(lambda _self: nullcontext()),
            "rollback": lambda _self: None,
        })()
        runtime.status = "stopped"
        runtime.consumed_count = 10
        runtime.stored_count = 8
        runtime.quarantined_count = 2
        runtime.failed_count = 0
        runtime.last_batch_id = "4"
        session_start = etl_service.command_kafka_continuous_job(fake_db, job, "startContinuous", ActorContext())
        assert session_start.processing_result["runtimeStatus"] == "starting"
        assert len(stored_sessions) == 1
        first_session = next(iter(stored_sessions.values()))
        assert first_session.status == "starting"
        assert first_session.baseline_counts["storedCount"] == 8
        runtime.status = "running"
        runtime.consumed_count = 15
        runtime.stored_count = 13
        runtime.quarantined_count = 2
        runtime.last_batch_id = "5"
        runtime.last_flush_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        runtime.metrics = {**(runtime.metrics or {}), "catalogBatchCursor": 5, "lastBatchDurationMs": 1200}
        session_payload = {
            "workerAttemptId": first_session.worker_attempt_id,
            "lastBatchId": "5",
            "publishedBatches": [{
                "batchId": 5,
                "consumedCount": 5,
                "storedCount": 5,
                "quarantinedCount": 0,
                "publishedAt": runtime.last_flush_at,
                "sourceRanges": [{"topic": runtime.topic, "partition": 0, "startOffset": 10, "endOffset": 15}],
            }],
        }
        etl_service.sync_kafka_continuous_session(fake_db, runtime, session_payload)
        etl_service.sync_kafka_continuous_session(fake_db, runtime, session_payload)
        assert first_session.status == "running"
        assert first_session.consumed_count == 5
        assert first_session.stored_count == 5
        assert len(stored_batches) == 1, "Repeated worker reports must not duplicate session batch history."
        stored_batch = next(iter(stored_batches.values()))
        assert stored_batch.status == "success"
        assert len(stored_batch.dag_steps) == 7
        assert next(step for step in stored_batch.dag_steps if step["id"] == "catalog")["status"] == "success"
        assert len(first_session.dag_steps) == 7
        assert next(step for step in first_session.dag_steps if step["id"] == "source")["status"] == "running"
        failed_steps = etl_service.continuous_batch_dag_steps({
            "batchId": 6,
            "consumedCount": 5,
            "failedStage": "quality",
            "lastError": "quality rule failed",
        }, status="failed", catalog_applied=False)
        assert next(step for step in failed_steps if step["id"] == "transform")["status"] == "success"
        assert next(step for step in failed_steps if step["id"] == "quality")["status"] == "failed"
        assert next(step for step in failed_steps if step["id"] == "target")["status"] == "blocked"
        etl_service.sync_kafka_continuous_batches(fake_db, runtime, first_session, {
            "lastBatchEvidence": {
                "batchId": 6,
                "status": "failed",
                "consumedCount": 5,
                "lastError": "quality rule failed",
                "dagSteps": failed_steps,
            },
        })
        failed_batch = stored_batches[f"{first_session.session_id}:6"]
        assert failed_batch.status == "failed"
        assert failed_batch.last_error == "quality rule failed"
        assert next(step for step in failed_batch.dag_steps if step["id"] == "quality")["status"] == "failed"
        etl_service.mark_kafka_continuous_session_stopping(fake_db, runtime, "stopped")
        runtime.status = "stopped"
        etl_service.sync_kafka_continuous_session(fake_db, runtime)
        assert first_session.status == "stopped"
        assert first_session.ended_at
        runtime.stored_count += 1
        etl_service.sync_kafka_continuous_session(fake_db, runtime)
        assert first_session.stored_count == 5, "Maintenance counters must not mutate a terminal stream session."
        runtime.stored_count -= 1
        runtime.status = "stopped"
        etl_service.command_kafka_continuous_job(fake_db, job, "resumeContinuous", ActorContext())
        assert len(stored_sessions) == 2
        second_session = list(stored_sessions.values())[-1]
        assert second_session.session_id != first_session.session_id
        assert second_session.baseline_counts["storedCount"] == 13
        runtime.metrics = {
            **(runtime.metrics or {}),
            "lastBatchEvidence": {
                "batchId": 5,
                "status": "success",
                "consumedCount": 5,
                "storedCount": 5,
            },
        }
        runtime.status = "running"
        etl_service.sync_kafka_continuous_session(fake_db, runtime)
        assert next(step for step in second_session.dag_steps if step["id"] == "schema")["status"] == "pending", "A new idle session must not inherit the previous session's last batch DAG."
        runtime.status = "failed"
        runtime.failed_count = 1
        runtime.last_error = "worker crashed"
        etl_service.sync_kafka_continuous_session(fake_db, runtime)
        assert second_session.status == "failed"
        assert second_session.failed_count == 1
        assert second_session.end_reason == "worker_failed"
        runtime.status = "stopped"
        runtime.lag = 4
        runtime.consumed_count = 0
        runtime.stored_count = 5
        runtime.quarantined_count = 0
        runtime.failed_count = 0
        runtime.last_batch_id = None
        runtime.last_flush_at = None
        runtime.last_error = None
        runtime.metrics = {
            "lagAvailable": True,
            "maxPartitionLag": 4,
            "laggingPartitionCount": 1,
            "partitionProgress": {"0": {"processedOffset": 6, "latestOffset": 10, "lag": 4}},
            "lastBatchDurationMs": 2000,
            "lastBatchInputRows": 20,
            "throughputRowsPerSecond": 10.0,
            "replayedCount": 1,
        }

        captured_dataset = {}
        dataset_save_count = {"value": 0}
        revision_commits = {}
        latest_revision_by_dataset = {}
        stream_progress_ranges = []
        revision_backfill_count = {"value": 0}
        etl_repository.get_dataset_by_id = lambda _db, dataset_id: captured_dataset.get(dataset_id)
        etl_repository.get_dataset_by_id_for_update = lambda _db, dataset_id: captured_dataset.get(dataset_id)
        compiled_job_rules = etl_service.compile_job_rules(job)
        canonical_job_rules = [rule.model_dump(mode="json", by_alias=True) for rule in compiled_job_rules.result.rules]
        persisted_rule_fingerprint = etl_service.canonical_rule_fingerprint(
            compiled_job_rules.result.contract_version,
            canonical_job_rules,
        )

        def iceberg_publication(batch_id, stored_count, source_ranges):
            run_id = f"continuous:{job.id}:batch:{batch_id}:contract"
            source_boundary = {
                "batchId": batch_id,
                "boundaryId": f"boundary-{batch_id}",
                "checkpointPath": runtime.checkpoint_path,
                "consumerGroupId": runtime.consumer_group_id,
                "jobId": job.id,
                "kind": "kafka_continuous_batch",
                "runId": run_id,
                "sourceRanges": source_ranges,
                "topic": runtime.topic,
            }
            commit = {
                "committedAt": "2026-07-14T00:00:00Z",
                "createdTable": batch_id == 0,
                "jobId": job.id,
                "operation": "append",
                "ruleFingerprint": persisted_rule_fingerprint,
                "runId": run_id,
                "schemaFingerprint": job.schema_fingerprint,
                "snapshotId": str(1000 + batch_id),
                "sourceBoundary": source_boundary,
                "target": job.iceberg_target,
                "warehouseLocation": "s3://asklake-warehouse/warehouse/asklake/reviews_continuous",
            }
            return {
                "batchId": batch_id,
                "dataPath": job.iceberg_target["tableUri"],
                "icebergCommit": commit,
                "manifestPath": f"{job.storage_path.rstrip('/')}/_batch-manifests/batch_id={batch_id}",
                "publishedAt": "2026-07-14T00:00:00Z",
                "ruleContractVersion": compiled_job_rules.result.contract_version,
                "ruleFingerprint": persisted_rule_fingerprint,
                "runId": run_id,
                "schemaFingerprint": job.schema_fingerprint,
                "sourceBoundary": source_boundary,
                "sourceRanges": source_ranges,
                "storedCount": stored_count,
            }

        etl_service.verify_spark_iceberg_result = lambda _job, _run_id, result, **_kwargs: {
            **result,
            "dataFileCount": 1,
            "materializationOutputPath": "s3://asklake-warehouse/warehouse/asklake/reviews_continuous",
            "queryEngineTable": {
                "catalog": job.iceberg_target["catalog"],
                "schema": job.iceberg_target["namespace"],
                "table": job.iceberg_target["table"],
                "format": "iceberg",
                "partitionColumns": [],
            },
            "queryEngineVerified": True,
            "storageSizeBytes": 1024,
            "warehouseLocation": "s3://asklake-warehouse/warehouse/asklake/reviews_continuous",
        }
        def capture_revision(dataset_id, run_id, **metadata):
            existing_commit = revision_commits.get(run_id)
            if existing_commit is not None:
                return existing_commit
            revision = latest_revision_by_dataset.get(dataset_id, 0) + 1
            latest_revision_by_dataset[dataset_id] = revision
            commit = {
                "datasetId": dataset_id,
                "revision": revision,
                "runId": run_id,
                **metadata,
            }
            revision_commits[run_id] = commit
            return commit

        def capture_dataset(_db, dataset, *, run_id, **metadata):
            captured_dataset[dataset.id] = dataset
            dataset_save_count["value"] += 1
            return capture_revision(dataset.id, run_id, **metadata)

        def capture_revision_backfill(_db, *, dataset_id, run_id, **metadata):
            if run_id not in revision_commits:
                revision_backfill_count["value"] += 1
            return capture_revision(dataset_id, run_id, **metadata)

        class FakeDashboardLiveRepository:
            def __init__(self, _db, *, ensure_schema=True):
                self.ensure_schema = ensure_schema

            def commit_by_run_id(self, run_id):
                return revision_commits.get(run_id)

            def lock_dataset_publication_identity(self, _dataset_id):
                return None

            def record_stream_progress(self, _dataset_id, source_ranges):
                stream_progress_ranges.append(source_ranges)
                return True

            def record_dataset_commit(self, *, run_id, source_ranges=None, **_metadata):
                existing_commit = revision_commits.get(run_id)
                if existing_commit is None:
                    raise AssertionError("Expected an existing revision commit")
                if existing_commit.get("source_ranges") != source_ranges:
                    raise ValueError("Dataset revision run_id was reused with different publication metadata")
                return existing_commit, False

        etl_service.DashboardLiveRepository = FakeDashboardLiveRepository
        etl_service.save_catalog_dataset_and_revision = capture_dataset
        etl_service.backfill_catalog_revision = capture_revision_backfill
        runtime_relock_count = {"value": 0}
        runtime.metrics = {**(runtime.metrics or {}), "concurrentMarker": "stale"}
        def count_runtime_relock(_db, _job_id):
            runtime_relock_count["value"] += 1
            runtime.metrics = {
                **(runtime.metrics or {}),
                "catalogBatchCursor": 9,
                "concurrentMarker": "latest",
            }
            return runtime
        etl_repository.lock_kafka_continuous_runtime = count_runtime_relock
        first_cursor = etl_service.materialize_continuous_batch(fake_db, job, runtime, {
            "publishedBatches": [iceberg_publication(0, 2, [
                {"topic": "reviews.continuous", "partition": 0, "startOffset": 0, "endOffset": 2},
            ])],
        })
        assert first_cursor == 9, "A concurrent persisted Catalog cursor must not regress."
        assert runtime_relock_count["value"] == 1, "Catalog commit boundaries must reacquire the runtime lock."
        assert runtime.metrics["concurrentMarker"] == "latest", "Reacquired runtime metrics must win over a stale local copy."
        assert runtime.metrics["catalogBatchCursor"] == 9, "Catalog cursor must not regress after a concurrent reconciliation."
        runtime.metrics.pop("concurrentMarker", None)
        runtime.metrics.pop("catalogBatchCursor", None)
        etl_repository.lock_kafka_continuous_runtime = lambda _db, _job_id: runtime
        dataset_id = job.dataset_id
        assert captured_dataset[dataset_id].payload["materializationRuns"][0]["sourceKind"] == "kafka"
        assert captured_dataset[dataset_id].payload["materializationRuns"][0]["materializationMode"] == "snapshot"
        assert captured_dataset[dataset_id].payload["materializationRuns"][0]["rowCount"] == 2
        assert captured_dataset[dataset_id].payload["storageLocation"].startswith("s3://asklake-warehouse/")

        first_publication = iceberg_publication(0, 2, [
            {"topic": "reviews.continuous", "partition": 0, "startOffset": 0, "endOffset": 2},
        ])
        first_run_id = first_publication["runId"]
        assert revision_commits[first_run_id]["revision"] == 1
        assert latest_revision_by_dataset[dataset_id] == 1

        assert etl_service.materialize_continuous_publication(fake_db, job, runtime, first_publication) is True
        assert latest_revision_by_dataset[dataset_id] == 1, "The same Iceberg publication must not advance dataset revision twice."
        assert len(revision_commits) == 1
        assert revision_backfill_count["value"] == 0

        conflicting_ranges = [
            {"topic": "reviews.continuous", "partition": 0, "startOffset": 0, "endOffset": 3},
        ]
        conflicting_boundary = {
            **first_publication["sourceBoundary"],
            "sourceRanges": conflicting_ranges,
        }
        conflicting_publication = {
            **first_publication,
            "icebergCommit": {
                **first_publication["icebergCommit"],
                "sourceBoundary": conflicting_boundary,
            },
            "sourceBoundary": conflicting_boundary,
            "sourceRanges": conflicting_ranges,
        }
        assert etl_service.materialize_continuous_publication(
            fake_db,
            job,
            runtime,
            conflicting_publication,
        ) is False
        assert latest_revision_by_dataset[dataset_id] == 1, "Conflicting evidence for an existing run must not be acknowledged."
        assert len(revision_commits) == 1

        missing_manifest_publication = iceberg_publication(6, 2, [
            {"topic": "reviews.continuous", "partition": 0, "startOffset": 20, "endOffset": 22},
        ])
        missing_manifest_publication.pop("manifestPath")
        assert etl_service.materialize_continuous_publication(
            fake_db,
            job,
            runtime,
            missing_manifest_publication,
        ) is False
        assert latest_revision_by_dataset[dataset_id] == 1, "An Iceberg commit without its committed publication manifest must not advance revision."
        assert len(revision_commits) == 1

        wrong_manifest_publication = iceberg_publication(7, 2, [
            {"topic": "reviews.continuous", "partition": 0, "startOffset": 22, "endOffset": 24},
        ])
        wrong_manifest_publication["manifestPath"] = (
            f"{job.storage_path.rstrip('/')}/_batch-manifests/batch_id=999"
        )
        assert etl_service.materialize_continuous_publication(
            fake_db,
            job,
            runtime,
            wrong_manifest_publication,
        ) is False
        assert latest_revision_by_dataset[dataset_id] == 1, "A manifest from another batch must not advance revision."
        assert len(revision_commits) == 1

        zero_row_publication = iceberg_publication(1, 0, [
            {"topic": "reviews.continuous", "partition": 0, "startOffset": 2, "endOffset": 4},
        ])
        assert etl_service.materialize_continuous_publication(fake_db, job, runtime, zero_row_publication) is True
        assert latest_revision_by_dataset[dataset_id] == 1, "A zero-row publication must not change dashboard-visible freshness."
        assert len(revision_commits) == 1
        assert stream_progress_ranges == [[
            {"topic": "reviews.continuous", "partition": 0, "startOffset": 2, "endOffset": 4},
        ]], "A zero-row publication must still advance its durable Kafka watermark."

        legacy_publication = iceberg_publication(7, 3, [
            {"topic": "reviews.continuous", "partition": 0, "startOffset": 24, "endOffset": 27},
        ])
        legacy_run_id = legacy_publication["runId"]
        legacy_run = {
            **captured_dataset[dataset_id].payload["materializationRuns"][0],
            "createdAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "materializationMode": "delta",
            "rowCount": 3,
            "runId": legacy_run_id,
            "sourceBoundary": legacy_publication["sourceBoundary"],
            "sourceRanges": legacy_publication["sourceRanges"],
        }
        captured_dataset[dataset_id].payload["materializationRuns"] = [
            legacy_run,
            *captured_dataset[dataset_id].payload["materializationRuns"],
        ]
        assert etl_service.materialize_continuous_publication(fake_db, job, runtime, legacy_publication) is True
        assert revision_commits[legacy_run_id]["revision"] == 2
        assert revision_commits[legacy_run_id]["materialization_mode"] == "snapshot", (
            "A legacy Catalog run must force a full dashboard rebaseline instead of being added twice."
        )
        assert latest_revision_by_dataset[dataset_id] == 2
        assert revision_backfill_count["value"] == 1
        assert etl_service.materialize_continuous_publication(fake_db, job, runtime, legacy_publication) is True
        assert latest_revision_by_dataset[dataset_id] == 2, "A legacy Catalog run must be backfilled exactly once."
        assert revision_backfill_count["value"] == 1

        replay_run_id = "continuous-maint-replay-contract"
        replay_ranges = [
            {"topic": runtime.topic, "partition": 0, "startOffset": 4, "endOffset": 5},
        ]
        replay_boundary = {
            "boundaryId": "replay-boundary-contract",
            "jobId": job.id,
            "kind": "kafka_continuous_replay",
            "runId": replay_run_id,
            "sourceRanges": replay_ranges,
        }
        replay_result = {
            "endedAt": "2026-07-14T00:05:00Z",
            "icebergCommit": {
                "committedAt": "2026-07-14T00:05:00Z",
                "createdTable": False,
                "jobId": job.id,
                "operation": "append",
                "ruleFingerprint": persisted_rule_fingerprint,
                "runId": replay_run_id,
                "schemaFingerprint": job.schema_fingerprint,
                "snapshotId": "2001",
                "sourceBoundary": replay_boundary,
                "target": job.iceberg_target,
                "warehouseLocation": "s3://asklake-warehouse/warehouse/asklake/reviews_continuous",
            },
            "outputPath": job.iceberg_target["tableUri"],
            "manifestPath": f"{job.storage_path.rstrip('/')}/_replay-manifests/run_id={replay_run_id}",
            "ruleContractVersion": compiled_job_rules.result.contract_version,
            "ruleFingerprint": persisted_rule_fingerprint,
            "runId": replay_run_id,
            "sourceBoundary": replay_boundary,
            "sourceRanges": replay_ranges,
            "storedCount": 1,
        }
        before_replay_saves = dataset_save_count["value"]
        assert etl_service.materialize_continuous_replay(fake_db, job, runtime, replay_result) is True
        replay_materialization = captured_dataset[dataset_id].payload["materializationRuns"][0]
        assert replay_materialization["runId"] == replay_run_id
        assert replay_materialization["materializationMode"] == "delta"
        assert replay_materialization["sourceBoundary"]["kind"] == "kafka_continuous_replay"
        assert dataset_save_count["value"] == before_replay_saves + 1, (
            dataset_save_count["value"],
            before_replay_saves,
            runtime.last_error,
        )
        assert revision_commits[replay_run_id]["revision"] == 3
        assert latest_revision_by_dataset[dataset_id] == 3
        assert etl_service.materialize_continuous_replay(fake_db, job, runtime, replay_result) is True
        assert latest_revision_by_dataset[dataset_id] == 3, "The same replay run must not advance dataset revision twice."
        after_idempotent_replay_saves = dataset_save_count["value"]

        invalid_replay = {
            **replay_result,
            "runId": "continuous-maint-invalid-replay",
            "sourceBoundary": {**replay_boundary, "jobId": "WRONG-JOB"},
        }
        assert etl_service.materialize_continuous_replay(fake_db, job, runtime, invalid_replay) is False
        assert dataset_save_count["value"] == after_idempotent_replay_saves
        assert runtime.last_error.startswith("Replay Catalog materialization pending retry:")
        runtime.last_error = None

        pending_replay_run_id = "continuous-replay-pending-contract"
        pending_replay_ranges = [
            {"topic": runtime.topic, "partition": 0, "startOffset": 5, "endOffset": 6},
        ]
        pending_replay_boundary = {
            "boundaryId": "replay-boundary-pending-contract",
            "jobId": job.id,
            "kind": "kafka_continuous_replay",
            "runId": pending_replay_run_id,
            "sourceRanges": pending_replay_ranges,
        }
        pending_replay_result = {
            "catalogApplied": False,
            "endedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "icebergCommit": {
                **replay_result["icebergCommit"],
                "runId": pending_replay_run_id,
                "snapshotId": "2002",
                "sourceBoundary": pending_replay_boundary,
            },
            "outputPath": job.iceberg_target["tableUri"],
            "manifestPath": f"{job.storage_path.rstrip('/')}/_replay-manifests/run_id={pending_replay_run_id}",
            "ruleContractVersion": compiled_job_rules.result.contract_version,
            "ruleFingerprint": persisted_rule_fingerprint,
            "runId": pending_replay_run_id,
            "sourceBoundary": pending_replay_boundary,
            "sourceRanges": pending_replay_ranges,
            "storedCount": 1,
        }
        failed_replay_run = KafkaContinuousMaintenanceRunModel(
            run_id=pending_replay_run_id,
            job_id=job.id,
            kind="quarantine_replay",
            status="failed",
            requested_by="contract-test",
            config={},
            result=pending_replay_result,
            last_error="temporary PostgreSQL failure",
        )
        stored_count_before_recovery = int(runtime.stored_count or 0)
        replayed_count_before_recovery = int((runtime.metrics or {}).get("replayedCount") or 0)
        saved_replay_runs = []
        original_fake_add = fake_db.add
        fake_db.add = lambda run: saved_replay_runs.append(run)
        etl_repository.list_kafka_continuous_maintenance_run_models = (
            lambda _db, _job_id=None, active_only=False: [failed_replay_run]
        )
        etl_service.reconcile_pending_continuous_replay_catalog(fake_db, job)
        fake_db.add = original_fake_add
        assert revision_commits[pending_replay_run_id]["revision"] == 4
        assert latest_revision_by_dataset[dataset_id] == 4
        assert failed_replay_run.status == "success"
        assert failed_replay_run.result["catalogApplied"] is True
        assert failed_replay_run.result["countersApplied"] is True
        assert failed_replay_run.last_error is None
        assert runtime.stored_count == stored_count_before_recovery + 1
        assert runtime.metrics["replayedCount"] == replayed_count_before_recovery + 1
        assert saved_replay_runs == [failed_replay_run]
        catalog_head_before_late_recovery = captured_dataset[dataset_id].payload[
            "materializationRuns"
        ][0]["runId"]
        runtime.stored_count = stored_count_before_recovery
        runtime.metrics = {
            **(runtime.metrics or {}),
            "replayedCount": replayed_count_before_recovery,
        }

        with tempfile.TemporaryDirectory() as report_dir:
            previous_report_dir = os.environ.get("ASKLAKE_SPARK_REPORT_DIR")
            os.environ["ASKLAKE_SPARK_REPORT_DIR"] = report_dir
            report_path = etl_service.continuous_runtime_report_path(job.id)
            report_path.write_text(json.dumps({
                "status": "running",
                "heartbeatAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                "consumedCount": 2,
                "storedCount": 2,
                "quarantinedCount": 0,
                "failedCount": 0,
            }), encoding="utf-8")
            runtime.status = "pausing"
            runtime.failed_count = 0
            etl_service.continuous_worker_status = lambda _job, _runtime: {"containerState": "exited", "containerId": "attempt-graceful", "exitCode": 143}
            etl_service.refresh_kafka_continuous_runtime(None, job)
            assert runtime.status == "paused"
            assert runtime.failed_count == 0

            runtime.status = "stopping"
            etl_service.refresh_kafka_continuous_runtime(None, job)
            assert runtime.status == "stopped"

            runtime.status = "running"
            job.status = "running"
            heartbeat = (datetime.now(UTC) - timedelta(minutes=10)).isoformat().replace("+00:00", "Z")
            report_path.write_text(json.dumps({
                "status": "running",
                "heartbeatAt": heartbeat,
                "consumedCount": 2,
                "storedCount": 2,
                "quarantinedCount": 0,
                "failedCount": 0,
            }), encoding="utf-8")
            etl_service.continuous_worker_status = lambda _job, _runtime: {"containerState": "running", "containerId": "attempt-stale"}
            etl_service.refresh_kafka_continuous_runtime(None, job)
            assert runtime.status == "failed"
            assert "heartbeat expired" in runtime.last_error
            assert runtime.failed_count == 1
            etl_service.refresh_kafka_continuous_runtime(None, job)
            assert runtime.status == "failed"
            assert runtime.failed_count == 1, "Repeated refresh of the same worker attempt must be idempotent."
            assert runtime.lag == 4
            assert runtime.metrics["partitionProgress"]["0"]["lag"] == 4
            assert runtime.stored_count == 5
            assert runtime.metrics["replayedCount"] == 1

            report_path.write_text(json.dumps({
                "status": "running",
                "heartbeatAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                "consumedCount": 7,
                "storedCount": 6,
                "quarantinedCount": 1,
                "failedCount": 1,
                "ruleContractVersion": "1.0",
                "ruleFingerprint": persisted_rule_fingerprint,
                "runtimeFingerprint": "runtime-v2",
                "ruleMetrics": {"qualityQuarantinedCount": 1, "qualityWarnCount": 2},
                "lastRuleResult": {"status": "success", "quality": {"invalidRowCount": 3}},
                "publishedBatches": [{
                    **iceberg_publication(8, 1, [{"topic": "reviews.continuous", "partition": 0, "startOffset": 6, "endOffset": 8}]),
                    "consumedCount": 2,
                    "quarantinedCount": 1,
                    "dataPath": job.iceberg_target["tableUri"],
                    "manifestPath": "s3a://asklake-output/reviews_continuous/bronze/_batch-manifests/batch_id=8",
                    "runtimeFingerprint": "runtime-v2",
                    "quality": {"invalidRowCount": 1},
                    "transform": {"warnCount": 0},
                    "publishedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                }],
            }), encoding="utf-8")
            runtime.status = "running"
            etl_service.continuous_worker_status = lambda _job, _runtime: {"containerState": "exited", "containerId": "attempt-crashed", "exitCode": 137}
            before_recovery_saves = dataset_save_count["value"]
            session_sync_count = {"value": 0}
            def count_session_sync(*args, **kwargs):
                session_sync_count["value"] += 1
                return original_session_sync(*args, **kwargs)
            etl_service.sync_kafka_continuous_session = count_session_sync
            etl_service.refresh_kafka_continuous_runtime(None, job)
            assert session_sync_count["value"] == 1, "A runtime report must stage session batches exactly once per refresh."
            etl_service.sync_kafka_continuous_session = original_session_sync
            recovered_run_id = iceberg_publication(8, 1, [
                {"topic": "reviews.continuous", "partition": 0, "startOffset": 6, "endOffset": 8},
            ])["runId"]
            recovered_runs = captured_dataset[dataset_id].payload["materializationRuns"]
            recovered_run = next(run for run in recovered_runs if run["runId"] == recovered_run_id)
            assert recovered_runs[0]["runId"] == catalog_head_before_late_recovery, (
                "Late historical recovery must not replace the current Catalog head."
            )
            assert recovered_run["materializationMode"] == "delta"
            assert recovered_run["sourceRanges"][0]["endOffset"] == 8
            assert recovered_run["ruleFingerprint"] == persisted_rule_fingerprint
            assert recovered_run["quality"]["invalidRowCount"] == 1
            serialized_run = DatasetMaterializationRun.model_validate(recovered_run).model_dump(mode="json", by_alias=True)
            assert serialized_run["ruleFingerprint"] == persisted_rule_fingerprint
            assert serialized_run["runtimeFingerprint"] == "runtime-v2"
            assert serialized_run["sourceRanges"][0]["endOffset"] == 8
            assert runtime.metrics["ruleFingerprint"] == persisted_rule_fingerprint
            assert runtime.metrics["ruleMetrics"]["qualityWarnCount"] == 2
            assert dataset_save_count["value"] == before_recovery_saves + 1
            etl_service.refresh_kafka_continuous_runtime(None, job)
            assert dataset_save_count["value"] == before_recovery_saves + 1, "Catalog recovery must be idempotent."
            if previous_report_dir is None:
                os.environ.pop("ASKLAKE_SPARK_REPORT_DIR", None)
            else:
                os.environ["ASKLAKE_SPARK_REPORT_DIR"] = previous_report_dir

        stale_run = KafkaContinuousMaintenanceRunModel(
            run_id="maintenance-stale",
            job_id=job.id,
            kind="compaction",
            status="running",
            requested_by="contract",
            config={"leaseExpiresAt": (datetime.now(UTC) - timedelta(minutes=1)).isoformat().replace("+00:00", "Z")},
            started_at=(datetime.now(UTC) - timedelta(minutes=20)).isoformat().replace("+00:00", "Z"),
        )
        saved_maintenance = []
        etl_repository.list_kafka_continuous_maintenance_run_models = lambda _db, _job_id=None, active_only=False: [stale_run] if active_only else []
        etl_repository.save_kafka_continuous_maintenance_run = lambda _db, run: saved_maintenance.append(run) or run
        etl_service.cleanup_kafka_continuous_maintenance = lambda _run_id: {"cleaned": True}
        etl_service.reconcile_stale_continuous_maintenance_runs(None, job.id)
        assert stale_run.status == "failed"
        assert stale_run.result["leaseExpired"] is True
        assert saved_maintenance == [stale_run]
    finally:
        etl_repository.get_kafka_continuous_runtime = original_get
        etl_repository.lock_kafka_continuous_runtime = original_lock
        etl_repository.get_job_for_update = original_job_get_for_update
        etl_repository.find_conflicting_kafka_continuous_runtime = original_find
        etl_repository.find_conflicting_kafka_snapshot = original_snapshot_find
        etl_repository.list_runs_for_job = original_list_runs
        etl_repository.save_kafka_continuous_command = original_save
        etl_service.with_job_permissions = original_permissions
        etl_service.run_kafka_continuous_worker = original_worker
        etl_service.continuous_worker_status = original_status
        etl_repository.get_dataset_by_id = original_dataset_get
        etl_repository.get_dataset_by_id_for_update = original_dataset_get_for_update
        etl_service.DashboardLiveRepository = original_live_repository
        etl_service.save_catalog_dataset_and_revision = original_catalog_revision_save
        etl_service.backfill_catalog_revision = original_catalog_revision_backfill
        etl_service.verify_continuous_publication_storage = original_publication_storage_verify
        etl_repository.list_kafka_continuous_maintenance_run_models = original_maintenance_list
        etl_repository.list_failed_kafka_continuous_replay_models = original_failed_replay_list
        etl_repository.save_kafka_continuous_maintenance_run = original_maintenance_save
        etl_service.cleanup_kafka_continuous_maintenance = original_maintenance_cleanup
        etl_service.sync_kafka_continuous_session = original_session_sync
        etl_repository.stage_kafka_continuous_session = original_session_stage
        etl_repository.get_kafka_continuous_session = original_session_get
        etl_repository.get_latest_active_kafka_continuous_session = original_active_session_get
        etl_repository.stage_kafka_continuous_batch = original_batch_stage

    print("verify-kafka-continuous-contract: ok")


if __name__ == "__main__":
    main()
