import os
import unittest
from unittest.mock import patch

from app.core.errors import ApiError
from app.core.s3_policy import resolve_s3_source_location, validate_s3_source_config


class S3SourcePolicyTests(unittest.TestCase):
    def test_rejects_source_bucket_outside_allowlist(self) -> None:
        with patch.dict(os.environ, {"S3_ALLOWED_BUCKETS": "m3-raw", "S3_ENDPOINT": "http://minio:9000"}, clear=True):
            with self.assertRaises(ApiError) as raised:
                validate_s3_source_config(
                    "File / S3 JSONL",
                    [("Bucket / Stage Name", "private-bucket")],
                    allow_unconfigured=False,
                )

        self.assertEqual(raised.exception.status_code, 403)

    def test_resolves_source_defaults_used_by_spark(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(resolve_s3_source_location("File / S3", []), ("m3-raw", ""))
            self.assertEqual(
                resolve_s3_source_location("Data Lake", []),
                ("m3-raw", "nyc_taxi/yellow_parquet/"),
            )

    def test_allows_native_aws_s3_without_a_custom_endpoint(self) -> None:
        with patch.dict(os.environ, {
            "ASKLAKE_OBJECT_STORAGE_PROVIDER": "aws",
            "AWS_REGION": "ap-northeast-2",
            "S3_ALLOWED_BUCKETS": "m3-raw",
            "S3_FORCE_PATH_STYLE": "false",
        }, clear=True):
            validate_s3_source_config(
                "File / S3",
                [
                    ("Bucket / Stage Name", "m3-raw"),
                    ("Path / Prefix", "dataset/input.jsonl"),
                    ("Endpoint URL", ""),
                ],
                allow_unconfigured=False,
            )

    def test_rejects_custom_endpoint_when_endpoint_allowlist_is_missing(self) -> None:
        with patch.dict(os.environ, {
            "S3_ALLOWED_BUCKETS": "m3-raw",
        }, clear=True):
            with self.assertRaises(ApiError) as raised:
                validate_s3_source_config(
                    "File / S3",
                    [
                        ("Bucket / Stage Name", "m3-raw"),
                        ("Endpoint URL", "http://minio:9000"),
                    ],
                    allow_unconfigured=False,
                )

        self.assertEqual(raised.exception.status_code, 503)

    def test_rejects_unconfigured_source_endpoint_in_production(self) -> None:
        with patch.dict(os.environ, {
            "S3_ALLOWED_BUCKETS": "m3-raw",
            "S3_ALLOWED_ENDPOINTS": "http://minio:9000",
        }, clear=True):
            with self.assertRaises(ApiError) as raised:
                validate_s3_source_config(
                    "File / S3",
                    [
                        ("Bucket / Stage Name", "m3-raw"),
                        ("Endpoint URL", "http://169.254.169.254"),
                    ],
                    allow_unconfigured=False,
                )

        self.assertEqual(raised.exception.status_code, 403)

    def test_rejects_source_path_bucket_mismatch(self) -> None:
        with patch.dict(os.environ, {"S3_ALLOWED_BUCKETS": "m3-raw", "S3_ENDPOINT": "http://minio:9000"}, clear=True):
            with self.assertRaises(ApiError) as raised:
                validate_s3_source_config(
                    "File / S3",
                    [
                        ("Bucket / Stage Name", "m3-raw"),
                        ("Path / Prefix", "s3a://private-bucket/secret/"),
                    ],
                    allow_unconfigured=False,
                )

        self.assertEqual(raised.exception.status_code, 422)
        self.assertEqual(raised.exception.details["declaredBucket"], "m3-raw")
        self.assertEqual(raised.exception.details["pathBucket"], "private-bucket")


if __name__ == "__main__":
    unittest.main()
