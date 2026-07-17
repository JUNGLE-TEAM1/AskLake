"""Lightweight read models for Jobs-page status refresh."""

from typing import Any

from pydantic import Field

from app.schemas.common import CamelModel
from app.schemas.etl import JobDagStep, JobProgress, JobRunSummary, JobStatus


class JobStatusSnapshot(CamelModel):
    id: str
    status: JobStatus
    progress: JobProgress | dict[str, Any] | None = None
    last_run: str
    last_state: str
    next_run: str
    updated_at: str | None = None
    latest_run: JobRunSummary | None = None
    dag_steps: list[JobDagStep] = Field(default_factory=list)


class JobStatusListResponse(CamelModel):
    jobs: list[JobStatusSnapshot]
