from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import BackgroundTasks, status
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext
from app.core.database import SessionLocal
from app.core.errors import ApiError
from app.infrastructure.runtime_io import VersionedNodeBridge
from app.ports.runtime_io import VersionedNodeBridgePort
from app.schemas.common import ErrorCode
from app.services.ai_gateway_client import AiGatewayClient


class ReviewAnalysisService:
    def __init__(self, bridge: VersionedNodeBridgePort | None = None) -> None:
        self._bridge = bridge or VersionedNodeBridge(
            backend_dir=Path(__file__).resolve().parents[2],
        )

    def get_status(self) -> dict[str, Any]:
        summary_path = self._output_root() / "cellphones-latest-summary.json"
        if summary_path.exists():
            try:
                payload = json.loads(summary_path.read_text(encoding="utf-8"))
                if isinstance(payload, dict):
                    return payload
            except (OSError, json.JSONDecodeError) as error:
                raise ApiError(
                    ErrorCode.INTERNAL_ERROR,
                    "Review analysis summary could not be read",
                    status.HTTP_502_BAD_GATEWAY,
                    {"message": str(error)},
                ) from error
        return {
            "status": "idle",
            "message": "Review analysis has not run yet.",
            "source": self._source_descriptor(),
        }

    def enqueue(
        self,
        request: dict[str, Any],
        actor: ActorContext,
        background_tasks: BackgroundTasks,
    ) -> dict[str, Any]:
        if self.db is None:
            raise ApiError(ErrorCode.INTERNAL_ERROR, "Review analysis persistence is unavailable", 500)
        payload = self._validated_run_payload(request)
        run_id = f"review_{uuid4().hex}"
        payload["runId"] = run_id
        row = ReviewAnalysisRunModel(
            id=run_id,
            status="queued",
            created_by=_actor_identity(actor),
            source=dict(payload["source"]),
            request_payload=payload,
        )
        self.db.add(row)
        self.db.commit()
        self.db.refresh(row)
        background_tasks.add_task(self.execute_queued_run, run_id)
        return self._serialize_run(row)

    @staticmethod
    def execute_queued_run(run_id: str) -> None:
        with SessionLocal() as db:
            started_at = datetime.now(timezone.utc)
            claim = db.execute(
                update(ReviewAnalysisRunModel)
                .where(ReviewAnalysisRunModel.id == run_id, ReviewAnalysisRunModel.status == "queued")
                .values(status="running", started_at=started_at, error=None)
            )
            if claim.rowcount != 1:
                db.rollback()
                return
            db.commit()
            row = db.get(ReviewAnalysisRunModel, run_id)
            if row is None:
                return
            try:
                result = ReviewAnalysisService(db).run(dict(row.request_payload))
            except Exception as error:  # Background jobs must persist every terminal failure.
                db.execute(
                    update(ReviewAnalysisRunModel)
                    .where(ReviewAnalysisRunModel.id == run_id, ReviewAnalysisRunModel.status == "running")
                    .values(
                        status="failed",
                        error=_safe_error_message(error),
                        finished_at=datetime.now(timezone.utc),
                    )
                )
                db.commit()
                return
            db.execute(
                update(ReviewAnalysisRunModel)
                .where(ReviewAnalysisRunModel.id == run_id, ReviewAnalysisRunModel.status == "running")
                .values(
                    status="success",
                    result=result,
                    error=None,
                    finished_at=datetime.now(timezone.utc),
                )
            )
            db.commit()

    @staticmethod
    def process_next_queued_run() -> bool:
        with SessionLocal() as db:
            run_id = db.scalar(
                select(ReviewAnalysisRunModel.id)
                .where(ReviewAnalysisRunModel.status == "queued")
                .order_by(ReviewAnalysisRunModel.created_at.asc())
                .limit(1)
            )
        if not run_id:
            return False
        ReviewAnalysisService.execute_queued_run(str(run_id))
        return True

    @staticmethod
    def fail_stale_runs() -> int:
        timeout_seconds = _bounded_int(
            os.environ.get("ASKLAKE_REVIEW_RUN_STALE_SECONDS"),
            default=3_600,
            minimum=300,
            maximum=86_400,
        )
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=timeout_seconds)
        with SessionLocal() as db:
            result = db.execute(
                update(ReviewAnalysisRunModel)
                .where(
                    ReviewAnalysisRunModel.status == "running",
                    ReviewAnalysisRunModel.started_at.is_not(None),
                    ReviewAnalysisRunModel.started_at < cutoff,
                )
                .values(
                    status="failed",
                    error="Review analysis worker lease expired before completion.",
                    finished_at=datetime.now(timezone.utc),
                )
            )
            db.commit()
            return int(result.rowcount or 0)

    def suggest_schema(self, request: dict[str, Any]) -> dict[str, Any]:
        return self._call_node("reviewAnalysis.suggestSchema", request)

    def run(self, request: dict[str, Any]) -> dict[str, Any]:
        return self._call_node("reviewAnalysis.run", request)

    def _call_node(self, function_name: str, request: dict[str, Any]) -> dict[str, Any]:
        try:
            return self._bridge.execute_operation(
                function_name,
                request,
                timeout_seconds=max(1, int(os.environ.get("ASKLAKE_REVIEW_ANALYSIS_TIMEOUT_SECONDS", "900"))),
            )
        except ApiError as error:
            if error.code in {"NODE_BRIDGE_TIMEOUT", "NODE_BRIDGE_START_FAILED"}:
                raise ApiError(
                    ErrorCode.BACKEND_TIMEOUT,
                    "Review analysis request timed out or could not start",
                    status.HTTP_504_GATEWAY_TIMEOUT,
                    error.details,
                ) from error
            if error.code == "NODE_BRIDGE_PROTOCOL_ERROR":
                raise ApiError(
                    "REVIEW_ANALYSIS_INVALID_RESPONSE",
                    "Review analysis returned invalid JSON",
                    status.HTTP_502_BAD_GATEWAY,
                    error.details,
                ) from error
            raise ApiError(
                "REVIEW_ANALYSIS_FAILED",
                "Review analysis request failed",
                status.HTTP_502_BAD_GATEWAY,
                error.details,
            ) from error

    def _output_root(self) -> Path:
        configured = str(os.environ.get("ASKLAKE_REVIEW_ANALYSIS_DIR") or "").strip()
        return Path(configured) if configured else Path(__file__).resolve().parents[2] / "tmp" / "review-row-analysis"

    def _model_root(self) -> Path:
        configured = str(os.environ.get("ASKLAKE_REVIEW_TEXT_MODEL_HOST_DIR") or "").strip()
        return Path(configured) if configured else Path(__file__).resolve().parents[2] / "tmp" / "review-text-models" / "latest"

    def _source_descriptor(self) -> dict[str, str]:
        bucket = os.environ.get("ASKLAKE_CELLPHONES_REVIEW_BUCKET", "m3-raw")
        key = os.environ.get(
            "ASKLAKE_CELLPHONES_REVIEW_KEY",
            "amazon_reviews/cell_phones_and_accessories/reviews/Cell_Phones_and_Accessories.jsonl",
        )
        return {
            "bucket": bucket,
            "key": key,
            "object": f"s3://{bucket}/{key}",
            "runtime": os.environ.get("ASKLAKE_OBJECT_STORAGE_PROVIDER", "minio"),
        }


