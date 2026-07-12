import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import create_app


class FakeS3Client:
    def list_buckets(self):
        return {"Buckets": [{"Name": "m3-raw"}, {"Name": "private"}]}

    def list_objects_v2(self, **request):
        self.request = request
        return {
            "CommonPrefixes": [{"Prefix": "amazon/reviews/"}],
            "Contents": [{"Key": "amazon/phones.jsonl"}],
            "IsTruncated": False,
        }


class S3ApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = FakeS3Client()
        self.test_client = TestClient(create_app())

    def test_lists_only_configured_buckets(self) -> None:
        with (
            patch.dict(os.environ, {"S3_ALLOWED_BUCKETS": "m3-raw"}),
            patch("app.api.s3.build_catalog_s3_client", return_value=self.client),
        ):
            response = self.test_client.get("/api/s3/buckets")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"buckets": ["m3-raw"]})

    def test_lists_prefixes_with_frontend_contract(self) -> None:
        with (
            patch.dict(os.environ, {"S3_ALLOWED_BUCKETS": "m3-raw"}),
            patch("app.api.s3.build_catalog_s3_client", return_value=self.client),
        ):
            response = self.test_client.get("/api/s3/prefixes?bucket=m3-raw&prefix=amazon/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["folders"][0]["prefix"], "amazon/reviews/")
        self.assertEqual(response.json()["files"][0]["key"], "amazon/phones.jsonl")
        self.assertEqual(self.client.request["Delimiter"], "/")

    def test_rejects_bucket_outside_allowlist(self) -> None:
        with patch.dict(os.environ, {"S3_ALLOWED_BUCKETS": "m3-raw"}):
            response = self.test_client.get("/api/s3/prefixes?bucket=private&prefix=")

        self.assertEqual(response.status_code, 403)

    def test_normalizes_duplicate_prefix_separators(self) -> None:
        with (
            patch.dict(os.environ, {"S3_ALLOWED_BUCKETS": "m3-raw"}),
            patch("app.api.s3.build_catalog_s3_client", return_value=self.client),
        ):
            response = self.test_client.get("/api/s3/prefixes?bucket=m3-raw&prefix=/amazon//reviews/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.request["Prefix"], "amazon/reviews/")

    def test_rejects_parent_traversal_prefix(self) -> None:
        with patch.dict(os.environ, {"S3_ALLOWED_BUCKETS": "m3-raw"}):
            response = self.test_client.get("/api/s3/prefixes?bucket=m3-raw&prefix=amazon/../private/")

        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
