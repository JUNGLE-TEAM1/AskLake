from __future__ import annotations

import unittest
from unittest.mock import patch

from app.application.etl_job_queries import EtlJobQueryHooks, get_job, list_jobs, list_job_statuses
from app.core.auth_context import ActorContext
from app.core.errors import ApiError
from app.schemas.etl import JobRowData, JobRunSummary, JobScheduleKind
from app.schemas.permissions import ResourcePermissions


def _run(status: str) -> JobRunSummary:
    return JobRunSummary(
        duration="1초",
        ended_at="2026-07-17T00:00:01Z",
        error_summary="",
        failed_stage="",
        input_rows="1",
        output_rows="1",
        run_id=f"RUN-{status}",
        started_at="2026-07-17T00:00:00Z",
        status=status,
    )


def _job(
    job_id: str,
    *,
    owner: str,
    schedule: str,
    status: str,
    run_status: str | None,
) -> JobRowData:
    return JobRowData(
        id=job_id,
        last_run="-",
        last_state="준비됨",
        name=f"job-{job_id}",
        next_run="-",
        owner=owner,
        run_history=[_run(run_status)] if run_status else [],
        schedule=schedule,
        source="fixture",
        status=status,
        tag="[생성]",
        target="fixture_target",
    )


def _schedule_kind(schedule: str | None) -> JobScheduleKind:
    return "daily" if schedule == "매일" else "none"


