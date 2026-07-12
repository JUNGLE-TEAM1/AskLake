import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from types import SimpleNamespace

import duckdb

from app.core.errors import ApiError
from app.services.sql_service import (
    dataset_declared_row_count,
    read_duckdb_dataset_page,
    register_duckdb_dataset,
    register_duckdb_storage_location,
    s3_scan_path,
)


class SqlStorageFormatTests(unittest.TestCase):
    def test_csv_directory_reads_all_physical_rows(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "part-000.csv").write_text("id,value\n1,alpha\n2,beta\n", encoding="utf-8")
            (root / "part-001.csv").write_text("id,value\n3,gamma\n", encoding="utf-8")
            dataset = SimpleNamespace(storage_location=str(root), storage_format="csv")
            connection = duckdb.connect(":memory:")
            try:
                self.assertTrue(register_duckdb_storage_location(connection, dataset, "csv_data"))
                self.assertEqual(connection.execute('SELECT COUNT(*) FROM "csv_data"').fetchone()[0], 3)
            finally:
                connection.close()

    def test_json_directory_reads_all_physical_rows(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "part-000.json").write_text(
                "\n".join(json.dumps({"id": value}) for value in (1, 2)),
                encoding="utf-8",
            )
            (root / "part-001.json").write_text(json.dumps({"id": 3}), encoding="utf-8")
            dataset = SimpleNamespace(storage_location=str(root), storage_format="json")
            connection = duckdb.connect(":memory:")
            try:
                self.assertTrue(register_duckdb_storage_location(connection, dataset, "json_data"))
                self.assertEqual(connection.execute('SELECT COUNT(*) FROM "json_data"').fetchone()[0], 3)
            finally:
                connection.close()

    def test_materialization_runs_are_unioned_instead_of_reading_only_latest(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "run-1"
            second = root / "run-2"
            first.mkdir()
            second.mkdir()
            (first / "part.csv").write_text("id,value\n1,alpha\n2,beta\n", encoding="utf-8")
            (second / "part.csv").write_text("id,value\n3,gamma\n", encoding="utf-8")
            dataset = SimpleNamespace(
                materialization_runs=[
                    SimpleNamespace(materialization_mode="delta", status="success", storage_location=str(second)),
                    SimpleNamespace(materialization_mode="delta", status="success", storage_location=str(first)),
                ],
                storage_location=str(second),
                storage_format="csv",
            )
            connection = duckdb.connect(":memory:")
            try:
                self.assertTrue(register_duckdb_storage_location(connection, dataset, "versioned_csv"))
                self.assertEqual(connection.execute('SELECT COUNT(*) FROM "versioned_csv"').fetchone()[0], 3)
            finally:
                connection.close()

    def test_materialization_runs_use_each_runs_storage_format(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            csv_run = root / "run-csv"
            json_run = root / "run-json"
            csv_run.mkdir()
            json_run.mkdir()
            (csv_run / "part.csv").write_text("id,value\n1,alpha\n", encoding="utf-8")
            (json_run / "part.json").write_text(
                json.dumps({"id": 2, "value": "beta"}),
                encoding="utf-8",
            )
            dataset = SimpleNamespace(
                materialization_runs=[
                    SimpleNamespace(materialization_mode="delta", status="success", storage_format="json", storage_location=str(json_run)),
                    SimpleNamespace(materialization_mode="delta", status="success", storage_format="csv", storage_location=str(csv_run)),
                ],
                storage_location=str(json_run),
                storage_format="json",
            )
            connection = duckdb.connect(":memory:")
            try:
                self.assertTrue(register_duckdb_storage_location(connection, dataset, "mixed_formats"))
                self.assertEqual(
                    connection.execute('SELECT id, value FROM "mixed_formats" ORDER BY id').fetchall(),
                    [(1, "alpha"), (2, "beta")],
                )
            finally:
                connection.close()

    def test_s3a_directory_is_mapped_to_duckdb_s3_glob(self) -> None:
        self.assertEqual(
            s3_scan_path("s3a://asklake-output/runs/run-1/", "parquet"),
            "s3://asklake-output/runs/run-1/**/*.parquet",
        )

    def test_dataset_page_reads_real_rows_with_count_and_offset(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "part.csv").write_text(
                "id,value\n1,alpha\n2,beta\n3,gamma\n",
                encoding="utf-8",
            )
            dataset = SimpleNamespace(
                id="dataset-1",
                materialization_runs=[],
                name="catalog_rows",
                sample_rows=[["sample-only", "sample-only"]],
                schema_=[["id", "long"], ["value", "string"]],
                storage_format="csv",
                storage_location=str(root),
            )

            result = read_duckdb_dataset_page(dataset, limit=2, offset=1)

        self.assertEqual(result["columns"], ["id", "value"])
        self.assertEqual(result["row_count"], 3)
        self.assertEqual(result["rows"], [["2", "beta"], ["3", "gamma"]])

    def test_declared_materialization_count_requires_explicit_counts(self) -> None:
        self.assertEqual(
            dataset_declared_row_count(SimpleNamespace(materialization_runs=[
                {"status": "success", "materializationMode": "delta", "rowCount": 2},
                {"status": "success", "materializationMode": "delta", "rowCount": 3},
            ])),
            5,
        )
        self.assertIsNone(dataset_declared_row_count(SimpleNamespace(materialization_runs=[
            {"status": "success"},
        ])))

    def test_latest_snapshot_replaces_older_snapshot_for_sql_and_counts(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            old_snapshot = root / "old"
            new_snapshot = root / "new"
            old_snapshot.mkdir()
            new_snapshot.mkdir()
            (old_snapshot / "part.csv").write_text("id\n1\n2\n", encoding="utf-8")
            (new_snapshot / "part.csv").write_text("id\n3\n", encoding="utf-8")
            dataset = SimpleNamespace(
                materialization_runs=[
                    {
                        "materializationMode": "snapshot",
                        "rowCount": 1,
                        "status": "success",
                        "storageFormat": "csv",
                        "storageLocation": str(new_snapshot),
                    },
                    {
                        "materializationMode": "snapshot",
                        "rowCount": 2,
                        "status": "success",
                        "storageFormat": "csv",
                        "storageLocation": str(old_snapshot),
                    },
                ],
                storage_format="csv",
                storage_location=str(new_snapshot),
            )
            connection = duckdb.connect(":memory:")
            try:
                self.assertTrue(register_duckdb_storage_location(connection, dataset, "snapshots"))
                self.assertEqual(connection.execute('SELECT id FROM "snapshots"').fetchall(), [(3,)])
                self.assertEqual(dataset_declared_row_count(dataset), 1)
            finally:
                connection.close()

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

        self.assertEqual(raised.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()
