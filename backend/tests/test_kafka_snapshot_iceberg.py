from types import SimpleNamespace
import unittest
from unittest.mock import ANY, Mock, patch

from app.core.errors import ApiError
from app.services.etl_service import (
    append_materialization_run,
    dag_steps_from_kafka_result,
    kafka_snapshot_source_boundary,
    run_kafka_ingest_request,
    spark_result_schema,
)


def snapshot() -> dict:
    return {
        "capturedAt": "2026-07-14T00:00:00Z",
        "consumerGroupId": "asklake-snapshot-test",
        "offsetPolicy": "earliest",
        "partitions": [{
            "endOffset": "10",
            "highWatermark": "20",
            "partition": 0,
            "startOffset": "0",
        }],
        "snapshotId": "kafka_snapshot_1234",
        "topic": "reviews.raw",
    }


class KafkaSnapshotIcebergTests(unittest.TestCase):
    def test_catalog_is_published_before_offset_commit(self) -> None:
        events: list[str] = []
        snapshot_record = SimpleNamespace(snapshot_id="kafka_snapshot_1234")
        request = {"broker": "redpanda:9092", "timeoutMs": 10000, "topic": "reviews.raw"}
        ingest_result = {
            "runId": "RUN-KAFKA-ICEBERG",
            "snapshot": snapshot(),
            "status": "success",
            "storedCount": 10,
        }

        def bridge(_script, _marker, payload, **_kwargs):
            if payload.get("commitOnly"):
                events.append("offset")
                self.assertEqual(events, ["ingest", "catalog", "offset"])
                self.assertTrue(payload["metadata"]["queryEngineVerified"])
                return {
                    "metadataUpdate": {"status": "success"},
                    "offsetCommit": {"status": "success"},
                }
            events.append("ingest")
            return ingest_result

        def publish(_db, _job, result):
            events.append("catalog")
            self.assertEqual(events, ["ingest", "catalog"])
            return {**result, "queryEngineVerified": True}

        with (
            patch("app.services.etl_service.kafka_request_with_durable_snapshot", return_value=(snapshot_record, request)),
            patch("app.services.etl_service.run_node_bridge", side_effect=bridge),
            patch("app.services.etl_service.etl_repository.get_job", return_value=SimpleNamespace(id="JOB-KAFKA")),
            patch("app.services.etl_service.publish_kafka_snapshot_iceberg_result", side_effect=publish),
            patch("app.services.etl_service.etl_repository.update_kafka_snapshot") as update_snapshot,
        ):
            result = run_kafka_ingest_request(Mock(), request, "run", "JOB-KAFKA")

        self.assertEqual(events, ["ingest", "catalog", "offset"])
        self.assertEqual(result["offsetCommit"]["status"], "success")
        self.assertEqual(result["metadataUpdate"]["status"], "success")
        update_snapshot.assert_called_once_with(ANY, snapshot_record, "success")

    def test_catalog_failure_leaves_offsets_uncommitted(self) -> None:
        snapshot_record = SimpleNamespace(snapshot_id="kafka_snapshot_1234")
        request = {"broker": "redpanda:9092", "timeoutMs": 10000, "topic": "reviews.raw"}
        bridge = Mock(return_value={
            "runId": "RUN-KAFKA-ICEBERG",
            "snapshot": snapshot(),
            "status": "success",
            "storedCount": 10,
        })
        failure = ApiError("CATALOG_RECONCILIATION_FAILED", "catalog failed", 502)

        with (
            patch("app.services.etl_service.kafka_request_with_durable_snapshot", return_value=(snapshot_record, request)),
            patch("app.services.etl_service.run_node_bridge", bridge),
            patch("app.services.etl_service.etl_repository.get_job", return_value=SimpleNamespace(id="JOB-KAFKA")),
            patch("app.services.etl_service.publish_kafka_snapshot_iceberg_result", side_effect=failure),
            patch("app.services.etl_service.etl_repository.update_kafka_snapshot") as update_snapshot,
        ):
            with self.assertRaises(ApiError):
                run_kafka_ingest_request(Mock(), request, "run", "JOB-KAFKA")

        bridge.assert_called_once()
        update_snapshot.assert_called_once_with(ANY, snapshot_record, "failed", "catalog failed")

    def test_materialization_history_deduplicates_snapshot_identity(self) -> None:
        previous = [{
            "kafkaSnapshot": {"snapshotId": "kafka_snapshot_1234"},
            "materializationMode": "snapshot",
            "rowCount": 10,
            "runId": "RUN-OLD",
        }]
        next_run = {
            "kafkaSnapshot": {"snapshotId": "kafka_snapshot_1234"},
            "materializationMode": "snapshot",
            "rowCount": 10,
            "runId": "RUN-RETRY",
        }

        result = append_materialization_run(previous, next_run)

        self.assertEqual(result, [next_run])

    def test_source_boundary_uses_exclusive_partition_ranges(self) -> None:
        boundary = kafka_snapshot_source_boundary(snapshot())

        self.assertEqual(boundary["kind"], "kafka_snapshot")
        self.assertEqual(boundary["snapshotId"], "kafka_snapshot_1234")
        self.assertEqual(boundary["partitions"], [{
            "endOffset": "10",
            "partition": 0,
            "startOffset": "0",
        }])

    def test_catalog_schema_accepts_spark_objects_and_legacy_pairs(self) -> None:
        self.assertEqual(
            spark_result_schema([
                {"name": "event_id", "nullable": False, "type": "string"},
                ["offset", "bigint"],
                {"name": "_asklake_kafka_snapshot_id", "type": "string"},
            ]),
            [["event_id", "string"], ["offset", "bigint"]],
        )

    def test_dag_keeps_iceberg_and_catalog_success_when_offset_commit_fails(self) -> None:
        result = {
            "catalogDataset": {"id": "ds_reviews_raw"},
            "consumedCount": 2,
            "failedStage": "offset commit",
            "icebergCommit": {
                "snapshotId": "123",
                "target": {"tableUri": "iceberg://iceberg/asklake/reviews_raw"},
            },
            "offsetCommit": {"status": "pending"},
            "quality": {"summary": "No quality rules"},
            "queryEngineVerified": True,
            "snapshot": snapshot(),
            "status": "failed",
            "storageFormat": "iceberg",
            "storageLocation": "s3://warehouse/asklake/reviews_raw",
            "storedCount": 2,
            "targetLayer": "BRONZE",
            "topic": "reviews.raw",
            "transform": {},
        }
        job = SimpleNamespace(
            dataset_id="ds_reviews_raw",
            source_config=[],
            target="reviews_raw",
            target_layer="BRONZE",
        )

        steps = dag_steps_from_kafka_result(
            job,
            "run",
            {"errorSummary": "offset failed", "outputPath": "-", "runId": "RUN-1"},
            result,
        )

        self.assertEqual([step["status"] for step in steps[-3:]], ["success", "success", "failed"])
        self.assertEqual(steps[-3]["title"], "5. Iceberg target 커밋")


if __name__ == "__main__":
    unittest.main()
