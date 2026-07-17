import asyncio
import logging
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.router import api_router
from app.api.internal_mcp import create_internal_mcp_app, internal_mcp_mount_path
from app.core.config import settings
from app.core.database import SessionLocal
from app.core.errors import ApiError, api_error_handler, http_error_handler, unhandled_error_handler, validation_error_handler
from app.migrations.dashboard_schema import migrate_dashboard_schema
from app.core.observability import CorrelationIdMiddleware
from app.repositories.dashboard_live_repository import ensure_dashboard_live_schema
from app.repositories.continuous_sql_repository import ensure_continuous_sql_schema
from app.repositories.realtime_event_repository import ensure_realtime_event_schema
from app.schemas.etl import ScheduledJobRunRequest
from app.services.auth_service import initialize_auth
from app.services.etl_service import (
    run_due_scheduled_jobs,
    sync_active_airflow_snapshot_runs,
    sync_active_kafka_continuous_runtimes,
)
from app.services.realtime_event_service import realtime_event_dispatcher
from app.services.continuous_sql_service import sync_active_continuous_sql_jobs

logger = logging.getLogger(__name__)


async def continuous_runtime_sync_loop() -> None:
    while True:
        try:
            await asyncio.to_thread(sync_active_kafka_continuous_runtimes)
            await asyncio.to_thread(sync_active_continuous_sql_jobs)
        except Exception:  # Keep the control plane alive for the next interval.
            logger.exception("Continuous runtime synchronization failed")
        await asyncio.sleep(settings.continuous_runtime_sync_interval_seconds)


async def snapshot_airflow_sync_loop() -> None:
    while True:
        try:
            await asyncio.to_thread(sync_active_airflow_snapshot_runs)
        except Exception:  # Keep the next reconciliation cycle recoverable.
            logger.exception("Snapshot Airflow synchronization failed")
        await asyncio.sleep(settings.airflow_run_sync_interval_seconds)


def run_scheduled_job_tick() -> None:
    with SessionLocal() as db:
        run_due_scheduled_jobs(db, ScheduledJobRunRequest(kafka_only=False))
        RagService(db).reconcile_alias_activations()
        RagService(db).reconcile_source_changes()


async def scheduled_job_tick_loop() -> None:
    await asyncio.sleep(settings.scheduled_job_tick_interval_seconds)
    while True:
        try:
            await asyncio.to_thread(run_scheduled_job_tick)
        except Exception:  # Keep the control plane alive for the next interval.
            logger.exception("Scheduled job tick failed")
        await asyncio.sleep(settings.scheduled_job_tick_interval_seconds)


async def review_analysis_worker_loop() -> None:
    while True:
        try:
            await asyncio.to_thread(ReviewAnalysisService.fail_stale_runs)
            processed = await asyncio.to_thread(ReviewAnalysisService.process_next_queued_run)
        except Exception:  # A failed queue tick must not stop later persisted runs.
            logger.exception("Review analysis worker tick failed")
            processed = False
        await asyncio.sleep(0 if processed else 2)


def initialize_auth_on_startup() -> None:
    with SessionLocal() as db:
        # Some operational tests inject an auth-only session sentinel. Real
        # SQLAlchemy sessions always expose get_bind().
        if hasattr(db, "get_bind"):
            migrate_dashboard_schema(db)
            ensure_dashboard_live_schema(db)
            ensure_realtime_event_schema(db)
            ensure_continuous_sql_schema(db)
        initialize_auth(db)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    initialize_auth_on_startup()
    snapshot_airflow_task = asyncio.create_task(snapshot_airflow_sync_loop())
    continuous_task = asyncio.create_task(continuous_runtime_sync_loop())
    scheduled_task = asyncio.create_task(scheduled_job_tick_loop())
    background_tasks = [snapshot_airflow_task, continuous_task, scheduled_task]
    if settings.realtime_events_enabled:
        background_tasks.append(asyncio.create_task(
            realtime_event_dispatcher.run(),
            name="asklake-realtime-event-dispatcher",
        ))
    async with _app.state.internal_mcp_lifespan():
        try:
            yield
        finally:
            for task in background_tasks:
                task.cancel()
            for task in background_tasks:
                with suppress(asyncio.CancelledError):
                    await task


def create_app() -> FastAPI:
    app = FastAPI(title=settings.app_name, lifespan=lifespan)
    internal_mcp_app, internal_mcp_lifespan = create_internal_mcp_app()
    app.state.internal_mcp_lifespan = internal_mcp_lifespan

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.backend_cors_origins,
        allow_origin_regex=(
            r"https?://(localhost|127\.0\.0\.1):\d+"
            if settings.allows_header_auth_fallback
            else None
        ),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(CorrelationIdMiddleware)

    app.add_exception_handler(ApiError, api_error_handler)
    app.add_exception_handler(RequestValidationError, validation_error_handler)
    app.add_exception_handler(StarletteHTTPException, http_error_handler)
    app.add_exception_handler(Exception, unhandled_error_handler)
    app.include_router(api_router, prefix=settings.api_prefix)
    app.mount(internal_mcp_mount_path, internal_mcp_app)

    return app


app = create_app()
