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
from app.schemas.etl import (
    CanonicalRuleDraft,
    ContinuousReplayRequest,
    CreatePipelineRequest,
    KafkaContinuousConfigDraft,
    ReviewPipelineRequest,
    SchemaColumnDraft,
    UpdatePipelineRequest,
)
from app.services import etl_service
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
        schema_columns=[column.model_dump(mode="json", by_alias=True) for column in request.schema_columns],
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
        "dashboardSyncIntervalMinutes": 5,
        "maxOffsetsPerTrigger": 10000,
        "schemaEvolutionPolicy": {
            "additiveNullable": "allow",
            "missingRequired": "quarantine",
            "incompatibleType": "quarantine",
            "unknownField": "preserve",
        },
        "checkpointPath": "s3a://asklake-output/reviews_continuous/bronze/_checkpoints/JOB-CONTINUOUS-CONTRACT",
    }
    request.continuous_config = KafkaContinuousConfigDraft(dashboard_sync_interval_minutes=17)
    custom_config = etl_service.continuous_config_from_request(request, "JOB-CONTINUOUS-CUSTOM")
    assert custom_config["dashboardSyncIntervalMinutes"] == 17
    review = etl_service.review_pipeline(ReviewPipelineRequest.model_validate({
        **request.model_dump(mode="json", by_alias=True),
        "sourceConnectionStatus": "success",
    }))
    assert any(
        item.label == "대시보드 자동 동기화" and item.value == "17분"
        for item in review.basic_information
    )

    job = continuous_job()
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
    assert "dashboardSyncIntervalMinutes" not in captured_worker_payload

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
    original_find = etl_repository.find_conflicting_kafka_continuous_runtime
    original_snapshot_find = etl_repository.find_conflicting_kafka_snapshot
    original_list_runs = etl_repository.list_runs_for_job
    original_save = etl_repository.save_kafka_continuous_command
    original_permissions = etl_service.with_job_permissions
    original_worker = etl_service.run_kafka_continuous_worker
    original_status = etl_service.continuous_worker_status
    original_dataset_get = etl_repository.get_dataset_by_id
    original_dataset_save = etl_repository.save_dataset
    original_maintenance_list = etl_repository.list_kafka_continuous_maintenance_run_models
    original_maintenance_save = etl_repository.save_kafka_continuous_maintenance_run
    original_maintenance_cleanup = etl_service.cleanup_kafka_continuous_maintenance
    original_session_sync = etl_service.sync_kafka_continuous_session
    original_session_stage = etl_repository.stage_kafka_continuous_session
    original_session_get = etl_repository.get_kafka_continuous_session
    original_active_session_get = etl_repository.get_latest_active_kafka_continuous_session
    original_batch_stage = etl_repository.stage_kafka_continuous_batch
    try:
        etl_repository.get_kafka_continuous_runtime = lambda _db, _job_id: runtime
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
            "no_autoflush": property(lambda _self: nullcontext()),
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
        etl_repository.get_dataset_by_id = lambda _db, dataset_id: captured_dataset.get(dataset_id)

        def capture_dataset(_db, dataset):
            captured_dataset[dataset.id] = dataset
            dataset_save_count["value"] += 1
            return dataset
        etl_repository.save_dataset = capture_dataset
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
        etl_service.materialize_continuous_batch(fake_db, job, runtime, {
            "publishedBatches": [{
                "batchId": 0,
                "storedCount": 2,
                "sampleRows": [{"event_id": "evt-2"}, {"event_id": "evt-1"}],
                "sourceRanges": [{"topic": "reviews.continuous", "partition": 0, "startOffset": 0, "endOffset": 2}],
            }],
        })
        assert runtime_relock_count["value"] == 1, "Catalog commit boundaries must reacquire the runtime lock."
        assert runtime.metrics["concurrentMarker"] == "latest", "Reacquired runtime metrics must win over a stale local copy."
        assert runtime.metrics["catalogBatchCursor"] == 9, "Catalog cursor must not regress after a concurrent reconciliation."
        runtime.metrics.pop("concurrentMarker", None)
        runtime.metrics.pop("catalogBatchCursor", None)
        etl_repository.lock_kafka_continuous_runtime = lambda _db, _job_id: runtime
        dataset_id = f"ds_{etl_service.normalize_column_name(job.target)}"
        assert captured_dataset[dataset_id].payload["materializationRuns"][0]["sourceKind"] == "kafka"
        assert captured_dataset[dataset_id].payload["sourceKind"] == "kafka"
        assert captured_dataset[dataset_id].payload["sourceExecutionMode"] == "continuous"
        assert captured_dataset[dataset_id].payload["dashboardSyncIntervalMinutes"] == 5
        assert captured_dataset[dataset_id].payload["materializationRuns"][0]["rowCount"] == 2
        assert captured_dataset[dataset_id].payload["storageLocation"].endswith("/_batches")
        assert captured_dataset[dataset_id].payload["sampleRows"] == [["evt-2"], ["evt-1"]]
        etl_service.materialize_continuous_publication(None, job, runtime, {
            "batchId": 1,
            "storedCount": 1,
            "sourceRanges": [{"topic": "reviews.continuous", "partition": 0, "startOffset": 2, "endOffset": 3}],
        })
        assert captured_dataset[dataset_id].payload["sampleRows"] == [["evt-2"], ["evt-1"]], (
            "A legacy publication without sampleRows must preserve the previous Catalog sample."
        )

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
                "ruleFingerprint": "rule-v2",
                "runtimeFingerprint": "runtime-v2",
                "ruleMetrics": {"qualityQuarantinedCount": 1, "qualityWarnCount": 2},
                "lastRuleResult": {"status": "success", "quality": {"invalidRowCount": 3}},
                "publishedBatches": [{
                    "batchId": 8,
                    "consumedCount": 2,
                    "storedCount": 1,
                    "quarantinedCount": 1,
                    "dataPath": "s3a://asklake-output/reviews_continuous/bronze/_batches/batch_id=8",
                    "manifestPath": "s3a://asklake-output/reviews_continuous/bronze/_batch-manifests/batch_id=8",
                    "ruleContractVersion": "1.0",
                    "ruleFingerprint": "rule-v2",
                    "runtimeFingerprint": "runtime-v2",
                    "schemaFingerprint": "schema-v1",
                    "quality": {"invalidRowCount": 1},
                    "transform": {"warnCount": 0},
                    "publishedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                    "sampleRows": [{"event_id": "evt-8"}],
                    "sourceRanges": [{"topic": "reviews.continuous", "partition": 0, "startOffset": 6, "endOffset": 8}],
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
            recovered_run = captured_dataset[dataset_id].payload["materializationRuns"][0]
            assert recovered_run["runId"] == f"continuous:{job.id}:batch:8"
            assert recovered_run["sourceRanges"][0]["endOffset"] == 8
            assert recovered_run["ruleFingerprint"] == "rule-v2"
            assert recovered_run["quality"]["invalidRowCount"] == 1
            serialized_run = DatasetMaterializationRun.model_validate(recovered_run).model_dump(mode="json", by_alias=True)
            assert serialized_run["ruleFingerprint"] == "rule-v2"
            assert serialized_run["runtimeFingerprint"] == "runtime-v2"
            assert serialized_run["sourceRanges"][0]["endOffset"] == 8
            assert runtime.metrics["ruleFingerprint"] == "rule-v2"
            assert runtime.metrics["ruleMetrics"]["qualityWarnCount"] == 2
            assert captured_dataset[dataset_id].payload["sampleRows"] == [["evt-8"]]
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
        etl_repository.find_conflicting_kafka_continuous_runtime = original_find
        etl_repository.find_conflicting_kafka_snapshot = original_snapshot_find
        etl_repository.list_runs_for_job = original_list_runs
        etl_repository.save_kafka_continuous_command = original_save
        etl_service.with_job_permissions = original_permissions
        etl_service.run_kafka_continuous_worker = original_worker
        etl_service.continuous_worker_status = original_status
        etl_repository.get_dataset_by_id = original_dataset_get
        etl_repository.save_dataset = original_dataset_save
        etl_repository.list_kafka_continuous_maintenance_run_models = original_maintenance_list
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
