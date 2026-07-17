"""ETL and SQL Job scheduling policy without repository side effects."""

import calendar
from datetime import UTC, datetime, timedelta
import re
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import status

from app.core.errors import ApiError
from app.models import ETLJobModel
from app.schemas.common import ErrorCode
from app.schemas.etl import (
    CreatePipelineRequest,
    CreateTrinoSqlJobRequest,
    JobScheduleKind,
    UpdatePipelineRequest,
)

DEFAULT_SCHEDULE_TIMEZONE = "Asia/Seoul"
SCHEDULE_WEEKDAY_VALUES = {
    "월": 0,
    "화": 1,
    "수": 2,
    "목": 3,
    "금": 4,
    "토": 5,
    "일": 6,
}


def schedule_next_run_label(schedule_label: str | None, fallback: str | None = None) -> str:
    schedule = str(schedule_label or "").strip()
    fallback_label = str(fallback or "").strip()
    if not schedule or not has_scheduled_label(schedule):
        return "-"
    if "1회" in schedule or "예약" in schedule:
        return fallback_label if fallback_label and fallback_label != "-" else re.sub(r"\s*(예약\s*)?1회 실행\s*$", "", schedule).strip()
    return fallback_label if fallback_label and fallback_label != "-" else schedule


def trino_sql_job_schedule_label(request: CreateTrinoSqlJobRequest) -> str:
    schedule = request.schedule
    if schedule.mode == "manual":
        return "스케줄링 건너뛰기"
    if schedule.mode == "daily":
        return f"매일 {schedule.time}"
    return f"매주 {schedule.weekday}요일 {schedule.time}"


def trino_sql_job_schedule_summary(request: CreateTrinoSqlJobRequest) -> str:
    if request.schedule.mode == "manual":
        return "스케줄링 건너뛰기 · Job 목록에서 직접 실행 · full refresh"
    return (
        f"반복 실행 · {trino_sql_job_schedule_label(request)} · "
        f"{request.schedule.timezone} · {request.schedule.overlap_policy} · full refresh"
    )


def trino_sql_job_next_run_utc(request: CreateTrinoSqlJobRequest) -> str | None:
    schedule = request.schedule
    if schedule.mode == "manual":
        return None
    try:
        hour_text, minute_text = schedule.time.split(":", maxsplit=1)
        hour = int(hour_text)
        minute = int(minute_text)
        if not 0 <= hour <= 23 or not 0 <= minute <= 59:
            raise ValueError
        timezone = ZoneInfo(schedule.timezone)
    except (ValueError, ZoneInfoNotFoundError) as exc:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "SQL Job schedule time or timezone is invalid",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        ) from exc

    now = datetime.now(timezone)
    candidate = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if schedule.mode == "daily":
        if candidate <= now:
            candidate += timedelta(days=1)
    else:
        weekdays = {"월": 0, "화": 1, "수": 2, "목": 3, "금": 4, "토": 5, "일": 6}
        candidate += timedelta(days=(weekdays[schedule.weekday] - candidate.weekday()) % 7)
        if candidate <= now:
            candidate += timedelta(days=7)
    return candidate.astimezone(UTC).isoformat().replace("+00:00", "Z")


def has_scheduled_label(schedule_label: str | None) -> bool:
    schedule = str(schedule_label or "").strip().lower()
    if not schedule or schedule == "-":
        return False
    return not any(token in schedule for token in ["manual", "수동", "스케줄 없음", "건너뛰기"])


def job_schedule_kind(schedule_label: str | None) -> JobScheduleKind:
    schedule = str(schedule_label or "").strip().lower()
    if not schedule or schedule == "-" or any(token in schedule for token in ["manual", "수동", "스케줄 없음", "건너뛰기"]):
        return "none"
    if any(token in schedule for token in ["실시간", "realtime", "real-time", "stream", "kafka"]):
        return "realtime"
    if any(token in schedule for token in ["매일", "daily"]):
        return "daily"
    if any(token in schedule for token in ["매주", "weekly"]):
        return "weekly"
    if any(token in schedule for token in ["매월", "monthly"]):
        return "monthly"
    return "other"


