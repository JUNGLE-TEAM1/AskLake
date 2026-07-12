import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from types import SimpleNamespace

import duckdb

from app.core.errors import ApiError
from app.services.sql_service import register_duckdb_dataset, register_duckdb_storage_location, s3_scan_path


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

    def test_s3a_directory_is_mapped_to_duckdb_s3_glob(self) -> None:
        self.assertEqual(
            s3_scan_path("s3a://asklake-output/runs/run-1/", "parquet"),
            "s3://asklake-output/runs/run-1/**/*.parquet",
        )

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