def _bounded_int(value: object, *, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value) if value is not None else default
    except (TypeError, ValueError):
        parsed = default
    return min(max(parsed, minimum), maximum)


def _bounded_review_source_row(row: dict[str, Any], source_fields: set[str]) -> dict[str, Any]:
    priority = [
        "title",
        "text",
        "reviewText",
        "rating",
        "overall",
        "asin",
        "parent_asin",
        "verified_purchase",
        "helpful_vote",
        "timestamp",
        "user_id",
    ]
    ordered_fields = [*priority, *sorted(source_fields - set(priority))]
    bounded: dict[str, Any] = {}
    remaining_chars = 9_000
    for field in ordered_fields[:64]:
        if field not in row or remaining_chars <= 0:
            continue
        value = row.get(field)
        if isinstance(value, (dict, list)):
            rendered = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
            value = rendered
        if isinstance(value, str):
            value = value[: min(2_000, remaining_chars)]
            remaining_chars -= len(value)
        else:
            remaining_chars -= len(str(value))
        bounded[field] = value
    return bounded


def _actor_identity(actor: ActorContext) -> str:
    return str(actor.id or actor.email or actor.name).strip()


def _safe_error_message(error: Exception) -> str:
    if isinstance(error, ApiError):
        return error.message[:2_000]
    return f"{error.__class__.__name__}: {str(error)}"[:2_000]