def schedule_timezone(timezone_name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(str(timezone_name or DEFAULT_SCHEDULE_TIMEZONE))
    except (KeyError, ValueError, ZoneInfoNotFoundError):
        return ZoneInfo(DEFAULT_SCHEDULE_TIMEZONE)


def parse_cron_field(expression: str, minimum: int, maximum: int) -> tuple[set[int], bool] | None:
    values: set[int] = set()
    is_wildcard = all(part.strip().split("/", 1)[0] == "*" for part in expression.split(","))
    for part in expression.split(","):
        token = part.strip()
        if not token:
            return None
        base, separator, step_text = token.partition("/")
        try:
            step = int(step_text) if separator else 1
        except ValueError:
            return None
        if step < 1:
            return None
        if base == "*":
            start, end = minimum, maximum
        elif "-" in base:
            start_text, end_text = base.split("-", 1)
            try:
                start, end = int(start_text), int(end_text)
            except ValueError:
                return None
        else:
            try:
                start = end = int(base)
            except ValueError:
                return None
        if start < minimum or end > maximum or start > end:
            return None
        values.update(range(start, end + 1, step))
    return values, is_wildcard


def cron_matches(local_time: datetime, fields: list[str]) -> bool:
    ranges = [
        parse_cron_field(fields[0], 0, 59),
        parse_cron_field(fields[1], 0, 23),
        parse_cron_field(fields[2], 1, 31),
        parse_cron_field(fields[3], 1, 12),
        parse_cron_field(fields[4], 0, 7),
    ]
    if any(value is None for value in ranges):
        return False
    minute, hour, day_of_month, month, day_of_week = ranges
    assert minute is not None and hour is not None and day_of_month is not None and month is not None and day_of_week is not None
    weekday_value = (local_time.weekday() + 1) % 7
    weekday_values = day_of_week[0]
    month_matches = local_time.month in month[0]
    day_matches = local_time.day in day_of_month[0]
    weekday_matches = weekday_value in weekday_values or (weekday_value == 0 and 7 in weekday_values)
    day_matches = (
        day_matches and weekday_matches
        if not day_of_month[1] and not day_of_week[1]
        else day_matches if day_of_week[1]
        else weekday_matches if day_of_month[1]
        else day_matches or weekday_matches
    )
    return local_time.minute in minute[0] and local_time.hour in hour[0] and month_matches and day_matches


def next_custom_cron_local(expression: str, start: datetime) -> datetime | None:
    fields = expression.split()
    if len(fields) != 5:
        return None
    candidate = start.replace(second=0, microsecond=0)
    if candidate <= start:
        candidate += timedelta(minutes=1)
    for _ in range(366 * 24 * 60 * 2):
        if cron_matches(candidate, fields):
            return candidate
        candidate += timedelta(minutes=1)
    return None


def next_scheduled_run_utc_for_schedule(
    schedule: str | None,
    timezone_name: str | None,
    start_date: str | None = None,
    end_date: str | None = None,
    now: datetime | None = None,
) -> str:
    label = str(schedule or "").strip()
    if not has_scheduled_label(label):
        return ""
    timezone = schedule_timezone(timezone_name)
    now_utc = now.astimezone(UTC) if now is not None else datetime.now(UTC)
    local_now = now_utc.astimezone(timezone)
    earliest = local_now.replace(second=0, microsecond=0) + timedelta(minutes=1)
    try:
        start_boundary = datetime.strptime(str(start_date), "%Y-%m-%d").date() if start_date else None
        end_boundary = datetime.strptime(str(end_date), "%Y-%m-%d").date() if end_date else None
    except ValueError:
        start_boundary = end_boundary = None
    if start_boundary and earliest.date() < start_boundary:
        earliest = datetime.combine(start_boundary, datetime.min.time(), timezone=timezone)

    candidate: datetime | None = None
    hourly_match = re.match(r"^매시간\s+(\d{1,2})분$", label)
    daily_match = re.match(r"^매일\s+(\d{1,2}):(\d{2})$", label)
    weekly_match = re.match(r"^매주\s+([월화수목금토일])요일\s+(\d{1,2}):(\d{2})$", label)
    monthly_match = re.match(r"^매월\s+(\d{1,2})일\s+(\d{1,2}):(\d{2})$", label)
    custom_match = re.match(r"^커스텀:\s*(.+)$", label)

    if hourly_match:
        minute = min(59, int(hourly_match.group(1)))
        candidate = earliest.replace(minute=minute, second=0, microsecond=0)
        while candidate < earliest:
            candidate += timedelta(hours=1)
    elif daily_match:
        hour = min(23, int(daily_match.group(1)))
        minute = min(59, int(daily_match.group(2)))
        candidate = earliest.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if candidate < earliest:
            candidate += timedelta(days=1)
    elif weekly_match:
        weekday = SCHEDULE_WEEKDAY_VALUES[weekly_match.group(1)]
        hour = min(23, int(weekly_match.group(2)))
        minute = min(59, int(weekly_match.group(3)))
        days_ahead = (weekday - earliest.weekday()) % 7
        candidate = (earliest + timedelta(days=days_ahead)).replace(hour=hour, minute=minute, second=0, microsecond=0)
        if candidate < earliest:
            candidate += timedelta(days=7)
    elif monthly_match:
        day = min(31, int(monthly_match.group(1)))
        hour = min(23, int(monthly_match.group(2)))
        minute = min(59, int(monthly_match.group(3)))
        year, month = earliest.year, earliest.month
        for _ in range(24):
            if day <= calendar.monthrange(year, month)[1]:
                candidate = earliest.replace(year=year, month=month, day=day, hour=hour, minute=minute, second=0, microsecond=0)
                if candidate >= earliest:
                    break
            month += 1
            if month > 12:
                year, month = year + 1, 1
    elif custom_match:
        candidate = next_custom_cron_local(custom_match.group(1).strip(), earliest)

    if candidate is None or (end_boundary and candidate.date() > end_boundary):
        return ""
    return candidate.astimezone(UTC).isoformat().replace("+00:00", "Z")


def schedule_policy_from_request(request: CreatePipelineRequest | UpdatePipelineRequest) -> dict[str, Any]:
    watermark_policy = request.watermark_policy
    if hasattr(watermark_policy, "model_dump"):
        watermark_policy = watermark_policy.model_dump(mode="json", by_alias=True)
    next_run_utc = str(request.next_run_utc or "").strip()
    if has_scheduled_label(request.schedule_label):
        try:
            requested_next_run = datetime.fromisoformat(next_run_utc.replace("Z", "+00:00")) if next_run_utc else None
            if requested_next_run is not None and requested_next_run.tzinfo is None:
                requested_next_run = requested_next_run.replace(tzinfo=UTC)
            if requested_next_run is None or requested_next_run <= datetime.now(UTC):
                next_run_utc = next_scheduled_run_utc_for_schedule(
                    request.schedule_label,
                    request.timezone,
                    request.start_date,
                    request.end_date,
                )
        except (TypeError, ValueError):
            next_run_utc = next_scheduled_run_utc_for_schedule(
                request.schedule_label,
                request.timezone,
                request.start_date,
                request.end_date,
            )
    else:
        next_run_utc = ""
    return {
        "endDate": request.end_date,
        "nextRunUtc": next_run_utc,
        "overlapPolicy": request.overlap_policy or ("skip_if_running" if has_scheduled_label(request.schedule_label) else None),
        "startDate": request.start_date,
        "timezone": request.timezone,
        "watermarkPolicy": watermark_policy,
    }


def has_scheduled_execution(job: ETLJobModel) -> bool:
    return job.status != "stopped" and has_scheduled_label(job.schedule)
