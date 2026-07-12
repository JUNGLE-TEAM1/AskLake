import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import duckdb

from app.core.errors import ApiError
from app.services import sql_service
from app.services.sql_service import register_duckdb_dataset


class SqlStorageFormatTests(unittest.TestCase):
    def test_parquet_directory_reads_all_physical_rows(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            connection = duckdb.connect(":memory:")
            try:
                connection.execute(
                    f"COPY (SELECT * FROM (VALUES (1), (2)) rows(id)) "
                    f"TO '{(root / 'part-000.parquet').as_posix()}' (FORMAT PARQUET)"
                )
                connection.execute(
                    f"COPY (SELECT 3 AS id) "
                    f"TO '{(root / 'part-001.parquet').as_posix()}' (FORMAT PARQUET)"
                )
            finally:
                connection.close()

            self.assert_directory_row_count(root, "parquet", 3)

    def test_csv_directory_reads_all_physical_rows(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "part-000.csv").write_text("id,value\n1,alpha\n2,beta\n", encoding="utf-8")
            (root / "part-001.csv").write_text("id,value\n3,gamma\n", encoding="utf-8")

            self.assert_directory_row_count(root, "csv", 3)

    def test_json_directory_reads_all_physical_rows(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "part-000.json").write_text(
                "\n".join(json.dumps({"id": value}) for value in (1, 2)),
                encoding="utf-8",
            )
            (root / "part-001.json").write_text(json.dumps({"id": 3}), encoding="utf-8")

            self.assert_directory_row_count(root, "json", 3)

    def test_jsonl_directory_reads_all_physical_rows(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "part-000.jsonl").write_text(
                "\n".join(json.dumps({"id": value}) for value in (1, 2)),
                encoding="utf-8",
            )
            (root / "part-001.jsonl").write_text(json.dumps({"id": 3}), encoding="utf-8")

            self.assert_directory_row_count(root, "jsonl", 3)

    def test_snapshot_and_newer_etl_deltas_are_unioned(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = self.write_csv_segment(root, "snapshot", (1, 2))
            delta_one = self.write_csv_segment(root, "delta-one", (3,))
            delta_two = self.write_csv_segment(root, "delta-two", (4,))
            dataset = SimpleNamespace(
                id="dataset-1",
                materialization_runs=[
                    {
                        "materializationMode": "delta",
                        "runId": "delta-two",
                        "sourceKind": "etl",
                        "status": "success",
                        "storageFormat": "csv",
                        "storageLocation": str(delta_two),
                    },
                    {
                        "materializationMode": "delta",
                        "runId": "failed-delta",
                        "sourceKind": "etl",
                        "status": "failed",
                        "storageFormat": "csv",
                        "storageLocation": str(root / "missing-failed"),
                    },
                    {
                        "materializationMode": "delta",
                        "runId": "running-delta",
                        "sourceKind": "etl",
                        "status": "running",
                        "storageFormat": "csv",
                        "storageLocation": str(root / "missing-running"),
                    },
                    {
                        "materializationMode": "delta",
                        "runId": "delta-one",
                        "sourceKind": "etl",
                        "status": "success",
                        "storageFormat": "csv",
                        "storageLocation": str(delta_one),
                    },
                    {
                        "materializationMode": "snapshot",
                        "runId": "snapshot",
                        "sourceKind": "etl",
                        "status": "success",
                        "storageFormat": "csv",
                        "storageLocation": str(snapshot),
                    },
                    {
                        "materializationMode": "snapshot",
                        "runId": "old-snapshot",
                        "sourceKind": "etl",
                        "status": "success",
                        "storageFormat": "csv",
                        "storageLocation": str(root / "missing-old-snapshot"),
                    },
                ],
                name="active_segments",
                sample_rows=[["sample-only"]],
                schema_=[["id", "long"]],
                storage_format="csv",
                storage_location=str(delta_two),
            )

            self.assert_dataset_ids(dataset, [1, 2, 3, 4])

    def test_new_snapshot_rebaseline_excludes_older_segments(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            old_snapshot = self.write_csv_segment(root, "old-snapshot", (1,))
            old_delta = self.write_csv_segment(root, "old-delta", (2,))
            new_snapshot = self.write_csv_segment(root, "new-snapshot", (10,))
            new_delta = self.write_csv_segment(root, "new-delta", (11,))
            dataset = SimpleNamespace(
                id="dataset-1",
                materializationRuns=[
                    {
                        "materializationMode": "delta",
                        "runId": "new-delta",
                        "sourceKind": "etl",
                        "status": "success",
                        "storageFormat": "csv",
                        "storageLocation": str(new_delta),
                    },
                    {
                        "materializationMode": "snapshot",
                        "runId": "new-snapshot",
                        "sourceKind": "etl",
                        "status": "success",
                        "storageFormat": "csv",
                        "storageLocation": str(new_snapshot),
                    },
                    {
                        "materializationMode": "delta",
                        "runId": "old-delta",
                        "sourceKind": "etl",
                        "status": "success",
                        "storageFormat": "csv",
                        "storageLocation": str(old_delta),
                    },
                    {
                        "materializationMode": "snapshot",
                        "runId": "old-snapshot",
                        "sourceKind": "etl",
                        "status": "success",
                        "storageFormat": "csv",
                        "storageLocation": str(old_snapshot),
                    },
                ],
                name="rebaseline_segments",
                sample_rows=[["sample-only"]],
                schema_=[["id", "long"]],
                storage_format="csv",
                storage_location=str(new_delta),
            )

            self.assert_dataset_ids(dataset, [10, 11])

    def test_legacy_kafka_source_kind_is_delta_only_when_mode_is_absent(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = self.write_csv_segment(root, "snapshot", (1,))
            legacy_kafka_delta = self.write_csv_segment(root, "kafka-delta", (2,))
            dataset = SimpleNamespace(
                id="dataset-1",
                materialization_runs=[
                    {
                        "runId": "legacy-kafka-delta",
                        "sourceKind": "kafka",
                        "status": "success",
                        "storageFormat": "csv",
                        "storageLocation": str(legacy_kafka_delta),
                    },
                    {
                        "runId": "legacy-etl-snapshot",
                        "sourceKind": "etl",
                        "status": "success",
                        "storageFormat": "csv",
                        "storageLocation": str(snapshot),
                    },
                ],
                name="legacy_kafka_segments",
                sample_rows=[],
                schema_=[["id", "long"]],
                storage_format="csv",
                storage_location=str(legacy_kafka_delta),
            )

            self.assert_dataset_ids(dataset, [1, 2])

    def test_explicit_snapshot_mode_overrides_kafka_legacy_fallback(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = self.write_csv_segment(root, "snapshot", (1,))
            dataset = SimpleNamespace(
                id="dataset-1",
                materialization_runs=[
                    {
                        "materializationMode": "snapshot",
                        "runId": "explicit-snapshot",
                        "sourceKind": "kafka",
                        "status": "success",
                        "storageFormat": "csv",
                        "storageLocation": str(snapshot),
                    },
                    {
                        "materializationMode": "delta",
                        "runId": "older-delta",
                        "sourceKind": "etl",
                        "status": "success",
                        "storageFormat": "csv",
                        "storageLocation": str(root / "missing-older-delta"),
                    },
                ],
                name="explicit_snapshot",
                sample_rows=[],
                schema_=[["id", "long"]],
                storage_format="csv",
                storage_location=str(snapshot),
            )

            self.assert_dataset_ids(dataset, [1])

    def test_snake_case_materialization_run_fields_are_supported(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = self.write_csv_segment(root, "snapshot", (1,))
            delta = self.write_csv_segment(root, "delta", (2,))
            dataset = SimpleNamespace(
                id="dataset-1",
                materialization_runs=[
                    SimpleNamespace(
                        materialization_mode="delta",
                        run_id="delta",
                        source_kind="etl",
                        status="success",
                        storage_format="csv",
                        storage_location=str(delta),
                    ),
                    SimpleNamespace(
                        materialization_mode="snapshot",
                        run_id="snapshot",
                        source_kind="etl",
                        status="success",
                        storage_format="csv",
                        storage_location=str(snapshot),
                    ),
                ],
                name="snake_case_segments",
                sample_rows=[],
                schema_=[["id", "long"]],
                storage_format="csv",
                storage_location=str(delta),
            )

            self.assert_dataset_ids(dataset, [1, 2])

    def test_duplicate_active_segment_path_is_scanned_once(self) -> None:
        with TemporaryDirectory() as directory:
            segment = self.write_csv_segment(Path(directory), "shared", (1, 2))
            dataset = SimpleNamespace(
                id="dataset-1",
                materialization_runs=[
                    {
                        "materializationMode": "delta",
                        "runId": "delta",
                        "sourceKind": "etl",
                        "status": "success",
                        "storageLocation": str(segment),
                    },
                    {
                        "materializationMode": "snapshot",
                        "runId": "snapshot",
                        "sourceKind": "etl",
                        "status": "success",
                        "storageLocation": str(segment),
                    },
                ],
                name="deduplicated_segments",
                sample_rows=[],
                schema_=[["id", "long"]],
                storage_format="csv",
                storage_location=str(segment),
            )

            self.assert_dataset_ids(dataset, [1, 2])

    def test_active_segments_support_mixed_storage_formats(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            csv_segment = self.write_csv_segment(root, "snapshot", (1,))
            json_segment = root / "delta"
            json_segment.mkdir()
            (json_segment / "part.json").write_text(
                json.dumps({"id": 2}),
                encoding="utf-8",
            )
            dataset = SimpleNamespace(
                id="dataset-1",
                materialization_runs=[
                    {
                        "materializationMode": "delta",
                        "runId": "delta",
                        "sourceKind": "etl",
                        "status": "success",
                        "storageFormat": "json",
                        "storageLocation": str(json_segment),
                    },
                    {
                        "materializationMode": "snapshot",
                        "runId": "snapshot",
                        "sourceKind": "etl",
                        "status": "success",
                        "storageFormat": "csv",
                        "storageLocation": str(csv_segment),
                    },
                ],
                name="mixed_segments",
                sample_rows=[],
                schema_=[["id", "long"]],
                storage_format="csv",
                storage_location=str(json_segment),
            )

            self.assert_dataset_ids(dataset, [1, 2])

    def test_missing_active_segment_fails_instead_of_using_sample_rows(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = self.write_csv_segment(root, "snapshot", (1,))
            dataset = SimpleNamespace(
                id="dataset-1",
                materialization_runs=[
                    {
                        "materializationMode": "delta",
                        "runId": "missing-delta",
                        "sourceKind": "etl",
                        "status": "success",
                        "storageFormat": "csv",
                        "storageLocation": str(root / "missing-delta"),
                    },
                    {
                        "materializationMode": "snapshot",
                        "runId": "snapshot",
                        "sourceKind": "etl",
                        "status": "success",
                        "storageFormat": "csv",
                        "storageLocation": str(snapshot),
                    },
                ],
                name="missing_active_segment",
                sample_rows=[["sample-only"]],
                schema_=[["id", "long"]],
                storage_format="csv",
                storage_location=str(root / "missing-delta"),
            )
            connection = duckdb.connect(":memory:")
            try:
                with self.assertRaises(ApiError) as raised:
                    register_duckdb_dataset(connection, dataset)
            finally:
                connection.close()

        self.assertEqual(raised.exception.code, "SQL_STORAGE_ERROR")
        self.assertIn("missing-delta", str(raised.exception.details))

    def test_active_run_without_storage_location_fails_closed(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = self.write_csv_segment(root, "snapshot", (1,))
            dataset = SimpleNamespace(
                id="dataset-1",
                materialization_runs=[
                    {
                        "materializationMode": "delta",
                        "runId": "locationless-delta",
                        "sourceKind": "etl",
                        "status": "success",
                        "storageFormat": "csv",
                        "storageLocation": None,
                    },
                    {
                        "materializationMode": "snapshot",
                        "runId": "snapshot",
                        "sourceKind": "etl",
                        "status": "success",
                        "storageFormat": "csv",
                        "storageLocation": str(snapshot),
                    },
                ],
                name="locationless_active_segment",
                sample_rows=[["sample-only"]],
                schema_=[["id", "long"]],
                storage_format="csv",
                storage_location=str(snapshot),
            )
            connection = duckdb.connect(":memory:")
            try:
                with self.assertRaises(ApiError) as raised:
                    register_duckdb_dataset(connection, dataset)
            finally:
                connection.close()

        self.assertEqual(raised.exception.code, "SQL_STORAGE_ERROR")
        self.assertIn("locationless-delta", str(raised.exception.details))

    def test_materialization_history_without_success_fails_closed(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            stale_storage = self.write_csv_segment(root, "stale", (1,))
            dataset = SimpleNamespace(
                id="dataset-1",
                materialization_runs=[
                    {
                        "materializationMode": "delta",
                        "runId": "running",
                        "sourceKind": "etl",
                        "status": "running",
                        "storageFormat": "csv",
                        "storageLocation": str(stale_storage),
                    },
                    {
                        "materializationMode": "snapshot",
                        "runId": "failed",
                        "sourceKind": "etl",
                        "status": "failed",
                        "storageFormat": "csv",
                        "storageLocation": str(stale_storage),
                    },
                ],
                name="no_successful_segments",
                sample_rows=[["sample-only"]],
                schema_=[["id", "long"]],
                storage_format="csv",
                storage_location=str(stale_storage),
            )
            connection = duckdb.connect(":memory:")
            try:
                with self.assertRaises(ApiError) as raised:
                    register_duckdb_dataset(connection, dataset)
            finally:
                connection.close()

        self.assertEqual(raised.exception.code, "SQL_STORAGE_ERROR")
        self.assertIn("no successful active segments", raised.exception.message)

    def test_unsupported_active_segment_format_fails_closed(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = self.write_csv_segment(root, "snapshot", (1,))
            unsupported = root / "delta"
            unsupported.mkdir()
            (unsupported / "part.avro").write_text("not-avro", encoding="utf-8")
            dataset = SimpleNamespace(
                id="dataset-1",
                materialization_runs=[
                    {
                        "materializationMode": "delta",
                        "runId": "unsupported-delta",
                        "sourceKind": "etl",
                        "status": "success",
                        "storageFormat": "avro",
                        "storageLocation": str(unsupported),
                    },
                    {
                        "materializationMode": "snapshot",
                        "runId": "snapshot",
                        "sourceKind": "etl",
                        "status": "success",
                        "storageFormat": "csv",
                        "storageLocation": str(snapshot),
                    },
                ],
                name="unsupported_active_segment",
                sample_rows=[["sample-only"]],
                schema_=[["id", "long"]],
                storage_format="csv",
                storage_location=str(unsupported),
            )
            connection = duckdb.connect(":memory:")
            try:
                with self.assertRaises(ApiError) as raised:
                    register_duckdb_dataset(connection, dataset)
            finally:
                connection.close()

        self.assertEqual(raised.exception.code, "SQL_STORAGE_ERROR")
        self.assertIn("not supported", raised.exception.message)

    def test_catalog_payload_keeps_explicit_etl_delta_mode_for_sql(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = self.write_csv_segment(root, "snapshot", (1,))
            delta = self.write_csv_segment(root, "delta", (2,))
            payload = {
                "description": "Materialized dataset",
                "freshness": "latest",
                "id": "dataset-1",
                "layer": "SILVER",
                "lastUpdated": "2026-07-12T00:01:00Z",
                "materializationRuns": [
                    self.catalog_run("delta", "delta", delta),
                    self.catalog_run("snapshot", "snapshot", snapshot),
                ],
                "name": "catalog_materialized",
                "nextRefresh": "manual",
                "owner": "owner",
                "quality": "validated",
                "rag": False,
                "rows": "2 rows",
                "sampleRows": [["sample-only"]],
                "schema": [["id", "long"]],
                "size": "2 B",
                "source": "folder-etl",
                "status": "available",
                "storageFormat": "csv",
                "storageLocation": str(delta),
                "tags": [],
            }
            service = sql_service.SqlService(
                SimpleNamespace(),
                SimpleNamespace(
                    db=object(),
                    get_dataset_payload=lambda _dataset_id: payload,
                ),
            )
            with patch.object(
                sql_service,
                "dataset_with_persisted_permission_grants",
                side_effect=lambda _db, dataset: dataset,
            ):
                dataset = service.get_catalog_dataset("dataset-1")

            self.assert_dataset_ids(dataset, [1, 2])

    def test_missing_physical_storage_does_not_fall_back_to_sample_rows(self) -> None:
        with TemporaryDirectory() as directory:
            dataset = SimpleNamespace(
                id="dataset-1",
                name="missing_data",
                sample_rows=[["sample-only"]],
                schema_=[["value", "string"]],
                storage_format="csv",
                storage_location=str(Path(directory) / "missing"),
            )
            connection = duckdb.connect(":memory:")
            try:
                with self.assertRaises(ApiError) as raised:
                    register_duckdb_dataset(connection, dataset)
            finally:
                connection.close()

        self.assertEqual(raised.exception.code, "SQL_STORAGE_ERROR")
        self.assertEqual(raised.exception.status_code, 502)

    def test_unsupported_physical_format_does_not_fall_back_to_sample_rows(self) -> None:
        with TemporaryDirectory() as directory:
            dataset = SimpleNamespace(
                id="dataset-1",
                name="unsupported_data",
                sample_rows=[["sample-only"]],
                schema_=[["value", "string"]],
                storage_format="avro",
                storage_location=directory,
            )
            connection = duckdb.connect(":memory:")
            try:
                with self.assertRaises(ApiError) as raised:
                    register_duckdb_dataset(connection, dataset)
            finally:
                connection.close()

        self.assertEqual(raised.exception.code, "SQL_STORAGE_ERROR")
        self.assertIn("not supported", raised.exception.message)

    def assert_directory_row_count(self, root: Path, storage_format: str, expected: int) -> None:
        dataset = SimpleNamespace(
            id=f"ds_{storage_format}",
            name=f"data_{storage_format}",
            sample_rows=[["sample-only"]],
            schema_=[["id", "long"]],
            storage_format=storage_format,
            storage_location=str(root),
        )
        connection = duckdb.connect(":memory:")
        try:
            register_duckdb_dataset(connection, dataset)
            row_count = connection.execute(
                f'SELECT COUNT(*) FROM "{dataset.name}"'
            ).fetchone()[0]
        finally:
            connection.close()

        self.assertEqual(row_count, expected)

    def assert_dataset_ids(self, dataset: SimpleNamespace, expected: list[int]) -> None:
        connection = duckdb.connect(":memory:")
        try:
            register_duckdb_dataset(connection, dataset)
            rows = connection.execute(
                f'SELECT id FROM "{dataset.name}" ORDER BY id'
            ).fetchall()
        finally:
            connection.close()

        self.assertEqual(rows, [(value,) for value in expected])

    def write_csv_segment(
        self,
        root: Path,
        name: str,
        values: tuple[int, ...],
    ) -> Path:
        segment = root / name
        segment.mkdir()
        (segment / "part.csv").write_text(
            "id\n" + "\n".join(str(value) for value in values) + "\n",
            encoding="utf-8",
        )
        return segment

    def catalog_run(self, run_id: str, mode: str, storage_location: Path) -> dict[str, object]:
        return {
            "createdAt": "2026-07-12T00:00:00Z",
            "jobId": "folder-etl",
            "materializationMode": mode,
            "rowCount": 1,
            "runId": run_id,
            "sourceKind": "etl",
            "sourceLabel": "Folder ETL",
            "status": "success",
            "storageFormat": "csv",
            "storageLocation": str(storage_location),
            "storageSizeBytes": 1,
        }


if __name__ == "__main__":
    unittest.main()
