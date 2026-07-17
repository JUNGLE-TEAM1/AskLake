from unittest import TestCase

from app.core.config import Settings
from app.services.trino_result_storage import TrinoResultStorage


class BucketProbeClient:
    def __init__(self) -> None:
        self.head_bucket_calls: list[str] = []

    def head_bucket(self, *, Bucket: str) -> None:
        self.head_bucket_calls.append(Bucket)


class TrinoResultStorageAwsContractTests(TestCase):
    def test_precreated_aws_bucket_does_not_require_bucket_wide_head(self) -> None:
        client = BucketProbeClient()
        storage = TrinoResultStorage(Settings(
            _env_file=None,
            asklake_object_storage_provider="aws",
            trino_result_storage_auto_create_bucket=False,
            trino_result_storage_bucket="asklake-query-results",
            trino_result_storage_prefix="query-results",
        ))
        storage.client = client

        storage._ensure_bucket()

        self.assertTrue(storage._bucket_ready)
        self.assertEqual(client.head_bucket_calls, [])

    def test_local_storage_keeps_bucket_probe(self) -> None:
        client = BucketProbeClient()
        storage = TrinoResultStorage(Settings(
            _env_file=None,
            asklake_object_storage_provider="minio",
            minio_access_key="local-access",
            minio_endpoint="http://127.0.0.1:9000",
            minio_secret_key="local-secret",
            trino_result_storage_auto_create_bucket=False,
            trino_result_storage_bucket="asklake-query-results",
            trino_result_storage_prefix="query-results",
        ))
        storage.client = client

        storage._ensure_bucket()

        self.assertTrue(storage._bucket_ready)
        self.assertEqual(client.head_bucket_calls, ["asklake-query-results"])
