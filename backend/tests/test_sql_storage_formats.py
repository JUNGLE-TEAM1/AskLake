import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest

import duckdb

from app.core.errors import ApiError
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


if __name__ == "__main__":
    unittest.main()
