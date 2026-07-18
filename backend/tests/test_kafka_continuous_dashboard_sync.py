import json
import os
from io import BytesIO
from types import SimpleNamespace
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch

from app.services import etl_service


class KafkaContinuousDashboardSyncTests(unittest.TestCase):
    def test_running_runtime_opens_new_session_after_transient_failed_session(self) -> None:
        runtime = SimpleNamespace(
            checkpoint_path="s3://checkpoints/job-live",
            consumed_count=100,
            failed_count=1,
            job_id="job-live",
            lag=20,
            last_batch_id="9",
            last_error=None,
            last_flush_at="2026-07-18T08:30:00Z",
            metrics={"currentSessionId": "SESSION-job-live-failed"},
            quarantined_count=0,
            status="running",
            stored_count=90,
        )
        failed_session = SimpleNamespace(
            ended_at="2026-07-18T08:20:03Z",
            job_id="job-live",
            session_id="SESSION-job-live-failed",
            status="failed",
        )
        db = SimpleNamespace(add=Mock())

        with (
            patch.object(etl_service, "current_kafka_continuous_session", return_value=failed_session),
            patch.object(etl_service.etl_repository, "stage_kafka_continuous_session") as stage_session,
            patch.object(etl_service, "sync_kafka_continuous_batches"),
            patch.object(etl_service, "continuous_session_dag_steps", return_value=[]),
        ):
            etl_service.sync_kafka_continuous_session(db, runtime, {"status": "running"})

        recovered_session = stage_session.call_args.args[1]
        self.assertNotEqual(recovered_session.session_id, failed_session.session_id)
        self.assertEqual(recovered_session.status, "running")
        self.assertEqual(recovered_session.consumed_count, 0)
        self.assertEqual(recovered_session.baseline_counts["consumedCount"], 100)
        self.assertEqual(runtime.metrics["currentSessionId"], recovered_session.session_id)
        db.add.assert_called_once_with(recovered_session)

    def test_runtime_report_path_uses_shared_s3_prefix_when_configured(self) -> None:
        with patch.dict(
            os.environ,
            {"ASKLAKE_CONTINUOUS_RUNTIME_DOCUMENT_PREFIX": "s3a://runtime-bucket/asklake/continuous/"},
        ):
            self.assertEqual(
                etl_service.continuous_runtime_report_path("Job Live"),
                "s3a://runtime-bucket/asklake/continuous/kafka-continuous-job-live.json",
            )

    def test_runtime_cursor_metrics_merge_by_topic_and_partition(self) -> None:
        merged = etl_service.merge_stream_partition_cursor_metrics(
            [
                {"topic": "orders", "partition": 0, "nextOffset": 10},
                {"topic": "returns", "partition": 0, "nextOffset": 4},
            ],
            [
                {"topic": "orders", "partition": 0, "startOffset": 10, "endOffset": 15},
                {"topic": "orders", "partition": 1, "startOffset": 0, "endOffset": 3},
            ],
        )

        self.assertEqual(merged, [
            {"topic": "orders", "partition": 0, "nextOffset": 15},
            {"topic": "orders", "partition": 1, "nextOffset": 3},
            {"topic": "returns", "partition": 0, "nextOffset": 4},
        ])

    def test_terminal_report_detects_unacknowledged_batch_zero(self) -> None:
        runtime = SimpleNamespace(metrics={})
        with TemporaryDirectory() as directory, patch.dict(
            os.environ,
            {"ASKLAKE_SPARK_REPORT_DIR": directory},
        ):
            report_path = etl_service.continuous_runtime_report_path("job-live")
            report_path.write_text(
                json.dumps({
                    "publishedBatches": [{"batchId": 0, "storedCount": 2}],
                }),
                encoding="utf-8",
            )

            self.assertTrue(
                etl_service.continuous_report_has_unacknowledged_publication(
                    "job-live",
                    runtime,
                )
            )
            runtime.metrics = {"catalogBatchCursor": 0}
            self.assertFalse(
                etl_service.continuous_report_has_unacknowledged_publication(
                    "job-live",
                    runtime,
                )
            )

    def test_terminal_report_uses_legacy_last_batch_fallback(self) -> None:
        runtime = SimpleNamespace(metrics={"catalogBatchCursor": 4})
        with TemporaryDirectory() as directory, patch.dict(
            os.environ,
            {"ASKLAKE_SPARK_REPORT_DIR": directory},
        ):
            report_path = etl_service.continuous_runtime_report_path("job-legacy")
            report_path.write_text(
                json.dumps({
                    "lastBatchId": "5",
                    "lastBatchWritten": True,
                    "publishedBatches": [],
                }),
                encoding="utf-8",
            )

            self.assertTrue(
                etl_service.continuous_report_has_unacknowledged_publication(
                    "job-legacy",
                    runtime,
                )
            )

    def test_terminal_report_keeps_reconciling_after_window_is_acked(self) -> None:
        runtime = SimpleNamespace(metrics={"catalogBatchCursor": 5})
        with TemporaryDirectory() as directory, patch.dict(
            os.environ,
            {"ASKLAKE_SPARK_REPORT_DIR": directory},
        ):
            report_path = etl_service.continuous_runtime_report_path("job-window")
            report_path.write_text(
                json.dumps({
                    "lastBatchId": 7,
                    "lastBatchWritten": True,
                    "publishedBatches": [{"batchId": 5, "storedCount": 2}],
                }),
                encoding="utf-8",
            )

            self.assertTrue(
                etl_service.continuous_report_has_unacknowledged_publication(
                    "job-window",
                    runtime,
                )
            )

    def test_terminal_batch_materialization_uses_complete_last_batch_evidence(self) -> None:
        source_ranges = [{
            "topic": "orders",
            "partition": 0,
            "startOffset": 10,
            "endOffset": 12,
        }]
        report = {
            "lastBatchId": "5",
            "lastBatchWritten": True,
            "publishedBatches": [],
            "lastBatchEvidence": {
                "batchId": 5,
                "dataPath": "s3a://lake/orders/_batches/batch_id=5",
                "manifestPath": "s3a://lake/orders/_batch-manifests/batch_id=5",
                "sourceRanges": source_ranges,
                "storedCount": 2,
            },
        }
        runtime = SimpleNamespace(
            heartbeat_at="2026-07-14T00:00:00Z",
            last_flush_at="2026-07-14T00:00:00Z",
            metrics={"catalogBatchCursor": 4},
        )
        job = SimpleNamespace(id="job-live")
        captured: list[dict[str, object]] = []

        with (
            patch.object(
                etl_service,
                "list_continuous_stream_manifest_batch_ids",
                return_value=[5],
            ),
            patch.object(
                etl_service,
                "materialize_continuous_publication",
                side_effect=lambda _db, _job, _runtime, publication: captured.append(publication) or True,
            ),
        ):
            cursor = etl_service.materialize_continuous_batch(None, job, runtime, report)

        self.assertEqual(cursor, 5)
        self.assertEqual(captured[0]["manifestPath"], report["lastBatchEvidence"]["manifestPath"])
        self.assertEqual(captured[0]["sourceRanges"], source_ranges)

    def test_committed_stream_manifest_can_be_recovered_from_s3(self) -> None:
        manifest = {
            "batchId": 7,
            "sourceRanges": [{
                "topic": "orders",
                "partition": 0,
                "startOffset": 20,
                "endOffset": 21,
            }],
            "storedCount": 1,
        }

        class FakeS3Client:
            def head_object(self, **_request):
                return {}

            def list_objects_v2(self, **_request):
                return {
                    "Contents": [
                        {"Key": "orders/_batch-manifests/batch_id=7/_SUCCESS", "Size": 0},
                        {"Key": "orders/_batch-manifests/batch_id=7/part-00000.json", "Size": 0},
                        {"Key": "orders/_batch-manifests/batch_id=7/part-00003.json", "Size": 512},
                    ],
                }

            def get_object(self, **request):
                self.requested_key = request["Key"]
                payload = (
                    b""
                    if request["Key"].endswith("part-00000.json")
                    else json.dumps(manifest).encode("utf-8")
                )
                return {"Body": BytesIO(payload)}

        job = SimpleNamespace(
            storage_path="s3a://lake/orders",
            target="orders",
            target_layer="BRONZE",
            target_path=None,
        )
        with patch.object(
            etl_service,
            "build_catalog_s3_client",
            return_value=FakeS3Client(),
        ):
            recovered = etl_service.read_continuous_stream_manifest(job, "7")

        self.assertIsNotNone(recovered)
        self.assertEqual(
            recovered["batchId"],
            7,
        )
        self.assertEqual(recovered["manifestPath"], "s3a://lake/orders/_batch-manifests/batch_id=7")
        self.assertEqual(recovered["dataPath"], "s3a://lake/orders/_batches/batch_id=7")

    def test_incomplete_last_batch_evidence_falls_back_to_committed_manifest(self) -> None:
        recovered = {
            "batchId": 9,
            "dataPath": "s3a://lake/orders/_batches/batch_id=9",
            "manifestPath": "s3a://lake/orders/_batch-manifests/batch_id=9",
            "sourceRanges": [{
                "topic": "orders",
                "partition": 0,
                "startOffset": 30,
                "endOffset": 31,
            }],
            "storedCount": 1,
        }
        report = {
            "lastBatchId": "9",
            "lastBatchWritten": True,
            "publishedBatches": [],
            "lastBatchEvidence": {"batchId": 9, "storedCount": 1},
        }
        runtime = SimpleNamespace(
            heartbeat_at=None,
            last_flush_at=None,
            metrics={"catalogBatchCursor": 8},
        )
        captured: list[dict[str, object]] = []
        with (
            patch.object(
                etl_service,
                "list_continuous_stream_manifest_batch_ids",
                return_value=[9],
            ),
            patch.object(etl_service, "read_continuous_stream_manifest", return_value=recovered),
            patch.object(
                etl_service,
                "materialize_continuous_publication",
                side_effect=lambda _db, _job, _runtime, publication: captured.append(publication) or True,
            ),
        ):
            cursor = etl_service.materialize_continuous_batch(
                None,
                SimpleNamespace(id="job-live"),
                runtime,
                report,
            )

        self.assertEqual(cursor, 9)
        self.assertEqual(captured, [recovered])

    def test_terminal_recovery_allows_empty_spark_batch_id_gaps(self) -> None:
        batch_five = {
            "batchId": 5,
            "dataPath": "s3a://lake/orders",
            "manifestPath": "s3a://lake/orders/_batch-manifests/batch_id=5",
            "sourceRanges": [{
                "topic": "orders",
                "partition": 0,
                "startOffset": 10,
                "endOffset": 12,
            }],
            "storedCount": 2,
        }
        batch_seven = {
            "batchId": 7,
            "dataPath": "s3a://lake/orders",
            "manifestPath": "s3a://lake/orders/_batch-manifests/batch_id=7",
            "sourceRanges": [{
                "topic": "orders",
                "partition": 0,
                "startOffset": 12,
                "endOffset": 14,
            }],
            "storedCount": 2,
        }
        runtime = SimpleNamespace(
            heartbeat_at=None,
            last_error=None,
            last_flush_at=None,
            metrics={"catalogBatchCursor": 4},
        )
        captured: list[int] = []
        with (
            patch.object(
                etl_service,
                "list_continuous_stream_manifest_batch_ids",
                return_value=[5, 7],
            ),
            patch.object(
                etl_service,
                "read_continuous_stream_manifest",
                return_value=batch_five,
            ),
            patch.object(
                etl_service,
                "materialize_continuous_publication",
                side_effect=lambda _db, _job, _runtime, publication: captured.append(publication["batchId"]) or True,
            ),
        ):
            cursor = etl_service.materialize_continuous_batch(
                None,
                SimpleNamespace(id="job-live"),
                runtime,
                {
                    "lastBatchId": 7,
                    "lastBatchWritten": True,
                    "lastBatchEvidence": batch_seven,
                    "publishedBatches": [],
                },
            )

        self.assertEqual(cursor, 7)
        self.assertEqual(captured, [5, 7])

    def test_terminal_recovery_falls_back_after_report_window_is_acked(self) -> None:
        batch_seven = {
            "batchId": 7,
            "dataPath": "s3a://lake/orders",
            "manifestPath": "s3a://lake/orders/_batch-manifests/batch_id=7",
            "sourceRanges": [{
                "topic": "orders",
                "partition": 0,
                "startOffset": 12,
                "endOffset": 14,
            }],
            "storedCount": 2,
        }
        runtime = SimpleNamespace(
            heartbeat_at=None,
            last_error=None,
            last_flush_at=None,
            metrics={"catalogBatchCursor": 5},
        )
        captured: list[int] = []
        with (
            patch.object(
                etl_service,
                "list_continuous_stream_manifest_batch_ids",
                return_value=[7],
            ),
            patch.object(
                etl_service,
                "materialize_continuous_publication",
                side_effect=lambda _db, _job, _runtime, publication: captured.append(publication["batchId"]) or True,
            ),
        ):
            cursor = etl_service.materialize_continuous_batch(
                None,
                SimpleNamespace(id="job-live"),
                runtime,
                {
                    "lastBatchId": 7,
                    "lastBatchWritten": True,
                    "lastBatchEvidence": batch_seven,
                    "publishedBatches": [{"batchId": 5, "storedCount": 2}],
                },
            )

        self.assertEqual(cursor, 7)
        self.assertEqual(captured, [7])

    def test_terminal_recovery_does_not_ack_without_completed_last_manifest(self) -> None:
        runtime = SimpleNamespace(
            heartbeat_at=None,
            last_error=None,
            last_flush_at=None,
            metrics={"catalogBatchCursor": 4},
        )
        with (
            patch.object(
                etl_service,
                "list_continuous_stream_manifest_batch_ids",
                return_value=[5],
            ),
            patch.object(etl_service, "materialize_continuous_publication") as materialize,
        ):
            cursor = etl_service.materialize_continuous_batch(
                None,
                SimpleNamespace(id="job-live"),
                runtime,
                {
                    "lastBatchId": 7,
                    "lastBatchWritten": True,
                    "publishedBatches": [],
                },
            )

        self.assertEqual(cursor, 4)
        materialize.assert_not_called()
        self.assertIn("ACK was not advanced", runtime.last_error)

    def test_completed_stream_manifest_listing_is_sorted_and_bounded(self) -> None:
        class FakeS3Client:
            def list_objects_v2(self, **_request):
                return {
                    "Contents": [
                        {"Key": "orders/_batch-manifests/batch_id=7/_SUCCESS"},
                        {"Key": "orders/_batch-manifests/batch_id=5/_SUCCESS"},
                        {"Key": "orders/_batch-manifests/batch_id=6/part-00000.json"},
                        {"Key": "orders/_batch-manifests/batch_id=3/_SUCCESS"},
                    ],
                    "IsTruncated": False,
                }

        job = SimpleNamespace(
            storage_path="s3a://lake/orders",
            target="orders",
            target_layer="BRONZE",
            target_path=None,
        )
        with patch.object(
            etl_service,
            "build_catalog_s3_client",
            return_value=FakeS3Client(),
        ):
            batch_ids = etl_service.list_continuous_stream_manifest_batch_ids(
                job,
                after_batch_id=4,
                through_batch_id=7,
            )

        self.assertEqual(batch_ids, [5, 7])

    def test_terminal_recovery_scans_all_completed_manifests_after_catalog_cursor(self) -> None:
        job = SimpleNamespace(id="job-live")
        runtime = SimpleNamespace(
            heartbeat_at=None,
            last_error=None,
            last_flush_at=None,
            metrics={"catalogBatchCursor": 4},
        )
        manifests = {
            5: {"batchId": 5, "storedCount": 2},
            7: {"batchId": 7, "storedCount": 3},
        }
        captured: list[int] = []
        with (
            patch.object(
                etl_service,
                "list_continuous_stream_manifest_batch_ids",
                return_value=[5, 7],
            ) as list_manifests,
            patch.object(
                etl_service,
                "read_continuous_stream_manifest",
                side_effect=lambda _job, batch_id: manifests[int(batch_id)],
            ),
            patch.object(
                etl_service,
                "materialize_continuous_publication",
                side_effect=lambda _db, _job, _runtime, publication: captured.append(publication["batchId"]) or True,
            ),
        ):
            cursor = etl_service.materialize_continuous_batch(
                None,
                job,
                runtime,
                {
                    "lastBatchId": 4,
                    "lastBatchWritten": True,
                    "publishedBatches": [{"batchId": 4}],
                },
                recover_completed_manifests=True,
            )

        self.assertEqual(cursor, 7)
        self.assertEqual(captured, [5, 7])
        self.assertIs(runtime.metrics["publicationRecoveryPending"], False)
        list_manifests.assert_called_once_with(
            job,
            after_batch_id=4,
            through_batch_id=None,
        )

    def test_terminal_recovery_keeps_pending_metric_until_retry_succeeds(self) -> None:
        job = SimpleNamespace(id="job-live")
        runtime = SimpleNamespace(
            heartbeat_at=None,
            last_error=None,
            last_flush_at=None,
            metrics={"catalogBatchCursor": 4},
        )
        with (
            patch.object(
                etl_service,
                "list_continuous_stream_manifest_batch_ids",
                side_effect=[None, [5]],
            ),
            patch.object(
                etl_service,
                "read_continuous_stream_manifest",
                return_value={"batchId": 5, "storedCount": 1},
            ),
            patch.object(
                etl_service,
                "materialize_continuous_publication",
                return_value=True,
            ) as materialize,
        ):
            first_cursor = etl_service.materialize_continuous_batch(
                None,
                job,
                runtime,
                {},
                recover_completed_manifests=True,
            )
            self.assertEqual(first_cursor, 4)
            self.assertIs(runtime.metrics["publicationRecoveryPending"], True)
            self.assertIn("pending retry", runtime.last_error)

            second_cursor = etl_service.materialize_continuous_batch(
                None,
                job,
                runtime,
                {},
            )

        self.assertEqual(second_cursor, 5)
        self.assertIs(runtime.metrics["publicationRecoveryPending"], False)
        self.assertIsNone(runtime.last_error)
        materialize.assert_called_once()

    def test_missing_terminal_report_recovers_s3_manifests_and_writes_ack(self) -> None:
        job = SimpleNamespace(id="job-live", execution_mode="continuous")
        runtime = SimpleNamespace(
            last_error=None,
            metrics={"catalogBatchCursor": 4},
            status="failed",
        )
        db = SimpleNamespace()
        with (
            TemporaryDirectory() as directory,
            patch.dict(os.environ, {"ASKLAKE_SPARK_REPORT_DIR": directory}),
            patch.object(etl_service, "reconcile_stale_continuous_maintenance_runs"),
            patch.object(etl_service, "reconcile_pending_continuous_replay_catalog"),
            patch.object(
                etl_service.etl_repository,
                "lock_kafka_continuous_runtime",
                return_value=runtime,
            ),
            patch.object(
                etl_service,
                "continuous_worker_status",
                return_value={"containerState": "missing"},
            ),
            patch.object(
                etl_service,
                "materialize_continuous_batch",
                return_value=7,
            ) as materialize,
            patch.object(etl_service, "sync_kafka_continuous_session"),
            patch.object(etl_service.etl_repository, "save_kafka_continuous_command"),
            patch.object(etl_service, "write_continuous_catalog_ack") as write_ack,
        ):
            etl_service.refresh_kafka_continuous_runtime(db, job)

        materialize.assert_called_once_with(
            db,
            job,
            runtime,
            {},
            recover_completed_manifests=True,
        )
        write_ack.assert_called_once_with("job-live", 7)

    def test_runtime_sync_isolates_global_and_per_job_failures(self) -> None:
        class FakeSession:
            def __init__(self) -> None:
                self.rollback_count = 0

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def rollback(self) -> None:
                self.rollback_count += 1

        discovery_db = FakeSession()
        first_job_db = FakeSession()
        second_job_db = FakeSession()
        jobs = [
            SimpleNamespace(id="job-bad", execution_mode="continuous"),
            SimpleNamespace(id="job-good", execution_mode="continuous"),
        ]
        runtimes = {
            "job-bad": SimpleNamespace(metrics={}, status="running"),
            "job-good": SimpleNamespace(metrics={}, status="running"),
        }
        with (
            patch(
                "app.core.database.SessionLocal",
                side_effect=[discovery_db, first_job_db, second_job_db],
            ),
            patch.object(
                etl_service,
                "reconcile_stale_continuous_maintenance_runs",
                side_effect=RuntimeError("maintenance failed"),
            ),
            patch.object(etl_service.etl_repository, "list_job_models", return_value=jobs),
            patch.object(
                etl_service.etl_repository,
                "get_job",
                side_effect=lambda _db, job_id: next(job for job in jobs if job.id == job_id),
            ),
            patch.object(
                etl_service.etl_repository,
                "get_kafka_continuous_runtime",
                side_effect=lambda _db, job_id: runtimes[job_id],
            ),
            patch.object(
                etl_service,
                "refresh_kafka_continuous_runtime",
                side_effect=[RuntimeError("bad job"), None],
            ) as refresh,
            patch("logging.getLogger"),
        ):
            etl_service.sync_active_kafka_continuous_runtimes()

        self.assertEqual(refresh.call_count, 2)
        self.assertEqual(discovery_db.rollback_count, 1)
        self.assertEqual(first_job_db.rollback_count, 1)
        self.assertEqual(second_job_db.rollback_count, 0)

    def test_failed_replay_catalog_is_selected_for_background_recovery(self) -> None:
        pending = SimpleNamespace(
            kind="quarantine_replay",
            status="failed",
            result={
                "catalogApplied": False,
                "manifestPath": "s3a://lake/_replay-manifests/run",
                "outputPath": "s3a://lake/_batches/replay",
                "storedCount": 3,
            },
        )
        with patch.object(
            etl_service.etl_repository,
            "list_kafka_continuous_maintenance_run_models",
            return_value=[pending],
        ):
            self.assertTrue(
                etl_service.has_pending_continuous_replay_catalog(
                    SimpleNamespace(),
                    "job-live",
                )
            )

    def test_legacy_replay_without_catalog_applied_flag_is_reconciled(self) -> None:
        runtime = SimpleNamespace(metrics={}, stored_count=10)
        run = SimpleNamespace(
            kind="quarantine_replay",
            last_error="pending",
            result={
                "manifestPath": "s3a://lake/_replay-manifests/run",
                "outputPath": "s3a://lake/_batches/replay",
                "sourceRanges": [{
                    "topic": "orders",
                    "partition": 0,
                    "startOffset": 10,
                    "endOffset": 12,
                }],
                "storedCount": 2,
            },
            run_id="replay-run",
            status="failed",
        )
        job = SimpleNamespace(id="job-live")
        saved_runs: list[object] = []
        db = SimpleNamespace(add=lambda value: saved_runs.append(value))
        with (
            patch.object(
                etl_service.etl_repository,
                "list_kafka_continuous_maintenance_run_models",
                return_value=[run],
            ),
            patch.object(etl_service.etl_repository, "get_job_for_update", return_value=job),
            patch.object(
                etl_service.etl_repository,
                "lock_kafka_continuous_runtime",
                return_value=runtime,
            ),
            patch.object(etl_service, "materialize_continuous_replay", return_value=True),
            patch.object(etl_service.etl_repository, "save_kafka_continuous_command"),
        ):
            etl_service.reconcile_pending_continuous_replay_catalog(db, job)

        self.assertEqual(run.status, "success")
        self.assertIs(run.result["catalogApplied"], True)
        self.assertIs(run.result["countersApplied"], True)
        self.assertEqual(runtime.stored_count, 12)
        self.assertEqual(saved_runs, [run])

    def test_only_catalog_registered_legacy_replays_are_trusted_for_upgrade(self) -> None:
        dataset = SimpleNamespace(payload={
            "materializationRuns": [
                {
                    "runId": "legacy-replay",
                    "status": "success",
                    "storageLocation": "s3a://lake/orders/_batches/batch_id=replay_legacy-replay",
                },
                {
                    "publicationManifest": "s3a://lake/orders/_replay-manifests/run_id=new-replay",
                    "runId": "new-replay",
                    "status": "success",
                    "storageLocation": "s3a://lake/orders/_batches/batch_id=replay_new-replay",
                },
                {
                    "runId": "failed-replay",
                    "status": "failed",
                    "storageLocation": "s3a://lake/orders/_batches/batch_id=replay_failed-replay",
                },
            ],
        })
        job = SimpleNamespace(dataset_id="dataset-live", target="orders")
        with patch.object(
            etl_service.etl_repository,
            "get_dataset_by_id",
            return_value=dataset,
        ):
            trusted = etl_service.trusted_legacy_replay_run_ids(SimpleNamespace(), job)

        self.assertEqual(trusted, ["legacy-replay"])

    def test_durable_maintenance_result_uses_worker_file_name(self) -> None:
        run_id = "continuous-maint-live"
        with TemporaryDirectory() as directory, patch.dict(
            os.environ,
            {"ASKLAKE_SPARK_REPORT_DIR": directory},
        ):
            result_path = etl_service.continuous_maintenance_result_file(run_id)
            self.assertEqual(
                result_path.name,
                "kafka-continuous-maintenance-continuous-maint-live.result.json",
            )
            result_path.write_text(
                json.dumps({
                    "manifestPath": "s3a://lake/_replay-manifests/run",
                    "outputPath": "s3a://lake/_batches/replay",
                    "runId": run_id,
                    "storedCount": 2,
                }),
                encoding="utf-8",
            )
            self.assertEqual(
                etl_service.read_continuous_maintenance_result(run_id),
                {
                    "manifestPath": "s3a://lake/_replay-manifests/run",
                    "outputPath": "s3a://lake/_batches/replay",
                    "runId": run_id,
                    "storedCount": 2,
                },
            )
            failed_without_db_result = SimpleNamespace(
                kind="quarantine_replay",
                result={},
                run_id=run_id,
                status="failed",
            )
            with patch.object(
                etl_service.etl_repository,
                "list_kafka_continuous_maintenance_run_models",
                return_value=[failed_without_db_result],
            ):
                self.assertTrue(
                    etl_service.has_pending_continuous_replay_catalog(
                        SimpleNamespace(),
                        "job-live",
                    )
                )

    def test_replay_manifest_recovers_exact_run_from_s3(self) -> None:
        run_id = "replay-105"
        boundary = {
            "boundaryId": "boundary-105",
            "jobId": "job-live",
            "kind": "kafka_continuous_replay",
            "runId": run_id,
            "sourceRanges": [{
                "topic": "orders",
                "partition": 0,
                "startOffset": 100,
                "endOffset": 105,
            }],
        }
        manifest = {
            "publicationId": f"replay:{run_id}",
            "publicationType": "replay",
            "runId": run_id,
            "storedCount": 5,
            "dataPath": "iceberg://iceberg/asklake/orders",
            "icebergCommit": {"snapshotId": "105", "sourceBoundary": boundary},
            "sourceBoundary": boundary,
            "sourceRanges": boundary["sourceRanges"],
        }

        class FakeS3Client:
            def head_object(self, **_request):
                return {}

            def list_objects_v2(self, **request):
                return {"Contents": [{"Key": f"{request['Prefix']}part-00000.json"}]}

            def get_object(self, **_request):
                return {"Body": BytesIO(json.dumps(manifest).encode("utf-8"))}

        job = SimpleNamespace(
            id="job-live",
            iceberg_target={
                "catalog": "iceberg",
                "namespace": "asklake",
                "table": "orders",
                "writeMode": "append",
            },
            storage_path="s3a://lake/orders",
            target="orders",
            target_layer="BRONZE",
            target_path=None,
        )
        with patch.object(etl_service, "build_catalog_s3_client", return_value=FakeS3Client()):
            state, recovered, reason = etl_service.read_continuous_replay_manifest(job, run_id)

        self.assertEqual(state, "found")
        self.assertIsNone(reason)
        self.assertEqual(recovered["runId"], run_id)
        self.assertEqual(recovered["outputPath"], "iceberg://iceberg/asklake/orders")
        self.assertEqual(
            recovered["manifestPath"],
            f"s3a://lake/orders/_replay-manifests/run_id={run_id}",
        )

    def test_replay_manifest_404_is_missing_but_access_error_is_unavailable(self) -> None:
        class FakeS3Error(RuntimeError):
            def __init__(self, code: str, http_status: int) -> None:
                super().__init__(code)
                self.response = {
                    "Error": {"Code": code},
                    "ResponseMetadata": {"HTTPStatusCode": http_status},
                }

        class FakeS3Client:
            def __init__(self, error: Exception) -> None:
                self.error = error

            def head_object(self, **_request):
                raise self.error

        job = SimpleNamespace(
            id="job-live",
            iceberg_target={
                "catalog": "iceberg",
                "namespace": "asklake",
                "table": "orders",
                "writeMode": "append",
            },
            storage_path="s3a://lake/orders",
            target="orders",
            target_layer="BRONZE",
            target_path=None,
        )
        with patch.object(
            etl_service,
            "build_catalog_s3_client",
            return_value=FakeS3Client(FakeS3Error("NoSuchKey", 404)),
        ):
            missing, _result, _reason = etl_service.read_continuous_replay_manifest(job, "replay-1")
        with patch.object(
            etl_service,
            "build_catalog_s3_client",
            return_value=FakeS3Client(FakeS3Error("AccessDenied", 403)),
        ):
            unavailable, _result, reason = etl_service.read_continuous_replay_manifest(job, "replay-1")

        self.assertEqual(missing, "missing")
        self.assertEqual(unavailable, "unavailable")
        self.assertIn("AccessDenied", reason)
        failed_run = SimpleNamespace(
            kind="quarantine_replay",
            result={},
            run_id="replay-1",
            status="failed",
        )
        with (
            patch.object(
                etl_service.etl_repository,
                "list_kafka_continuous_maintenance_run_models",
                return_value=[failed_run],
            ),
            patch.object(
                etl_service,
                "build_catalog_s3_client",
                return_value=FakeS3Client(FakeS3Error("NoSuchKey", 404)),
            ),
        ):
            self.assertFalse(etl_service.has_pending_continuous_replay_catalog(SimpleNamespace(), job))
        with (
            patch.object(
                etl_service.etl_repository,
                "list_kafka_continuous_maintenance_run_models",
                return_value=[failed_run],
            ),
            patch.object(
                etl_service,
                "build_catalog_s3_client",
                return_value=FakeS3Client(FakeS3Error("AccessDenied", 403)),
            ),
        ):
            self.assertTrue(etl_service.has_pending_continuous_replay_catalog(SimpleNamespace(), job))

    def test_replay_result_identity_mismatch_is_fail_closed(self) -> None:
        with patch.object(etl_service, "read_continuous_replay_manifest") as read_manifest:
            state, _result, reason = etl_service.recover_continuous_replay_result(
                SimpleNamespace(),
                "replay-expected",
                {
                    "manifestPath": "s3a://lake/orders/_replay-manifests/run_id=replay-other",
                    "outputPath": "iceberg://iceberg/asklake/orders",
                    "runId": "replay-other",
                    "storedCount": 3,
                },
            )

        self.assertEqual(state, "unavailable")
        self.assertIn("different run identity", reason)
        read_manifest.assert_not_called()

    def test_successful_replay_with_unapplied_counters_is_pending(self) -> None:
        pending = SimpleNamespace(
            kind="quarantine_replay",
            run_id="replay-counter",
            status="success",
            result={
                "catalogApplied": True,
                "countersApplied": False,
                "manifestPath": "s3a://lake/orders/_replay-manifests/run_id=replay-counter",
                "outputPath": "iceberg://iceberg/asklake/orders",
                "storedCount": 3,
            },
        )
        with patch.object(
            etl_service.etl_repository,
            "list_kafka_continuous_maintenance_run_models",
            return_value=[pending],
        ):
            self.assertTrue(
                etl_service.has_pending_continuous_replay_catalog(SimpleNamespace(), "job-live")
            )

    def test_start_is_blocked_while_replay_finalization_remains_pending(self) -> None:
        class FakeDb:
            def get_bind(self):
                return object()

        job = SimpleNamespace(
            execution_mode="continuous",
            id="job-live",
            source_config=[],
            source_type="Stream / Kafka",
        )
        runtime = SimpleNamespace(status="stopped")
        with (
            patch.object(
                etl_service.etl_repository,
                "lock_kafka_continuous_runtime",
                return_value=runtime,
            ),
            patch.object(etl_service, "reconcile_stale_continuous_maintenance_runs"),
            patch.object(etl_service, "require_no_active_continuous_maintenance"),
            patch.object(etl_service, "reconcile_pending_continuous_replay_catalog") as reconcile,
            patch.object(etl_service, "has_pending_continuous_replay_catalog", return_value=True),
            patch.object(etl_service, "run_kafka_continuous_worker") as worker,
        ):
            with self.assertRaises(etl_service.ApiError) as raised:
                etl_service.command_kafka_continuous_job(
                    FakeDb(),
                    job,
                    "startContinuous",
                    SimpleNamespace(),
                )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.details["reason"], "replay_catalog_pending")
        reconcile.assert_called_once()
        worker.assert_not_called()


if __name__ == "__main__":
    unittest.main()
