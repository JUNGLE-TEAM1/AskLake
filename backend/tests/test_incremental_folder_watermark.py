import unittest
from datetime import UTC, datetime
from threading import Lock
import time
from types import SimpleNamespace
from unittest.mock import Mock, patch

from app.core.errors import ApiError
from app.services.etl_service import (
    incremental_source_object_keys,
    list_incremental_s3_object_inventory,
    list_incremental_s3_object_keys,
    source_incremental_since,
    source_incremental_window,
)


def s3_object(key: str, modified_at: datetime, *, size: int = 10, e_tag: str | None = None) -> dict[str, object]:
    return {
        "ETag": f'"{e_tag or f"etag-{key}"}"',
        "Key": key,
        "LastModified": modified_at,
        "Size": size,
    }


def s3_inventory_client(
    contents: list[dict[str, object]],
    *,
    head_overrides: dict[str, dict[str, object]] | None = None,
    version_ids: dict[str, str] | None = None,
) -> Mock:
    client = Mock()
    client.list_objects_v2.return_value = {"Contents": contents, "IsTruncated": False}
    by_key = {str(item["Key"]): item for item in contents}

    def head_object(*, Bucket: str, Key: str) -> dict[str, object]:
        del Bucket
        item = by_key[Key]
        response: dict[str, object] = {
            "ContentLength": item["Size"],
            "ETag": item["ETag"],
            "LastModified": item["LastModified"],
        }
        if version_ids and Key in version_ids:
            response["VersionId"] = version_ids[Key]
        response.update((head_overrides or {}).get(Key, {}))
        return response

    client.head_object.side_effect = head_object
    return client


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
        client = s3_inventory_client([
            s3_object("reviews/before.jsonl", datetime(2026, 7, 11, 9, 59, 59, tzinfo=UTC)),
            s3_object("reviews/lower.jsonl", datetime(2026, 7, 11, 10, 0, tzinfo=UTC)),
            s3_object("reviews/inside.jsonl", datetime(2026, 7, 11, 10, 30, tzinfo=UTC)),
            s3_object("reviews/upper.jsonl", datetime(2026, 7, 11, 11, 0, tzinfo=UTC)),
            s3_object("reviews/ignored.csv", datetime(2026, 7, 11, 10, 30, tzinfo=UTC)),
        ])

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
        client = s3_inventory_client([
            s3_object("reviews/direct.jsonl", datetime(2026, 7, 11, 10, 30, tzinfo=UTC)),
            s3_object("reviews/nested/descendant.jsonl", datetime(2026, 7, 11, 10, 30, tzinfo=UTC)),
        ])

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
        client = s3_inventory_client([
            s3_object("reviews/direct.jsonl", datetime(2026, 7, 11, 10, 30, tzinfo=UTC)),
            s3_object("reviews/nested/descendant.jsonl", datetime(2026, 7, 11, 10, 30, tzinfo=UTC)),
        ])

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
            patch("app.services.etl_service.list_incremental_s3_object_inventory", return_value=[{
                "key": "reviews/existing.jsonl",
                "eTag": "etag-existing",
                "versionId": None,
                "lastModified": "2026-07-11T10:30:00.000Z",
                "size": 10,
            }]),
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

    def test_inventory_persists_head_identity_and_version_id(self) -> None:
        job = incremental_job()
        job.source_config.extend([
            ["Bucket / Stage Name", "m3-raw"],
            ["Path / Prefix", "reviews/"],
        ])
        modified_at = datetime(2026, 7, 11, 10, 30, tzinfo=UTC)
        client = s3_inventory_client(
            [s3_object("reviews/versioned.jsonl", modified_at, size=27, e_tag="etag-v1")],
            version_ids={"reviews/versioned.jsonl": "version-123"},
        )

        inventory = list_incremental_s3_object_inventory(
            job,
            incremental_since=None,
            incremental_before="2026-07-11T11:00:00Z",
            s3_client=client,
        )

        self.assertEqual(inventory, [{
            "key": "reviews/versioned.jsonl",
            "eTag": "etag-v1",
            "versionId": "version-123",
            "lastModified": "2026-07-11T10:30:00.000Z",
            "size": 27,
        }])
        client.head_object.assert_called_once_with(Bucket="m3-raw", Key="reviews/versioned.jsonl")

    def test_replacement_between_list_and_head_fails_closed(self) -> None:
        job = incremental_job()
        job.source_config.extend([
            ["Bucket / Stage Name", "m3-raw"],
            ["Path / Prefix", "reviews/"],
        ])
        modified_at = datetime(2026, 7, 11, 10, 30, tzinfo=UTC)
        client = s3_inventory_client(
            [s3_object("reviews/replaced.jsonl", modified_at, e_tag="etag-before")],
            head_overrides={"reviews/replaced.jsonl": {"ETag": '"etag-after"'}},
        )

        with self.assertRaises(ApiError) as raised:
            list_incremental_s3_object_inventory(
                job,
                incremental_since=None,
                incremental_before="2026-07-11T11:00:00Z",
                s3_client=client,
            )

        self.assertEqual(raised.exception.code, "SOURCE_OBJECT_IDENTITY_CHANGED")
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.details["mismatchFields"], ["eTag"])

    def test_head_identity_checks_use_bounded_concurrency_and_keep_key_order(self) -> None:
        job = incremental_job()
        job.source_config.extend([
            ["Bucket / Stage Name", "m3-raw"],
            ["Path / Prefix", "reviews/"],
        ])
        modified_at = datetime(2026, 7, 11, 10, 30, tzinfo=UTC)
        contents = [
            s3_object(f"reviews/{index}.jsonl", modified_at, e_tag=f"etag-{index}")
            for index in range(6)
        ]
        client = s3_inventory_client(contents)
        original_head = client.head_object.side_effect
        lock = Lock()
        active = 0
        max_active = 0

        def tracked_head(**kwargs):
            nonlocal active, max_active
            with lock:
                active += 1
                max_active = max(max_active, active)
            try:
                time.sleep(0.03)
                return original_head(**kwargs)
            finally:
                with lock:
                    active -= 1

        client.head_object.side_effect = tracked_head
        with patch.dict("os.environ", {"ASKLAKE_SOURCE_IDENTITY_WORKERS": "3"}, clear=False):
            inventory = list_incremental_s3_object_inventory(
                job,
                incremental_since=None,
                incremental_before="2026-07-11T11:00:00Z",
                s3_client=client,
            )

        self.assertEqual([item["key"] for item in inventory], sorted(item["Key"] for item in contents))
        self.assertGreater(max_active, 1)
        self.assertLessEqual(max_active, 3)


if __name__ == "__main__":
    unittest.main()
