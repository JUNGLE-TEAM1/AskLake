import os
import unittest
from unittest.mock import patch

from app.core.errors import ApiError
from app.core.s3_policy import validate_s3_source_config, validate_s3_target_path


class S3TargetPolicyTests(unittest.TestCase):
    def test_allows_configured_s3a_bucket(self) -> None:
        with patch.dict(os.environ, {"S3_ALLOWED_BUCKETS": "m3-raw,asklake-output"}):
            validate_s3_target_path(
                "S3",
                "s3a://asklake-output/gold/reviews/",
                allow_unconfigured=False,
            )

    def test_rejects_target_bucket_outside_allowlist(self) -> None:
        with patch.dict(os.environ, {"S3_ALLOWED_BUCKETS": "asklake-output"}):
            with self.assertRaises(ApiError) as raised:
                validate_s3_target_path(
                    "S3",
                    "s3a://private-bucket/gold/reviews/",
                    allow_unconfigured=False,
                )

        self.assertEqual(raised.exception.status_code, 403)

    def test_production_requires_allowlist(self) -> None:
        with patch.dict(os.environ, {"S3_ALLOWED_BUCKETS": ""}):
            with self.assertRaises(ApiError) as raised:
                validate_s3_target_path(
                    "S3",
                    "s3a://asklake-output/gold/reviews/",
                    allow_unconfigured=False,
                )

        self.assertEqual(raised.exception.status_code, 503)

    def test_rejects_non_s3_scheme_for_s3_storage(self) -> None:
        with patch.dict(os.environ, {"S3_ALLOWED_BUCKETS": "asklake-output"}):
            with self.assertRaises(ApiError) as raised:
                validate_s3_target_path(
                    "S3",
                    "file:///tmp/output",
                    allow_unconfigured=False,
                )

        self.assertEqual(raised.exception.status_code, 422)

    def test_rejects_source_bucket_outside_allowlist(self) -> None:
        with patch.dict(os.environ, {"S3_ALLOWED_BUCKETS": "m3-raw"}):
            with self.assertRaises(ApiError) as raised:
                validate_s3_source_config(
                    "File / S3 JSONL",
                    [("Bucket / Stage Name", "private-bucket")],
                    allow_unconfigured=False,
                )

        self.assertEqual(raised.exception.status_code, 403)

    def test_validates_data_lake_bucket_from_path(self) -> None:
        with patch.dict(os.environ, {"S3_ALLOWED_BUCKETS": "m3-raw"}):
            validate_s3_source_config(
                "Data Lake Parquet",
                [("Path", "s3a://m3-raw/amazon/reviews/")],
                allow_unconfigured=False,
            )


if __name__ == "__main__":
    unittest.main()
