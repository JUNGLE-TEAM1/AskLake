from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.application.etl_job_queries import EtlJobQueryHooks, get_job, list_jobs
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
        refreshed: list[str] = []
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
            refresh_continuous_runtime=lambda _db, model: refreshed.append(model.id),
            schedule_kind=_schedule_kind,
            sync_airflow_runs=lambda _db, _model: None,
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
        self.assertEqual(refreshed, [])
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

    def test_detail_syncs_airflow_and_runtime_before_permission_projection(self) -> None:
        job = _job("DETAIL", owner="alice", schedule="매일", status="scheduled", run_status=None)
        model = SimpleNamespace(id=job.id)
        order: list[str] = []
        hooks = EtlJobQueryHooks(
            record_audit_event=lambda *_args, **_kwargs: None,
            refresh_continuous_runtime=lambda _db, _model: order.append("runtime"),
            schedule_kind=_schedule_kind,
            sync_airflow_runs=lambda _db, _model: order.append("airflow"),
            with_permissions=lambda _db, hydrated, _actor: (
                order.append("permissions") or hydrated
            ),
            with_list_permissions=lambda _db, items, _actor: items,
        )
        with (
            patch("app.application.etl_job_queries.etl_repository.get_job", return_value=model),
            patch("app.application.etl_job_queries.etl_repository.get_job_schema", return_value=job),
        ):
            response = get_job(object(), job.id, ActorContext(name="reader"), hooks=hooks)

        self.assertEqual(response.id, job.id)
        self.assertEqual(order, ["airflow", "runtime", "permissions"])

    def test_detail_preserves_not_found_and_forbidden_audit_contracts(self) -> None:
        audit_calls: list[dict[str, object]] = []
        hooks = EtlJobQueryHooks(
            record_audit_event=lambda *_args, **kwargs: audit_calls.append(kwargs),
            refresh_continuous_runtime=lambda _db, _model: None,
            schedule_kind=_schedule_kind,
            sync_airflow_runs=lambda _db, _model: None,
            with_permissions=lambda _db, hydrated, _actor: hydrated.model_copy(update={
                "permissions": ResourcePermissions(can_view=False),
            }),
            with_list_permissions=lambda _db, items, _actor: items,
        )
        with patch("app.application.etl_job_queries.etl_repository.get_job", return_value=None):
            with self.assertRaises(ApiError) as missing:
                get_job(object(), "MISSING", ActorContext(name="reader"), hooks=hooks)
        self.assertEqual(missing.exception.status_code, 404)

        job = _job("HIDDEN", owner="alice", schedule="매일", status="scheduled", run_status=None)
        model = SimpleNamespace(id=job.id)
        with (
            patch("app.application.etl_job_queries.etl_repository.get_job", return_value=model),
            patch("app.application.etl_job_queries.etl_repository.get_job_schema", return_value=job),
        ):
            with self.assertRaises(ApiError) as forbidden:
                get_job(object(), job.id, ActorContext(name="reader"), hooks=hooks)

        self.assertEqual(forbidden.exception.status_code, 403)
        self.assertEqual(len(audit_calls), 1)
        self.assertEqual(audit_calls[0]["action"], "etl_job.view.forbidden")
        self.assertEqual(audit_calls[0]["target_id"], job.id)


if __name__ == "__main__":
    unittest.main()
