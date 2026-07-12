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

    def list_objects_v2(self, **_: object) -> dict[str, object]:
        return {
            "Contents": [
                {
                    "Key": key,
                    "Size": self.reported_sizes.get(key, source.stat().st_size),
                }
                for key, source in self.objects.items()
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

    def remote_dataset(self) -> SimpleNamespace:
        return SimpleNamespace(
            id="ds_remote_table",
            name="remote_table",
            sample_rows=[],
            schema_=[],
            storage_format="parquet",
            storage_location="s3a://asklake-output/remote_table/silver/run_1",
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

    def test_sample_rows_preview_still_works(self) -> None:
        dataset = SimpleNamespace(
            id="ds_sample_table",
            name="sample_table",
            sample_rows=[["1", "alpha"], ["2", "beta"]],
            schema_=[["id", "integer"], ["label", "string"]],
            storage_format="",
            storage_location="",
        )

        result = sql_service.execute_duckdb_preview(
            'SELECT COUNT(*) AS row_count FROM "sample_table"',
            context_datasets=[dataset],
            preview_limit=100,
        )

        self.assertEqual(result["rows"], [["2"]])

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
