"""Replay paths, SQL run identity, and schedule operations behind the ETL facade."""

from __future__ import annotations

RUNTIME_NAMES = {
    'ActorContext',
    'ApiError',
    'BACKEND_DIR',
    'ErrorCode',
    'Path',
    'ScheduledJobRunRequest',
    'TypeError',
    'ValueError',
    'any',
    'dict',
    'etl_repository',
    'has_scheduled_execution',
    'int',
    'isinstance',
    'load_active_actor_by_user_id',
    'next_scheduled_run_utc',
    'optional_int',
    'os',
    're',
    'settings',
    'should_run_scheduled_job',
    'status',
    'str',
    'tuple',
}


def continuous_runtime_report_path(job_id: str) -> Path | str:
    safe_job_id = re.sub(r"[^a-z0-9_.-]+", "-", job_id.lower()).strip("-") or "job"
    configured = str(os.environ.get("ASKLAKE_CONTINUOUS_RUNTIME_DOCUMENT_PREFIX") or "").strip()
    if re.match(r"^s3a?://", configured, re.IGNORECASE):
        return f"{configured.rstrip('/')}/kafka-continuous-{safe_job_id}.json"
    report_dir = Path(configured or os.environ.get("ASKLAKE_SPARK_REPORT_DIR") or BACKEND_DIR / "tmp" / "spark-runs")
    return report_dir / f"kafka-continuous-{safe_job_id}.json"


def optional_string(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None


def optional_int(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def nonnegative_int(value: Any, fallback: int) -> int:
    parsed = optional_int(value)
    return parsed if parsed is not None and parsed >= 0 else fallback


def has_successful_run(db: Session, job_id: str) -> bool:
    return any(run.status == "success" for run in etl_repository.list_runs_for_job(db, job_id))


def trino_sql_job_run_as_actor(db: Session, job: ETLJobModel) -> ActorContext:
    recipe = job.sql_recipe if isinstance(job.sql_recipe, dict) else {}
    legacy_run_as = recipe.get("runAs") if isinstance(recipe.get("runAs"), dict) else {}
    user_id = str(recipe.get("runAsUserId") or legacy_run_as.get("id") or "").strip()
    if user_id:
        current_actor = load_active_actor_by_user_id(db, user_id)
        if current_actor is None:
            if settings.allows_header_auth_fallback:
                # Header-auth development may not have a durable AuthUser row.
                # Preserve only the submitted identity key; never reuse a
                # persisted role/group snapshot as execution authority.
                return ActorContext(
                    name=str(job.created_by or job.owner),
                    role="viewer",
                    groups=(),
                    id=user_id,
                )
            raise ApiError(
                ErrorCode.FORBIDDEN,
                "SQL Job execution principal is inactive or blocked",
                status.HTTP_403_FORBIDDEN,
                {"userId": user_id},
            )
        return ActorContext(
            name=str(current_actor.get("name") or job.created_by or job.owner),
            role=str(current_actor.get("role") or "viewer"),
            groups=tuple(str(group) for group in current_actor.get("groups") or []),
            id=str(current_actor.get("id") or "") or None,
            email=str(current_actor.get("email") or "") or None,
            title=str(current_actor.get("title") or "") or None,
        )

    if not settings.allows_header_auth_fallback:
        raise ApiError(
            ErrorCode.FORBIDDEN,
            "SQL Job execution principal is unavailable",
            status.HTTP_403_FORBIDDEN,
        )

    # Header-auth development predates durable auth user ids. Keep legacy jobs
    # usable at least privilege without trusting their identity snapshot.
    return ActorContext(
        name=str(job.created_by or job.owner),
        role="viewer",
        groups=(),
        id=None,
    )


def advance_scheduled_job_after_tick(db: Session, job_id: str) -> None:
    job = etl_repository.get_job(db, job_id)
    if job is None or not isinstance(job.schedule_policy, dict):
        return

    next_run_utc = next_scheduled_run_utc(job)
    if not next_run_utc:
        job.schedule_policy = {**job.schedule_policy, "nextRunUtc": ""}
        job.next_run = "-"
        job.status = "stopped"
        job.last_state = "스케줄 종료"
        etl_repository.save_job(db, job)
        return

    job.schedule_policy = {
        **job.schedule_policy,
        "nextRunUtc": next_run_utc,
    }
    job.next_run = next_run_utc
    etl_repository.save_job(db, job)


def scheduled_job_next_run_utc(job: ETLJobModel) -> str:
    if not isinstance(job.schedule_policy, dict):
        return ""
    return str(job.schedule_policy.get("nextRunUtc") or "").strip()


def scheduled_job_occurrence_is_claimable(job: ETLJobModel, expected_next_run_utc: str) -> bool:
    if not expected_next_run_utc or scheduled_job_next_run_utc(job) != expected_next_run_utc:
        return False
    should_run, reason = should_run_scheduled_job(
        job,
        ScheduledJobRunRequest(force=False, job_id=job.id, kafka_only=False),
    )
    return should_run and reason == "due"


def advance_claimed_scheduled_job(job: ETLJobModel) -> None:
    if not isinstance(job.schedule_policy, dict):
        return
    next_run_utc = next_scheduled_run_utc(job)
    if not next_run_utc:
        job.schedule_policy = {**job.schedule_policy, "nextRunUtc": ""}
        job.next_run = "-"
        job.status = "stopped"
        job.last_state = "스케줄 종료"
        return
    job.schedule_policy = {**job.schedule_policy, "nextRunUtc": next_run_utc}
    job.next_run = next_run_utc


def ensure_scheduled_job_next_run(db: Session, job: ETLJobModel) -> None:
    if not has_scheduled_execution(job):
        return
    policy = dict(job.schedule_policy) if isinstance(job.schedule_policy, dict) else {}
    current_next_run = str(policy.get("nextRunUtc") or "").strip()
    if current_next_run:
        return
    next_run_utc = next_scheduled_run_utc(job)
    if not next_run_utc:
        job.schedule_policy = {**policy, "nextRunUtc": ""}
        job.next_run = "-"
        job.status = "stopped"
        job.last_state = "스케줄 종료"
        etl_repository.save_job(db, job)
        return
    job.schedule_policy = {**policy, "nextRunUtc": next_run_utc}
    job.next_run = next_run_utc
    etl_repository.save_job(db, job)


EXPORTED_FUNCTIONS = (
    'continuous_runtime_report_path',
    'optional_string',
    'optional_int',
    'nonnegative_int',
    'has_successful_run',
    'trino_sql_job_run_as_actor',
    'advance_scheduled_job_after_tick',
    'scheduled_job_next_run_utc',
    'scheduled_job_occurrence_is_claimable',
    'advance_claimed_scheduled_job',
    'ensure_scheduled_job_next_run',
)

IMPLEMENTATIONS = {name: globals()[name] for name in EXPORTED_FUNCTIONS}
