import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.services.etl_service import source_incremental_since, source_incremental_window


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
        previous = SimpleNamespace(
            run_id="previous",
            status="success",
            started_at="2026-07-11T10:00:00Z",
        )
        dataset = catalog_dataset([{
            "runId": "previous",
            "status": "success",
            "materializationMode": "snapshot",
            "sourceWindow": {
                "contractVersion": 1,
                "lowerBound": None,
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
        previous = SimpleNamespace(
            run_id="legacy",
            status="success",
            started_at="2026-07-11T10:00:00Z",
        )
        dataset = catalog_dataset([{
            "runId": "legacy",
            "status": "success",
        }])
        with (
            patch("app.services.etl_service.etl_repository.list_run_models_for_job", return_value=[previous]),
            patch("app.services.etl_service.etl_repository.get_dataset_by_id", return_value=dataset),
        ):
            watermark = source_incremental_since(object(), job, "current")

        self.assertIsNone(watermark)

    def test_first_run_has_no_lower_bound(self) -> None:
        job = incremental_job()
        with patch("app.services.etl_service.etl_repository.list_run_models_for_job", return_value=[]):
            watermark = source_incremental_since(object(), job, "current")

        self.assertIsNone(watermark)

    def test_window_uses_current_run_start_as_fixed_upper_bound(self) -> None:
        job = incremental_job()
        previous = SimpleNamespace(
            run_id="previous",
            status="success",
            started_at="2026-07-11T10:00:00Z",
        )
        current = SimpleNamespace(
            run_id="current",
            status="running",
            started_at="2026-07-11T11:00:00Z",
        )
        dataset = catalog_dataset([{
            "runId": "previous",
            "status": "success",
            "sourceWindow": {
                "contractVersion": 1,
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

    def test_single_file_source_does_not_receive_incremental_window(self) -> None:
        job = incremental_job()
        job.source_config = [["Collection Scope", "file"]]

        self.assertEqual(source_incremental_window(object(), job, "current"), (None, None))


if __name__ == "__main__":
    unittest.main()
