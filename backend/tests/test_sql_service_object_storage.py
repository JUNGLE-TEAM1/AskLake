import os
from pathlib import Path
import shutil
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

import duckdb

from app.core.errors import ApiError
from app.services import sql_service


class FakeS3Client:
    def __init__(self, objects: dict[str, Path], *, reported_sizes: dict[str, int] | None = None) -> None:
        self.objects = objects
        self.reported_sizes = reported_sizes or {}
        self.downloaded_keys: list[str] = []

    def list_objects_v2(self, **kwargs: object) -> dict[str, object]:
        prefix = str(kwargs.get("Prefix") or "")
        return {
            "Contents": [
                {
                    "Key": key,
                    "Size": self.reported_sizes.get(key, source.stat().st_size),
                }
                for key, source in self.objects.items()
                if key.startswith(prefix)
            ],
            "IsTruncated": False,
        }

    def download_file(self, _: str, object_key: str, destination: str) -> None:
        self.downloaded_keys.append(object_key)
        shutil.copyfile(self.objects[object_key], destination)


class SqlServiceObjectStorageTest(TestCase):
    def setUp(self) -> None:
        self.fixture_dir = Path(self.enterContext(sql_service.TemporaryDirectory()))
        self.parquet_path = self.fixture_dir / "source.parquet"
        connection = duckdb.connect(database=":memory:")
        try:
            connection.execute(
                f"COPY (SELECT * FROM (VALUES (1, 'alpha'), (2, 'beta')) AS rows(id, label)) "
                f"TO {sql_service.quote_duckdb_string_literal(str(self.parquet_path))} (FORMAT PARQUET)"
            )
        finally:
            connection.close()
        self.csv_path = self.fixture_dir / "source.csv"
        self.csv_path.write_text("id,label\n1,alpha\n2,beta\n", encoding="utf-8")
        self.json_path = self.fixture_dir / "source.json"
        self.json_path.write_text(
            '{"id":1,"label":"alpha"}\n{"id":2,"label":"beta"}\n',
            encoding="utf-8",
        )
        self.jsonl_path = self.fixture_dir / "source.jsonl"
        self.jsonl_path.write_text(self.json_path.read_text(encoding="utf-8"), encoding="utf-8")

    def remote_dataset(self, storage_format: str = "parquet") -> SimpleNamespace:
        return SimpleNamespace(
            id="ds_remote_table",
            name="remote_table",
            sample_rows=[],
            schema_=[],
            storage_format=storage_format,
            storage_location="s3a://asklake-output/remote_table/silver/run_1",
        )

    def remote_materialized_dataset(self) -> SimpleNamespace:
        snapshot_location = "s3a://asklake-output/remote_table/silver/snapshot"
        delta_location = "s3a://asklake-output/remote_table/silver/delta"
        return SimpleNamespace(
            id="ds_remote_table",
            materialization_runs=[
                {
                    "materializationMode": "delta",
                    "runId": "delta",
                    "sourceKind": "etl",
                    "status": "success",
                    "storageFormat": "parquet",
                    "storageLocation": delta_location,
                },
                {
                    "materializationMode": "snapshot",
                    "runId": "snapshot",
                    "sourceKind": "etl",
                    "status": "success",
                    "storageFormat": "parquet",
                    "storageLocation": snapshot_location,
                },
            ],
            name="remote_table",
            sample_rows=[],
            schema_=[],
            storage_format="parquet",
            storage_location=delta_location,
        )

    def test_remote_parquet_is_downloaded_and_queried(self) -> None:
        object_key = "remote_table/silver/run_1/part-00000.parquet"
        client = FakeS3Client({object_key: self.parquet_path})

        with (
            patch.object(sql_service, "build_sql_preview_s3_client", return_value=client),
            patch.dict(
                os.environ,
                {
                    "ASKLAKE_SQL_PREVIEW_MAX_REMOTE_BYTES": "1048576",
                    "MINIO_BUCKET": "asklake-output",
                },
                clear=False,
            ),
        ):
            result = sql_service.execute_duckdb_preview(
                'SELECT COUNT(*) AS row_count FROM "remote_table"',
                context_datasets=[self.remote_dataset()],
                preview_limit=100,
            )

        self.assertEqual(result["columns"], ["row_count"])
        self.assertEqual(result["rows"], [["2"]])
        self.assertEqual(client.downloaded_keys, [object_key])

    def test_remote_csv_json_and_jsonl_are_downloaded_and_queried(self) -> None:
        fixtures = (
            ("csv", self.csv_path),
            ("json", self.json_path),
            ("jsonl", self.jsonl_path),
        )
        for storage_format, source_path in fixtures:
            with self.subTest(storage_format=storage_format):
                object_key = f"remote_table/silver/run_1/part-00000.{storage_format}"
                client = FakeS3Client({object_key: source_path})
                with (
                    patch.object(sql_service, "build_sql_preview_s3_client", return_value=client),
                    patch.dict(os.environ, {"MINIO_BUCKET": "asklake-output"}, clear=False),
                ):
                    result = sql_service.execute_duckdb_preview(
                        'SELECT COUNT(*) AS row_count FROM "remote_table"',
                        context_datasets=[self.remote_dataset(storage_format)],
                        preview_limit=100,
                    )

                self.assertEqual(result["rows"], [["2"]])
                self.assertEqual(client.downloaded_keys, [object_key])

    def test_remote_snapshot_and_delta_use_distinct_cache_segments(self) -> None:
        snapshot_key = "remote_table/silver/snapshot/part-00000.parquet"
        delta_key = "remote_table/silver/delta/part-00000.parquet"
        client = FakeS3Client({
            snapshot_key: self.parquet_path,
            delta_key: self.parquet_path,
        })

        with (
            patch.object(sql_service, "build_sql_preview_s3_client", return_value=client),
            patch.dict(
                os.environ,
                {
                    "ASKLAKE_SQL_PREVIEW_MAX_REMOTE_BYTES": "1048576",
                    "MINIO_BUCKET": "asklake-output",
                },
                clear=False,
            ),
        ):
            result = sql_service.execute_duckdb_preview(
                'SELECT COUNT(*) AS row_count FROM "remote_table"',
                context_datasets=[self.remote_materialized_dataset()],
                preview_limit=100,
            )

        self.assertEqual(result["rows"], [["4"]])
        self.assertEqual(client.downloaded_keys, [snapshot_key, delta_key])

    def test_local_parquet_preview_still_works(self) -> None:
        dataset = SimpleNamespace(
            id="ds_local_table",
            name="local_table",
            sample_rows=[],
            schema_=[],
            storage_format="parquet",
            storage_location=str(self.parquet_path),
        )

        result = sql_service.execute_duckdb_preview(
            'SELECT COUNT(*) AS row_count FROM "local_table"',
            context_datasets=[dataset],
            preview_limit=100,
        )

        self.assertEqual(result["rows"], [["2"]])

    def test_missing_physical_storage_does_not_use_sample_rows(self) -> None:
        dataset = SimpleNamespace(
            id="ds_sample_table",
            name="sample_table",
            sample_rows=[["1", "alpha"], ["2", "beta"]],
            schema_=[["id", "integer"], ["label", "string"]],
            storage_format="",
            storage_location="",
        )

        with self.assertRaises(ApiError) as raised:
            sql_service.execute_duckdb_preview(
                'SELECT COUNT(*) AS row_count FROM "sample_table"',
                context_datasets=[dataset],
                preview_limit=100,
            )

        self.assertEqual(raised.exception.code, "SQL_STORAGE_ERROR")

    def test_remote_dataset_without_parquet_fails_instead_of_falling_back(self) -> None:
        client = FakeS3Client({})

        with (
            patch.object(sql_service, "build_sql_preview_s3_client", return_value=client),
            patch.dict(os.environ, {"MINIO_BUCKET": "asklake-output"}, clear=False),
            self.assertRaises(ApiError) as raised,
        ):
            sql_service.execute_duckdb_preview(
                'SELECT * FROM "remote_table"',
                context_datasets=[self.remote_dataset()],
                preview_limit=100,
            )

        self.assertEqual(raised.exception.code, "SQL_STORAGE_ERROR")
        self.assertIn("does not contain Parquet", raised.exception.message)

    def test_remote_dataset_over_preview_budget_fails_before_download(self) -> None:
        object_key = "remote_table/silver/run_1/part-00000.parquet"
        client = FakeS3Client(
            {object_key: self.parquet_path},
            reported_sizes={object_key: 1024},
        )

        with (
            patch.object(sql_service, "build_sql_preview_s3_client", return_value=client),
            patch.dict(
                os.environ,
                {
                    "ASKLAKE_SQL_PREVIEW_MAX_REMOTE_BYTES": "128",
                    "MINIO_BUCKET": "asklake-output",
                },
                clear=False,
            ),
            self.assertRaises(ApiError) as raised,
        ):
            sql_service.execute_duckdb_preview(
                'SELECT * FROM "remote_table"',
                context_datasets=[self.remote_dataset()],
                preview_limit=100,
            )

        self.assertEqual(raised.exception.code, sql_service.ErrorCode.VALIDATION_ERROR)
        self.assertEqual(client.downloaded_keys, [])

    def test_remote_active_segments_share_one_cumulative_download_budget(self) -> None:
        snapshot_key = "remote_table/silver/snapshot/part-00000.parquet"
        delta_key = "remote_table/silver/delta/part-00000.parquet"
        client = FakeS3Client(
            {
                snapshot_key: self.parquet_path,
                delta_key: self.parquet_path,
            },
            reported_sizes={
                snapshot_key: 80,
                delta_key: 80,
            },
        )

        with (
            patch.object(sql_service, "build_sql_preview_s3_client", return_value=client),
            patch.dict(
                os.environ,
                {
                    "ASKLAKE_SQL_PREVIEW_MAX_REMOTE_BYTES": "128",
                    "MINIO_BUCKET": "asklake-output",
                },
                clear=False,
            ),
            self.assertRaises(ApiError) as raised,
        ):
            sql_service.execute_duckdb_preview(
                'SELECT * FROM "remote_table"',
                context_datasets=[self.remote_materialized_dataset()],
                preview_limit=100,
            )

        self.assertEqual(raised.exception.code, sql_service.ErrorCode.VALIDATION_ERROR)
        self.assertEqual(raised.exception.details["requestedBytes"], 160)
        self.assertEqual(client.downloaded_keys, [])
