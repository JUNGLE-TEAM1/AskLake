import re
import unittest

from pydantic import ValidationError

from app.core.config import Settings
from app.models.etl import ETLJobModel
from app.schemas.etl import JobRowData
from app.schemas.iceberg import IcebergWriterTarget
from app.schemas.trino import TrinoClientPage, TrinoQueryRunError
from app.services.iceberg_writer_service import (
    IcebergWriterError,
    IcebergWriterService,
    build_iceberg_writer_target,
    writer_mode_for_source,
)


class FakeTrinoClient:
    def __init__(self) -> None:
        self.exists = False
        self.snapshot_id = 1000
        self.current_snapshot_id = 1000
        self.available_snapshot_ids = {1000}
        self.queries: list[str] = []
        self.fail_describe = False

    def submit(self, query: str) -> TrinoClientPage:
        self.queries.append(query)
        if "information_schema.tables" in query:
            rows = [["reviews"]] if self.exists else []
            return finished_page(rows=rows)
        if query.startswith("CREATE TABLE ") or query.startswith("CREATE OR REPLACE TABLE "):
            self.exists = True
            self.snapshot_id += 1
            self.current_snapshot_id = self.snapshot_id
            self.available_snapshot_ids.add(self.snapshot_id)
            return finished_page()
        if query.startswith("INSERT INTO "):
            if not self.exists:
                return failed_page("TABLE_NOT_FOUND")
            self.snapshot_id += 1
            self.current_snapshot_id = self.snapshot_id
            self.available_snapshot_ids.add(self.snapshot_id)
            return finished_page()
        if query.startswith("DESCRIBE "):
            if self.fail_describe:
                return failed_page("TABLE_NOT_FOUND")
            return finished_page(rows=[["event_id", "varchar", "", ""]])
        if "$refs" in query:
            return finished_page(rows=[[str(self.current_snapshot_id)]])
        if "$snapshots" in query:
            if "total-data-files" in query:
                return finished_page(rows=[[2, 4096]])
            requested = re.search(r"= '(-?\d+)'", query)
            snapshot_id = int(requested.group(1)) if requested else self.snapshot_id
            if snapshot_id not in self.available_snapshot_ids:
                return finished_page()
            return finished_page(rows=[[
                str(snapshot_id),
                "2026-07-13 12:00:00.000 UTC",
                f"s3://asklake-warehouse/warehouse/reviews/metadata/snap-{snapshot_id}.avro",
            ]])
        if "$files" in query:
            return finished_page(rows=[[2, 4096]])
        return finished_page()

    def fetch(self, next_uri: str) -> TrinoClientPage:
        raise AssertionError(f"Unexpected continuation: {next_uri}")


def finished_page(*, rows: list[list[object]] | None = None) -> TrinoClientPage:
    return TrinoClientPage(
        queryId="query_finished",
        rawStats={"state": "FINISHED"},
        rows=rows or [],
        state="FINISHED",
    )


def failed_page(code: str) -> TrinoClientPage:
    return TrinoClientPage(
        queryId="query_failed",
        error=TrinoQueryRunError(code=code, message=code),
        rawStats={"state": "FAILED"},
        state="FAILED",
    )


class IcebergWriterFoundationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.settings = Settings(_env_file=None, trino_enabled=True)
        self.client = FakeTrinoClient()
        self.service = IcebergWriterService(self.settings, client=self.client)  # type: ignore[arg-type]

    def test_backend_owned_target_is_stable_and_serializable(self) -> None:
        first = build_iceberg_writer_target(
            "리뷰 데이터",
            "ds_reviews",
            write_mode="append",
            partition_columns=["created_at", "created_at", ""],
            runtime_settings=self.settings,
        )
        second = build_iceberg_writer_target(
            "리뷰 데이터",
            "ds_reviews",
            write_mode="append",
            runtime_settings=self.settings,
        )

        self.assertEqual(first.table, second.table)
        self.assertEqual(first.partition_columns, ["created_at"])
        self.assertEqual(first.table_uri, f"iceberg://iceberg/asklake/{first.table}")
        self.assertEqual(first.query_engine_table().table, first.table)
        self.assertEqual(first.model_dump(mode="json", by_alias=True)["writeMode"], "append")
        self.assertEqual(writer_mode_for_source("Stream / Kafka"), "append")
        self.assertEqual(writer_mode_for_source("File / S3"), "replace")

    def test_append_creates_then_inserts_and_collects_evidence(self) -> None:
        target = build_iceberg_writer_target(
            "reviews",
            "ds_reviews",
            write_mode="append",
            runtime_settings=self.settings,
        )
        first = self.service.commit_select(
            target,
            "VALUES ('event-1')",
            job_id="JOB-1",
            run_id="RUN-1",
            schema_fingerprint="schema-v1",
            source_boundary={"partition": 0, "fromOffset": 0, "untilOffset": 1},
        )
        second = self.service.commit_select(
            target,
            "VALUES ('event-2')",
            job_id="JOB-1",
            run_id="RUN-2",
        )

        self.assertTrue(first.created_table)
        self.assertFalse(second.created_table)
        self.assertNotEqual(first.snapshot_id, second.snapshot_id)
        self.assertEqual(first.warehouse_location, "s3://asklake-warehouse/warehouse/reviews")
        self.assertEqual(first.query_engine_table.table, target.table)
        self.assertTrue(first.query_engine_verified)
        self.assertTrue(any(query.startswith("CREATE TABLE ") for query in self.client.queries))
        self.assertTrue(any(query.startswith("INSERT INTO ") for query in self.client.queries))
        self.assertTrue(any(query.startswith("DESCRIBE ") for query in self.client.queries))

    def test_replace_uses_atomic_replace_after_first_commit(self) -> None:
        target = build_iceberg_writer_target(
            "orders",
            "ds_orders",
            write_mode="replace",
            runtime_settings=self.settings,
        )
        self.service.commit_select(target, "VALUES (1)", job_id="JOB-2", run_id="RUN-1")
        replaced = self.service.commit_select(target, "VALUES (2)", job_id="JOB-2", run_id="RUN-2")

        self.assertFalse(replaced.created_table)
        self.assertTrue(any(query.startswith("CREATE OR REPLACE TABLE ") for query in self.client.queries))

    def test_verification_failure_never_returns_commit_evidence(self) -> None:
        self.client.fail_describe = True
        target = build_iceberg_writer_target(
            "reviews",
            "ds_reviews",
            write_mode="append",
            runtime_settings=self.settings,
        )
        with self.assertRaises(IcebergWriterError) as context:
            self.service.commit_select(target, "VALUES ('event-1')", job_id="JOB-1", run_id="RUN-1")
        self.assertEqual(context.exception.code, "TABLE_NOT_FOUND")

    def test_external_writer_snapshot_must_match_verified_snapshot(self) -> None:
        target = build_iceberg_writer_target(
            "reviews",
            "ds_reviews",
            write_mode="append",
            runtime_settings=self.settings,
        )
        committed = self.service.commit_select(
            target,
            "VALUES ('event-1')",
            job_id="JOB-1",
            run_id="RUN-1",
        )
        verified = self.service.verify_commit(
            target,
            created_table=False,
            job_id="JOB-1",
            run_id="RUN-SPARK-1",
            expected_snapshot_id=committed.snapshot_id,
        )
        self.assertEqual(verified.snapshot_id, committed.snapshot_id)
        with self.assertRaises(IcebergWriterError) as context:
            self.service.verify_commit(
                target,
                created_table=False,
                job_id="JOB-1",
                run_id="RUN-SPARK-STALE",
                expected_snapshot_id="999999",
            )
        self.assertEqual(context.exception.code, "ICEBERG_SNAPSHOT_ID_MISMATCH")

    def test_external_writer_physical_file_metrics_are_queryable(self) -> None:
        target = build_iceberg_writer_target(
            "reviews",
            "ds_reviews",
            write_mode="replace",
            runtime_settings=self.settings,
        )

        file_count, storage_size_bytes = self.service.table_storage_metrics(
            target,
            snapshot_id="1000",
        )

        self.assertEqual(file_count, 2)
        self.assertEqual(storage_size_bytes, 4096)
        self.assertTrue(any(
            "$snapshots" in query
            and "total-data-files" in query
            and "snapshot_id = 1000" in query
            for query in self.client.queries
        ))

    def test_current_snapshot_follows_main_ref_after_rollback(self) -> None:
        target = build_iceberg_writer_target(
            "reviews",
            "ds_reviews",
            write_mode="replace",
            runtime_settings=self.settings,
        )
        self.client.snapshot_id = 1002
        self.client.current_snapshot_id = 1001
        self.client.available_snapshot_ids.update({1001, 1002})

        snapshot_id, _, warehouse_location = self.service.current_snapshot(target)

        self.assertEqual(snapshot_id, "1001")
        self.assertTrue(warehouse_location.endswith("/reviews"))
        self.assertTrue(any("$refs" in query for query in self.client.queries))
        self.assertFalse(any("ORDER BY committed_at DESC" in query for query in self.client.queries))

    def test_unsafe_identifiers_and_non_select_statements_are_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            IcebergWriterTarget(
                catalog="iceberg",
                namespace="asklake",
                table='reviews"; DROP TABLE reviews',
                write_mode="append",
            )
        target = build_iceberg_writer_target(
            "reviews",
            "ds_reviews",
            write_mode="append",
            runtime_settings=self.settings,
        )
        with self.assertRaises(IcebergWriterError) as context:
            self.service.commit_select(target, "DROP TABLE reviews", job_id="JOB-1", run_id="RUN-1")
        self.assertEqual(context.exception.code, "ICEBERG_SELECT_QUERY_REQUIRED")
        with self.assertRaises(IcebergWriterError):
            self.service.commit_select(
                target,
                "SELECT 1; DROP TABLE reviews",
                job_id="JOB-1",
                run_id="RUN-1",
            )

    def test_job_api_persists_and_hydrates_backend_owned_target(self) -> None:
        target = build_iceberg_writer_target(
            "reviews",
            "ds_reviews",
            write_mode="append",
            runtime_settings=self.settings,
        )
        self.assertIn("iceberg_target", ETLJobModel.__table__.columns)
        job = JobRowData.model_validate({
            "id": "JOB-ICEBERG-TARGET",
            "name": "reviews",
            "owner": "data-team",
            "status": "scheduled",
            "tag": "[생성]",
            "source": "Stream / Kafka",
            "target": "reviews",
            "schedule": "수동",
            "executionMode": "snapshot",
            "icebergTarget": target.model_dump(mode="json", by_alias=True),
            "lastRun": "생성 후 미실행",
            "lastState": "대기",
            "nextRun": "-",
        })
        response = job.model_dump(mode="json", by_alias=True)

        self.assertEqual(job.iceberg_target.table, target.table)
        self.assertEqual(response["icebergTarget"]["writeMode"], "append")
        self.assertEqual(response["icebergTarget"]["tableUri"], target.table_uri)


if __name__ == "__main__":
    unittest.main()
