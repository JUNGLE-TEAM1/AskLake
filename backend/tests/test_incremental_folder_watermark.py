import unittest
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import Mock, patch

from app.core.errors import ApiError
from app.services.etl_service import (
    incremental_source_object_keys,
    list_incremental_s3_object_keys,
    source_incremental_since,
    source_incremental_window,
)


def incremental_job() -> SimpleNamespace:
    return SimpleNamespace(
        dataset_id="dataset-1",
        id="job-1",
        source_config=[
            ["Collection Scope", "folder"],
            ["Collection Mode", "incremental"],
        ],
        source_type="File / S3 JSONL",
    )


def catalog_dataset(runs: list[dict[str, object]]) -> SimpleNamespace:
    return SimpleNamespace(payload={"materializationRuns": runs})


class IncrementalFolderWatermarkTests(unittest.TestCase):
    def test_uses_previous_bounded_window_upper_as_next_lower(self) -> None:
        job = incremental_job()
        previous = SimpleNamespace(run_id="previous", status="success", started_at="2026-07-11T10:00:00Z")
        dataset = catalog_dataset([{
            "runId": "previous",
            "status": "success",
            "materializationMode": "snapshot",
            "sourceWindow": {
                "contractVersion": 1,
                "lowerBound": None,
                "objectKeys": ["reviews/a.jsonl"],
                "upperBound": "2026-07-11T10:00:00Z",
            },
        }])
        with (
            patch("app.services.etl_service.etl_repository.list_run_models_for_job", return_value=[previous]),
            patch("app.services.etl_service.etl_repository.get_dataset_by_id", return_value=dataset),
        ):
            watermark = source_incremental_since(object(), job, "current")

        self.assertEqual(watermark, "2026-07-11T10:00:00Z")

    def test_empty_object_inventory_is_still_a_valid_checkpoint(self) -> None:
        job = incremental_job()
        previous = SimpleNamespace(run_id="previous", status="success", started_at="2026-07-11T10:00:00Z")
        dataset = catalog_dataset([{
            "runId": "previous",
            "status": "success",
            "sourceWindow": {
                "contractVersion": 1,
                "objectKeys": [],
                "upperBound": "2026-07-11T10:00:00Z",
            },
        }])
        with (
            patch("app.services.etl_service.etl_repository.list_run_models_for_job", return_value=[previous]),
            patch("app.services.etl_service.etl_repository.get_dataset_by_id", return_value=dataset),
        ):
            watermark = source_incremental_since(object(), job, "current")

        self.assertEqual(watermark, "2026-07-11T10:00:00Z")

    def test_legacy_success_requires_full_rebaseline(self) -> None:
        job = incremental_job()
        previous = SimpleNamespace(run_id="legacy", status="success", started_at="2026-07-11T10:00:00Z")
        dataset = catalog_dataset([{
            "runId": "legacy",
            "status": "success",
            "sourceWindow": {"contractVersion": 1, "upperBound": "2026-07-11T10:00:00Z"},
        }])
        with (
            patch("app.services.etl_service.etl_repository.list_run_models_for_job", return_value=[previous]),
            patch("app.services.etl_service.etl_repository.get_dataset_by_id", return_value=dataset),
        ):
            watermark = source_incremental_since(object(), job, "current")

        self.assertIsNone(watermark)

    def test_window_uses_current_run_start_as_fixed_upper_bound(self) -> None:
        job = incremental_job()
        previous = SimpleNamespace(run_id="previous", status="success", started_at="2026-07-11T10:00:00Z")
        current = SimpleNamespace(run_id="current", status="running", started_at="2026-07-11T11:00:00Z")
        dataset = catalog_dataset([{
            "runId": "previous",
            "status": "success",
            "sourceWindow": {
                "contractVersion": 1,
                "objectKeys": ["reviews/a.jsonl"],
                "upperBound": "2026-07-11T10:00:00Z",
            },
        }])
        with (
            patch("app.services.etl_service.etl_repository.list_run_models_for_job", return_value=[current, previous]),
            patch("app.services.etl_service.etl_repository.get_run_model", return_value=current),
            patch("app.services.etl_service.etl_repository.get_dataset_by_id", return_value=dataset),
        ):
            lower, upper = source_incremental_window(object(), job, "current")

        self.assertEqual(lower, "2026-07-11T10:00:00Z")
        self.assertEqual(upper, "2026-07-11T11:00:00Z")

    def test_inventory_uses_lower_inclusive_upper_exclusive_window(self) -> None:
        job = incremental_job()
        job.source_config.extend([
            ["Bucket / Stage Name", "m3-raw"],
            ["Path / Prefix", "reviews/"],
            ["File Pattern", "*.jsonl"],
        ])
        client = SimpleNamespace(list_objects_v2=lambda **_request: {
            "Contents": [
                {"Key": "reviews/before.jsonl", "LastModified": datetime(2026, 7, 11, 9, 59, 59, tzinfo=UTC)},
                {"Key": "reviews/lower.jsonl", "LastModified": datetime(2026, 7, 11, 10, 0, tzinfo=UTC)},
                {"Key": "reviews/inside.jsonl", "LastModified": datetime(2026, 7, 11, 10, 30, tzinfo=UTC)},
                {"Key": "reviews/upper.jsonl", "LastModified": datetime(2026, 7, 11, 11, 0, tzinfo=UTC)},
                {"Key": "reviews/ignored.csv", "LastModified": datetime(2026, 7, 11, 10, 30, tzinfo=UTC)},
            ],
            "IsTruncated": False,
        })

        keys = list_incremental_s3_object_keys(
            job,
            incremental_since="2026-07-11T10:00:00Z",
            incremental_before="2026-07-11T11:00:00Z",
            s3_client=client,
        )

        self.assertEqual(keys, ["reviews/inside.jsonl", "reviews/lower.jsonl"])

    def test_inventory_validates_policy_before_calling_supplied_client(self) -> None:
        job = incremental_job()
        job.source_config.extend([
            ["Bucket / Stage Name", "m3-raw"],
            ["Path / Prefix", "reviews/"],
            ["Endpoint URL", "http://169.254.169.254"],
        ])
        supplied_client = Mock()
        environment = {
            "S3_ALLOWED_BUCKETS": "m3-raw",
            "S3_ALLOWED_ENDPOINTS": "http://minio:9000",
        }
        with (
            patch.dict("os.environ", environment, clear=True),
            patch("app.services.etl_service.settings", SimpleNamespace(app_env="production")),
        ):
            with self.assertRaises(ApiError) as raised:
                list_incremental_s3_object_keys(
                    job,
                    incremental_since=None,
                    incremental_before="2026-07-11T11:00:00Z",
                    s3_client=supplied_client,
                )

        self.assertEqual(raised.exception.status_code, 403)
        supplied_client.list_objects_v2.assert_not_called()

    def test_non_recursive_inventory_excludes_nested_descendants(self) -> None:
        job = incremental_job()
        job.source_config.extend([
            ["Bucket / Stage Name", "m3-raw"],
            ["Path / Prefix", "reviews"],
            ["Recursive", "false"],
        ])
        client = Mock()
        client.list_objects_v2.return_value = {
            "Contents": [
                {"Key": "reviews/direct.jsonl", "LastModified": datetime(2026, 7, 11, 10, 30, tzinfo=UTC)},
                {"Key": "reviews/nested/descendant.jsonl", "LastModified": datetime(2026, 7, 11, 10, 30, tzinfo=UTC)},
            ],
            "IsTruncated": False,
        }

        keys = list_incremental_s3_object_keys(
            job,
            incremental_since=None,
            incremental_before="2026-07-11T11:00:00Z",
            s3_client=client,
        )

        self.assertEqual(keys, ["reviews/direct.jsonl"])
        client.list_objects_v2.assert_called_once_with(Bucket="m3-raw", Delimiter="/", Prefix="reviews/")

    def test_recursive_inventory_keeps_nested_descendants(self) -> None:
        job = incremental_job()
        job.source_config.extend([
            ["Bucket / Stage Name", "m3-raw"],
            ["Path / Prefix", "reviews/"],
            ["Recursive", "true"],
        ])
        client = Mock()
        client.list_objects_v2.return_value = {
            "Contents": [
                {"Key": "reviews/direct.jsonl", "LastModified": datetime(2026, 7, 11, 10, 30, tzinfo=UTC)},
                {"Key": "reviews/nested/descendant.jsonl", "LastModified": datetime(2026, 7, 11, 10, 30, tzinfo=UTC)},
            ],
            "IsTruncated": False,
        }

        keys = list_incremental_s3_object_keys(
            job,
            incremental_since=None,
            incremental_before="2026-07-11T11:00:00Z",
            s3_client=client,
        )

        self.assertEqual(keys, ["reviews/direct.jsonl", "reviews/nested/descendant.jsonl"])
        client.list_objects_v2.assert_called_once_with(Bucket="m3-raw", Prefix="reviews/")

    def test_truncated_inventory_without_token_fails_closed(self) -> None:
        job = incremental_job()
        job.source_config.extend([["Bucket / Stage Name", "m3-raw"], ["Path / Prefix", "reviews/"]])
        client = Mock()
        client.list_objects_v2.return_value = {"Contents": [], "IsTruncated": True}

        with self.assertRaises(ApiError) as raised:
            list_incremental_s3_object_keys(
                job,
                incremental_since=None,
                incremental_before="2026-07-11T11:00:00Z",
                s3_client=client,
            )

        self.assertEqual(raised.exception.status_code, 503)

    def test_modified_existing_object_key_is_blocked_before_spark(self) -> None:
        job = incremental_job()
        with (
            patch("app.services.etl_service.list_incremental_s3_object_keys", return_value=["reviews/existing.jsonl"]),
            patch("app.services.etl_service.prior_incremental_source_object_keys", return_value={"reviews/existing.jsonl"}),
        ):
            with self.assertRaises(ApiError) as raised:
                incremental_source_object_keys(
                    object(),
                    job,
                    incremental_since="2026-07-11T10:00:00Z",
                    incremental_before="2026-07-11T11:00:00Z",
                )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.code, "SOURCE_OBJECT_KEY_REPLACED")


if __name__ == "__main__":
    unittest.main()
