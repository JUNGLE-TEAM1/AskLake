import os
from unittest import TestCase
from unittest.mock import patch

from app.core.config import Settings
from app.core.errors import ApiError
from app.services.dashboard_physical_data import configure_duckdb_s3
from app.services.object_storage import object_storage_runtime
from app.services import trino_result_storage
from app.services.trino_result_storage import TrinoResultStorage
from scripts.object_storage_runtime import (
    AWS_ENV_AND_INSTANCE_PROVIDERS,
    MINIO_SIMPLE_PROVIDER,
    configure_spark_builder,
)


class FakeSparkBuilder:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}

    def config(self, name: str, value: str):
        self.values[name] = value
        return self


class FakeDuckDbConnection:
    def __init__(self) -> None:
        self.statements: list[str] = []

    def execute(self, statement: str):
        self.statements.append(statement)
        return self


class ObjectStorageModeTest(TestCase):
    def test_minio_runtime_keeps_endpoint_static_credentials_and_path_style(self) -> None:
        with patch.dict(
            os.environ,
            {
                "ASKLAKE_OBJECT_STORAGE_PROVIDER": "minio",
                "MINIO_ACCESS_KEY": "local-access",
                "MINIO_ENDPOINT": "http://127.0.0.1:9000",
                "MINIO_REGION": "us-east-1",
                "MINIO_SECRET_KEY": "local-secret",
            },
            clear=True,
        ):
            runtime = object_storage_runtime()
            builder = configure_spark_builder(FakeSparkBuilder())

        self.assertEqual(runtime.provider, "minio")
        self.assertEqual(runtime.endpoint, "http://127.0.0.1:9000")
        self.assertTrue(runtime.force_path_style)
        self.assertEqual(runtime.boto3_kwargs()["aws_access_key_id"], "local-access")
        self.assertEqual(builder.values["spark.hadoop.fs.s3a.aws.credentials.provider"], MINIO_SIMPLE_PROVIDER)
        self.assertEqual(builder.values["spark.hadoop.fs.s3a.path.style.access"], "true")

    def test_aws_runtime_uses_default_credential_chain_without_minio_values(self) -> None:
        with patch.dict(
            os.environ,
            {
                "ASKLAKE_OBJECT_STORAGE_PROVIDER": "aws",
                "AWS_REGION": "ap-northeast-2",
                "MINIO_ACCESS_KEY": "must-not-leak",
                "MINIO_ENDPOINT": "http://m3-minio:9000",
                "MINIO_SECRET_KEY": "must-not-leak",
            },
            clear=True,
        ):
            runtime = object_storage_runtime()
            builder = configure_spark_builder(FakeSparkBuilder())

        self.assertEqual(runtime.provider, "aws")
        self.assertIsNone(runtime.endpoint)
        self.assertFalse(runtime.force_path_style)
        self.assertEqual(runtime.boto3_kwargs(), {"region_name": "ap-northeast-2"})
        self.assertEqual(builder.values["spark.hadoop.fs.s3a.aws.credentials.provider"], AWS_ENV_AND_INSTANCE_PROVIDERS)
        self.assertEqual(builder.values["spark.hadoop.fs.s3a.path.style.access"], "false")
        self.assertNotIn("spark.hadoop.fs.s3a.endpoint", builder.values)
        self.assertNotIn("spark.hadoop.fs.s3a.access.key", builder.values)

    def test_duckdb_aws_mode_loads_credential_chain_secret(self) -> None:
        connection = FakeDuckDbConnection()
        with patch.dict(
            os.environ,
            {
                "ASKLAKE_OBJECT_STORAGE_PROVIDER": "aws",
                "AWS_REGION": "ap-northeast-2",
            },
            clear=True,
        ):
            configure_duckdb_s3(connection)

        statements = "\n".join(connection.statements)
        self.assertIn("LOAD httpfs", statements)
        self.assertIn("LOAD aws", statements)
        self.assertIn("PROVIDER credential_chain", statements)
        self.assertIn("REFRESH auto", statements)
        self.assertNotIn("s3_access_key_id", statements)

    def test_trino_result_storage_aws_client_uses_default_chain(self) -> None:
        runtime_settings = Settings(
            _env_file=None,
            asklake_object_storage_provider="aws",
            aws_region="ap-northeast-2",
            minio_access_key="must-not-leak",
            minio_endpoint="http://m3-minio:9000",
            minio_secret_key="must-not-leak",
            trino_result_storage_bucket="asklake-query-results",
        )
        with patch.object(trino_result_storage.boto3, "client", return_value=object()) as client:
            TrinoResultStorage(runtime_settings)._client()

        _, kwargs = client.call_args
        self.assertEqual(kwargs["region_name"], "ap-northeast-2")
        self.assertEqual(kwargs["config"].s3["addressing_style"], "auto")
        self.assertNotIn("endpoint_url", kwargs)
        self.assertNotIn("aws_access_key_id", kwargs)
        self.assertNotIn("aws_secret_access_key", kwargs)

    def test_trino_result_storage_rejects_static_keys_in_aws_mode(self) -> None:
        runtime_settings = Settings(
            _env_file=None,
            asklake_object_storage_provider="aws",
            trino_result_storage_access_key="static-access",
            trino_result_storage_secret_key="static-secret",
        )
        with self.assertRaises(ApiError) as raised:
            TrinoResultStorage(runtime_settings)._client()

        self.assertIn("default credential chain", raised.exception.message)
