import asyncio
import logging
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.router import api_router
from app.core.config import settings
from app.core.database import SessionLocal
from app.core.errors import ApiError, api_error_handler, http_error_handler, unhandled_error_handler, validation_error_handler
from app.services.auth_service import initialize_auth
from app.schemas.etl import ScheduledJobRunRequest
from app.services.etl_service import run_due_scheduled_jobs, sync_active_kafka_continuous_runtimes

logger = logging.getLogger(__name__)


async def continuous_runtime_sync_loop() -> None:
    while True:
        try:
            await asyncio.to_thread(sync_active_kafka_continuous_runtimes)
        except Exception:  # Keep the control plane alive for the next interval.
            logger.exception("Continuous runtime synchronization failed")
        await asyncio.sleep(settings.continuous_runtime_sync_interval_seconds)


def run_scheduled_job_tick() -> None:
    with SessionLocal() as db:
        run_due_scheduled_jobs(db, ScheduledJobRunRequest(kafka_only=False))


async def scheduled_job_tick_loop() -> None:
    await asyncio.sleep(settings.scheduled_job_tick_interval_seconds)
    while True:
        try:
            await asyncio.to_thread(run_scheduled_job_tick)
        except Exception:  # Keep the control plane alive for the next interval.
            logger.exception("Scheduled job tick failed")
        await asyncio.sleep(settings.scheduled_job_tick_interval_seconds)


def initialize_auth_on_startup() -> None:
    with SessionLocal() as db:
        initialize_auth(db)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    initialize_auth_on_startup()
    continuous_task = asyncio.create_task(continuous_runtime_sync_loop())
    scheduled_task = asyncio.create_task(scheduled_job_tick_loop())
    try:
        yield
    finally:
        for task in (continuous_task, scheduled_task):
            task.cancel()
        for task in (continuous_task, scheduled_task):
            with suppress(asyncio.CancelledError):
                await task


def create_app() -> FastAPI:
    app = FastAPI(title=settings.app_name, lifespan=lifespan)

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

    app.add_exception_handler(ApiError, api_error_handler)
    app.add_exception_handler(RequestValidationError, validation_error_handler)
    app.add_exception_handler(StarletteHTTPException, http_error_handler)
    app.add_exception_handler(Exception, unhandled_error_handler)
    app.include_router(api_router, prefix=settings.api_prefix)

    return app


app = create_app()