class EtlJobQueryTests(unittest.TestCase):
    def test_list_reads_persisted_jobs_without_runtime_refresh_then_applies_filters_and_facets(self) -> None:
        jobs = [
            _job("VISIBLE-DAILY", owner="alice", schedule="매일", status="scheduled", run_status="success"),
            _job("VISIBLE-MANUAL", owner="bob", schedule="수동", status="failed", run_status="failed"),
            _job("HIDDEN", owner="alice", schedule="매일", status="scheduled", run_status="success"),
        ]
        projected_batches: list[list[str]] = []

        def with_list_permissions(
            _db,
            items: list[JobRowData],
            _actor: ActorContext,
        ) -> list[JobRowData]:
            projected_batches.append([job.id for job in items])
            return [
                job.model_copy(update={
                    "permissions": ResourcePermissions(can_view=job.id != "HIDDEN"),
                })
                for job in items
            ]

        hooks = EtlJobQueryHooks(
            record_audit_event=lambda *_args, **_kwargs: None,
            schedule_kind=_schedule_kind,
            with_permissions=lambda _db, job, _actor: job,
            with_list_permissions=with_list_permissions,
        )
        with (
            patch("app.application.etl_job_queries.etl_repository.list_job_models") as list_job_models,
            patch("app.application.etl_job_queries.etl_repository.list_jobs", return_value=jobs),
        ):
            response = list_jobs(
                object(),
                ActorContext(name="reader"),
                last_run_outcome="success",
                owner="alice",
                statuses=["scheduled"],
                schedule_kind="daily",
                hooks=hooks,
            )

        list_job_models.assert_not_called()
        self.assertEqual(projected_batches, [["VISIBLE-DAILY", "VISIBLE-MANUAL", "HIDDEN"]])
        self.assertEqual([job.id for job in response.jobs], ["VISIBLE-DAILY"])
        self.assertEqual(response.facets.total, 2)
        self.assertEqual(response.facets.owners, ["alice", "bob"])
        self.assertEqual(response.facets.latest_run_outcome_counts, {
            "success": 1,
            "failed": 1,
            "canceled": 0,
        })
        self.assertEqual(response.facets.status_counts["scheduled"], 1)
        self.assertEqual(response.facets.status_counts["failed"], 1)

    def test_detail_is_a_side_effect_free_read_before_permission_projection(self) -> None:
        job = _job("DETAIL", owner="alice", schedule="매일", status="scheduled", run_status=None)
        order: list[str] = []
        hooks = EtlJobQueryHooks(
            record_audit_event=lambda *_args, **_kwargs: None,
            schedule_kind=_schedule_kind,
            with_permissions=lambda _db, hydrated, _actor: (
                order.append("permissions") or hydrated
            ),
            with_list_permissions=lambda _db, items, _actor: items,
        )
        with patch("app.application.etl_job_queries.etl_repository.get_job_schema", return_value=job):
            response = get_job(object(), job.id, ActorContext(name="reader"), hooks=hooks)

        self.assertEqual(response.id, job.id)
        self.assertEqual(order, ["permissions"])

    def test_statuses_return_only_visible_requested_jobs_in_request_order(self) -> None:
        visible = _job("VISIBLE", owner="alice", schedule="매일", status="running", run_status="running")
        hidden = _job("HIDDEN", owner="bob", schedule="수동", status="running", run_status="running")
        visible = visible.model_copy(update={"progress": {"label": "Spark ETL", "value": 55}})

        hooks = EtlJobQueryHooks(
            record_audit_event=lambda *_args, **_kwargs: None,
            schedule_kind=_schedule_kind,
            with_permissions=lambda _db, job, _actor: job,
            with_list_permissions=lambda _db, items, _actor: [
                item.model_copy(update={
                    "permissions": ResourcePermissions(can_view=item.id != "HIDDEN"),
                })
                for item in items
            ],
        )
        with patch(
            "app.application.etl_job_queries.snapshot_status_repository.list_jobs_by_ids",
            return_value=[hidden, visible],
        ) as list_jobs_by_ids:
            db = object()
            response = list_job_statuses(
                db,
                ["VISIBLE", "HIDDEN", "VISIBLE"],
                ActorContext(name="reader"),
                hooks=hooks,
            )

        list_jobs_by_ids.assert_called_once_with(db, ["VISIBLE", "HIDDEN"])
        self.assertEqual([job.id for job in response.jobs], ["VISIBLE"])
        self.assertEqual(response.jobs[0].progress.value, 55)
        self.assertEqual(response.jobs[0].latest_run.status, "running")

    def test_statuses_reject_more_than_one_hundred_unique_jobs(self) -> None:
        hooks = EtlJobQueryHooks(
            record_audit_event=lambda *_args, **_kwargs: None,
            schedule_kind=_schedule_kind,
            with_permissions=lambda _db, job, _actor: job,
            with_list_permissions=lambda _db, items, _actor: items,
        )

        with self.assertRaises(ApiError) as raised:
            list_job_statuses(
                object(),
                [f"JOB-{index}" for index in range(101)],
                ActorContext(name="reader"),
                hooks=hooks,
            )

        self.assertEqual(raised.exception.status_code, 422)

    def test_detail_preserves_not_found_and_forbidden_audit_contracts(self) -> None:
        audit_calls: list[dict[str, object]] = []
        hooks = EtlJobQueryHooks(
            record_audit_event=lambda *_args, **kwargs: audit_calls.append(kwargs),
            schedule_kind=_schedule_kind,
            with_permissions=lambda _db, hydrated, _actor: hydrated.model_copy(update={
                "permissions": ResourcePermissions(can_view=False),
            }),
            with_list_permissions=lambda _db, items, _actor: items,
        )
        with patch("app.application.etl_job_queries.etl_repository.get_job_schema", return_value=None):
            with self.assertRaises(ApiError) as missing:
                get_job(object(), "MISSING", ActorContext(name="reader"), hooks=hooks)
        self.assertEqual(missing.exception.status_code, 404)

        job = _job("HIDDEN", owner="alice", schedule="매일", status="scheduled", run_status=None)
        with patch("app.application.etl_job_queries.etl_repository.get_job_schema", return_value=job):
            with self.assertRaises(ApiError) as forbidden:
                get_job(object(), job.id, ActorContext(name="reader"), hooks=hooks)

        self.assertEqual(forbidden.exception.status_code, 403)
        self.assertEqual(len(audit_calls), 1)
        self.assertEqual(audit_calls[0]["action"], "etl_job.view.forbidden")
        self.assertEqual(audit_calls[0]["target_id"], job.id)


if __name__ == "__main__":
    unittest.main()
