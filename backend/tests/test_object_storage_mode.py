import os
from ast import Call, FunctionDef, Name, parse, walk
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from app.services.dashboard_physical_data import configure_duckdb_s3
from app.core.errors import ApiError
from app.services.object_storage import object_storage_runtime
from app.services.s3_browser_service import allowed_buckets
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
    def test_target_browser_prioritizes_the_spark_output_bucket(self) -> None:
        with patch.dict(
            os.environ,
            {
                "ASKLAKE_OBJECT_STORAGE_PROVIDER": "aws",
                "ASKLAKE_SPARK_OUTPUT_BUCKET": "asklake-dev-output-123-apne2",
                "S3_ALLOWED_BUCKETS": "asklake-dev-raw-123-apne2,asklake-dev-output-123-apne2",
            },
            clear=True,
        ):
            buckets = allowed_buckets()

        self.assertEqual(
            buckets,
            ["asklake-dev-output-123-apne2", "asklake-dev-raw-123-apne2"],
        )

    def test_target_browser_rejects_missing_aws_bucket_configuration(self) -> None:
        with patch.dict(
            os.environ,
            {"ASKLAKE_OBJECT_STORAGE_PROVIDER": "aws"},
            clear=True,
        ):
            with self.assertRaises(ApiError) as raised:
                allowed_buckets()

        self.assertEqual(raised.exception.code, "SERVICE_UNAVAILABLE")
        self.assertEqual(raised.exception.status_code, 503)

    def test_target_browser_keeps_the_local_minio_default(self) -> None:
        with patch.dict(
            os.environ,
            {"ASKLAKE_OBJECT_STORAGE_PROVIDER": "minio"},
            clear=True,
        ):
            buckets = allowed_buckets()

        self.assertEqual(buckets, ["asklake-output"])

    def test_spark_etl_entrypoint_uses_provider_aware_builder(self) -> None:
        source = (
            Path(__file__).parents[1] / "scripts" / "runtime" / "spark_job_runtime.py"
        ).read_text(encoding="utf-8")
        tree = parse(source)
        make_spark = next(
            node for node in tree.body if isinstance(node, FunctionDef) and node.name == "make_spark"
        )
        called_names = {
            node.func.id
            for node in walk(make_spark)
            if isinstance(node, Call) and isinstance(node.func, Name)
        }

        self.assertIn("configure_spark_builder", called_names)
        self.assertNotIn("SimpleAWSCredentialsProvider", source[source.index("def make_spark"):])

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
