import unittest
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import patch

from app.services.etl_service import (
    ScheduledJobOccurrenceAlreadyClaimed,
    next_scheduled_run_utc_for_schedule,
    run_due_scheduled_jobs,
    schedule_policy_from_request,
    should_run_scheduled_job,
)
from app.schemas.etl import JobCommandResponse


class SchedulingTests(unittest.TestCase):
    def test_daily_schedule_is_converted_from_seoul_to_utc(self) -> None:
        next_run = next_scheduled_run_utc_for_schedule(
            "매일 09:00",
            "Asia/Seoul",
            now=datetime(2026, 7, 13, 23, 0, tzinfo=UTC),
        )
        self.assertEqual(next_run, "2026-07-14T00:00:00Z")

    def test_weekday_custom_cron_skips_weekend(self) -> None:
        next_run = next_scheduled_run_utc_for_schedule(
            "커스텀: 0 10 * * 1-5",
            "Asia/Seoul",
            now=datetime(2026, 7, 12, 0, 0, tzinfo=UTC),
        )
        self.assertEqual(next_run, "2026-07-13T01:00:00Z")

    def test_create_request_without_next_run_gets_one_from_schedule(self) -> None:
        request = SimpleNamespace(
            end_date=None,
            next_run_utc=None,
            overlap_policy=None,
            schedule_label="매시간 15분",
            start_date=None,
            timezone="Asia/Seoul",
            watermark_policy=None,
        )
        policy = schedule_policy_from_request(request)
        self.assertTrue(policy["nextRunUtc"])
        self.assertEqual(policy["timezone"], "Asia/Seoul")

    def test_due_job_is_triggerable_when_next_run_is_past(self) -> None:
        job = SimpleNamespace(
            id="job-1",
            status="scheduled",
            schedule="매일 09:00",
            schedule_policy={"nextRunUtc": "2020-01-01T00:00:00Z"},
        )
        should_run, reason = should_run_scheduled_job(job, SimpleNamespace(force=False, job_id=None, kafka_only=False))
        self.assertTrue(should_run)
        self.assertEqual(reason, "due")

    def test_due_tick_passes_the_preloaded_occurrence_to_the_locked_command(self) -> None:
        job = SimpleNamespace(
            id="job-1",
            name="Daily job",
            status="scheduled",
            schedule="매일 09:00",
            schedule_policy={"nextRunUtc": "2020-01-01T00:00:00Z", "timezone": "Asia/Seoul"},
        )
        request = SimpleNamespace(force=False, job_id=None, kafka_only=False)
        with (
            patch("app.services.etl_service.etl_repository.list_job_models", return_value=[job]),
            patch(
                "app.services.etl_service.command_job",
                return_value=JobCommandResponse(action="etl.run.requested", api_path="/api/etl/jobs/job-1/commands"),
            ) as command,
        ):
            response = run_due_scheduled_jobs(object(), request)

        self.assertEqual(response.triggered_count, 1)
        command.assert_called_once_with(
            unittest.mock.ANY,
            "job-1",
            "run",
            unittest.mock.ANY,
            scheduled_due_at="2020-01-01T00:00:00Z",
        )

    def test_claimed_occurrence_does_not_abort_other_due_jobs(self) -> None:
        jobs = [
            SimpleNamespace(
                id="job-1",
                name="Claimed job",
                status="scheduled",
                schedule="매일 09:00",
                schedule_policy={"nextRunUtc": "2020-01-01T00:00:00Z", "timezone": "Asia/Seoul"},
            ),
            SimpleNamespace(
                id="job-2",
                name="Runnable job",
                status="scheduled",
                schedule="매일 10:00",
                schedule_policy={"nextRunUtc": "2020-01-01T01:00:00Z", "timezone": "Asia/Seoul"},
            ),
        ]
        db = unittest.mock.Mock()
        request = SimpleNamespace(force=False, job_id=None, kafka_only=False)
        with (
            patch("app.services.etl_service.etl_repository.list_job_models", return_value=jobs),
            patch(
                "app.services.etl_service.command_job",
                side_effect=[
                    ScheduledJobOccurrenceAlreadyClaimed("job-1"),
                    JobCommandResponse(action="etl.run.requested", api_path="/api/etl/jobs/job-2/commands"),
                ],
            ),
        ):
            response = run_due_scheduled_jobs(db, request)

        self.assertEqual(response.checked_count, 2)
        self.assertEqual(response.triggered_count, 1)
        self.assertEqual([item.reason for item in response.items], ["already_claimed", "due"])
        db.rollback.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
