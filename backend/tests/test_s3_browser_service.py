from unittest import TestCase
from unittest.mock import Mock, patch

from app.services.s3_browser_service import list_s3_prefixes


class S3BrowserServiceTest(TestCase):
    def test_first_page_omits_continuation_token(self) -> None:
        client = Mock()
        client.list_objects_v2.return_value = {
            "CommonPrefixes": [],
            "Contents": [],
        }

        with (
            patch(
                "app.services.s3_browser_service.allowed_buckets",
                return_value=["asklake-output"],
            ),
            patch(
                "app.services.s3_browser_service._build_s3_client",
                return_value=client,
            ),
        ):
            response = list_s3_prefixes(
                bucket="asklake-output",
                continuation_token=None,
                prefix="",
            )

        client.list_objects_v2.assert_called_once_with(
            Bucket="asklake-output",
            Delimiter="/",
            Prefix="",
        )
        self.assertEqual(response.bucket, "asklake-output")
        self.assertEqual(response.prefix, "")
        self.assertEqual(response.files, [])
        self.assertEqual(response.folders, [])
        self.assertIsNone(response.next_continuation_token)

    def test_next_page_includes_string_continuation_token(self) -> None:
        client = Mock()
        client.list_objects_v2.return_value = {
            "CommonPrefixes": [
                {"Prefix": "customer_review_gold/archive/"},
            ],
            "Contents": [],
            "NextContinuationToken": "page-3",
        }

        with (
            patch(
                "app.services.s3_browser_service.allowed_buckets",
                return_value=["asklake-output"],
            ),
            patch(
                "app.services.s3_browser_service._build_s3_client",
                return_value=client,
            ),
        ):
            response = list_s3_prefixes(
                bucket="asklake-output",
                continuation_token="page-2",
                prefix="customer_review_gold",
            )

        client.list_objects_v2.assert_called_once_with(
            Bucket="asklake-output",
            ContinuationToken="page-2",
            Delimiter="/",
            Prefix="customer_review_gold/",
        )
        self.assertEqual(
            [folder.prefix for folder in response.folders],
            ["customer_review_gold/archive/"],
        )
        self.assertEqual(response.next_continuation_token, "page-3")
