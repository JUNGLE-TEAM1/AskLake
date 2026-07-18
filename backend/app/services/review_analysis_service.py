from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
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
from app.models.etl import ReviewAnalysisRunModel
from app.ports.runtime_io import VersionedNodeBridgePort
from app.schemas.common import ErrorCode
from app.services.ai_gateway_client import AiGatewayClient


class ReviewAnalysisService:
    def __init__(
        self,
        db: Session | None = None,
        bridge: VersionedNodeBridgePort | None = None,
    ) -> None:
        self.db = db
        self._bridge = bridge or VersionedNodeBridge(
            backend_dir=Path(__file__).resolve().parents[2],
        )

    def get_status(self, actor: ActorContext | None = None, run_id: str | None = None) -> dict[str, Any]:
        if self.db is None:
            return {
                "status": "idle",
                "message": "Review analysis has not run yet.",
                "source": self._source_descriptor(),
            }
        query = select(ReviewAnalysisRunModel)
        if run_id:
            query = query.where(ReviewAnalysisRunModel.id == run_id)
        elif actor is not None and actor.role != "admin":
            query = query.where(ReviewAnalysisRunModel.created_by == _actor_identity(actor))
        query = query.order_by(ReviewAnalysisRunModel.created_at.desc()).limit(1)
        row = self.db.scalar(query)
        if row is not None:
            if actor is not None and actor.role != "admin" and row.created_by != _actor_identity(actor):
                raise ApiError(ErrorCode.NOT_FOUND, "Review analysis run not found", status.HTTP_404_NOT_FOUND)
            return self._serialize_run(row)
        if run_id:
            raise ApiError(ErrorCode.NOT_FOUND, "Review analysis run not found", status.HTTP_404_NOT_FOUND)
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
        source_columns = request.get("sourceColumns") or request.get("source_columns") or []
        sample_rows = request.get("sampleRows") or request.get("sample_rows") or []
        return AiGatewayClient().suggest_review_schema(
            request_id=str(uuid4()),
            source_columns=source_columns if isinstance(source_columns, list) else [],
            sample_rows=sample_rows if isinstance(sample_rows, list) else [],
        )

    def preview(self, request: dict[str, Any]) -> dict[str, Any]:
        rows = request.get("rows") if isinstance(request.get("rows"), list) else []
        columns = request.get("columns") if isinstance(request.get("columns"), list) else []
        target_names = [str(column.get("targetName") or "").strip() for column in columns if isinstance(column, dict)]
        if len(target_names) != len(columns) or len(set(target_names)) != len(target_names):
            raise ApiError(
                ErrorCode.VALIDATION_ERROR,
                "Review preview columns must have unique targetName values",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        source_fields = {
            str(column.get("sourceField") or "").strip()
            for column in columns
            if isinstance(column, dict) and str(column.get("sourceField") or "").strip()
        }
        source_fields.update({
            "asin",
            "helpful_vote",
            "overall",
            "parent_asin",
            "rating",
            "reviewText",
            "text",
            "timestamp",
            "title",
            "user_id",
            "verified_purchase",
        })
        gateway = AiGatewayClient()
        projected_rows: list[dict[str, str]] = []
        models: list[str] = []
        providers: list[str] = []
        for row in rows:
            if not isinstance(row, dict):
                raise ApiError(
                    ErrorCode.VALIDATION_ERROR,
                    "Review preview rows must be objects",
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                )
            bounded_row = _bounded_review_source_row(row, source_fields)
            output = gateway.analyze_review_row(
                request_id=str(uuid4()),
                source_row=bounded_row,
                requested_columns=columns,
            )
            values = output.get("values") if isinstance(output.get("values"), list) else []
            values_by_target: dict[str, Any] = {}
            for item in values:
                if not isinstance(item, dict):
                    continue
                target_name = str(item.get("targetName") or "").strip()
                if target_name in values_by_target or target_name not in target_names:
                    raise ApiError(
                        ErrorCode.INTERNAL_ERROR,
                        "AI gateway review preview returned an invalid target column",
                        status.HTTP_502_BAD_GATEWAY,
                    )
                values_by_target[target_name] = item.get("value")
            if list(values_by_target) != target_names:
                raise ApiError(
                    ErrorCode.INTERNAL_ERROR,
                    "AI gateway review preview did not return every requested column in order",
                    status.HTTP_502_BAD_GATEWAY,
                )
            for column in columns:
                target_name = str(column["targetName"])
                allowed_values = [str(value) for value in column.get("allowedValues") or []]
                value = values_by_target[target_name]
                if column.get("method") == "one_of_values" and str(value) not in allowed_values:
                    raise ApiError(
                        ErrorCode.INTERNAL_ERROR,
                        "AI gateway review preview returned a value outside allowedValues",
                        status.HTTP_502_BAD_GATEWAY,
                    )
            projected_rows.append({key: "" if value is None else str(value) for key, value in values_by_target.items()})
            model = str(output.get("model") or "").strip()
            provider = str(output.get("provider") or "").strip()
            if not model or not provider:
                raise ApiError(
                    ErrorCode.INTERNAL_ERROR,
                    "AI gateway review preview omitted provider provenance",
                    status.HTTP_502_BAD_GATEWAY,
                )
            if model not in models:
                models.append(model)
            if provider not in providers:
                providers.append(provider)
        return {
            "rows": projected_rows,
            "model": ", ".join(models),
            "provider": ", ".join(providers),
            "models": models,
            "providers": providers,
            "runtime": "gateway",
            "status": "success",
        }

    def run(self, request: dict[str, Any]) -> dict[str, Any]:
        payload = self._validated_run_payload(request)
        if request.get("runId"):
            payload["runId"] = str(request["runId"])
        result = self._call_node("reviewAnalysis.run", payload)
        gateway_usage = result.pop("__gatewayUsage", [])
        training_rows = result.pop("__trainingRows", [])
        training_columns = result.pop("__trainingColumns", [])
        AiGatewayClient.persist_generation_usage_batch(
            gateway_usage if isinstance(gateway_usage, list) else [],
            mode="review_row",
        )
        if payload.get("trainModels"):
            result["modelTraining"] = self._train_models(
                run_id=str(result.get("runId") or payload.get("runId") or uuid4().hex),
                result=result,
                training_columns=training_columns if isinstance(training_columns, list) else [],
                training_rows=training_rows if isinstance(training_rows, list) else [],
            )
        return result

    def _train_models(
        self,
        *,
        run_id: str,
        result: dict[str, Any],
        training_columns: list[Any],
        training_rows: list[Any],
    ) -> dict[str, Any]:
        classification_columns = self._classification_training_columns(training_columns)
        if not classification_columns:
            return {"status": "not_applicable", "artifacts": [], "message": "분류형 출력 컬럼이 없습니다."}
        if len(training_rows) < 8:
            return {
                "status": "insufficient_training_rows",
                "artifacts": [],
                "message": "검증 가능한 모델 학습에는 AI 라벨이 적용된 실제 행이 최소 8개 필요합니다.",
                "trainingRows": len(training_rows),
            }

        model_root = self._model_root()
        output_dir = self._output_root() / "model-training" / run_id
        model_root.mkdir(parents=True, exist_ok=True)
        output_dir.mkdir(parents=True, exist_ok=True)
        request_payload = self._training_request_payload(
            run_id=run_id,
            result=result,
            classification_columns=classification_columns,
            training_rows=training_rows,
        )
        manifest, failure_message = self._execute_model_training(
            request_payload=request_payload,
            output_dir=output_dir,
            model_root=model_root,
        )
        if manifest is None:
            return {
                "status": "failed",
                "artifacts": [],
                "message": failure_message,
                "trainingRows": len(training_rows),
            }
        return self._model_training_response(manifest, request_payload, len(training_rows))

    @staticmethod
    def _classification_training_columns(training_columns: list[Any]) -> list[dict[str, Any]]:
        return [
            column
            for column in training_columns
            if isinstance(column, dict) and str(column.get("method") or "").strip() == "one_of_values"
        ]

    @staticmethod
    def _training_request_payload(
        *,
        run_id: str,
        result: dict[str, Any],
        classification_columns: list[dict[str, Any]],
        training_rows: list[Any],
    ) -> dict[str, Any]:
        analysis = result.get("analysis") if isinstance(result.get("analysis"), dict) else {}
        return {
            "columns": classification_columns,
            "trainRows": training_rows,
            "minimumQuality": float(os.environ.get("ASKLAKE_REVIEW_MODEL_MINIMUM_QUALITY", "0.75")),
            "minimumClassRows": _bounded_int(
                os.environ.get("ASKLAKE_REVIEW_MODEL_MINIMUM_CLASS_ROWS"),
                default=2,
                minimum=2,
                maximum=100,
            ),
            "requireAllAllowedValues": True,
            "templateName": f"ai_gateway_review_{run_id}",
            "labelSource": "ai_gateway",
            "labelModels": analysis.get("models") if isinstance(analysis.get("models"), list) else [],
            "source": result.get("source") if isinstance(result.get("source"), dict) else {},
        }

    @staticmethod
    def _execute_model_training(
        *,
        request_payload: dict[str, Any],
        output_dir: Path,
        model_root: Path,
    ) -> tuple[dict[str, Any] | None, str]:
        script_path = Path(__file__).resolve().parents[2] / "scripts" / "train_text_structuring_models.py"
        try:
            completed = subprocess.run(
                [
                    sys.executable,
                    str(script_path),
                    "--output-dir",
                    str(output_dir),
                    "--latest-dir",
                    str(model_root),
                ],
                input=json.dumps(request_payload, ensure_ascii=False),
                capture_output=True,
                check=False,
                text=True,
                timeout=max(1, int(os.environ.get("ASKLAKE_MODEL_TRAINING_TIMEOUT_SECONDS", "900"))),
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            return None, f"모델 학습 프로세스를 실행하지 못했습니다: {error.__class__.__name__}"
        if completed.returncode != 0:
            return None, "모델 학습 또는 품질 검증에 실패했습니다."
        try:
            manifest = json.loads(completed.stdout)
        except json.JSONDecodeError:
            return None, "모델 학습 결과 형식이 올바르지 않습니다."
        if not isinstance(manifest, dict):
            return None, "모델 학습 결과 형식이 올바르지 않습니다."
        return manifest, ""

    @staticmethod
    def _model_training_response(
        manifest: dict[str, Any],
        request_payload: dict[str, Any],
        training_row_count: int,
    ) -> dict[str, Any]:
        trained_models = manifest.get("trainedModels") if isinstance(manifest, dict) and isinstance(manifest.get("trainedModels"), dict) else {}
        artifacts = [
            {
                "targetColumn": target,
                "artifact": model.get("artifact"),
                "metrics": model.get("metrics") if isinstance(model.get("metrics"), dict) else {},
                "status": model.get("status"),
            }
            for target, model in trained_models.items()
            if isinstance(model, dict)
        ]
        promoted = str(manifest.get("promotionStatus") or "") == "promoted"
        return {
            "status": "success" if promoted else "quality_gate_failed",
            "artifacts": artifacts,
            "labelModels": request_payload["labelModels"],
            "labelSource": "ai_gateway",
            "message": "검증된 모델을 Spark 런타임에 게시했습니다." if promoted else "일부 분류 모델이 클래스·품질 기준을 통과하지 못해 게시하지 않았습니다.",
            "trainingRows": training_row_count,
        }

    def _validated_run_payload(self, request: dict[str, Any]) -> dict[str, Any]:
        payload = dict(request)
        runtime = str(payload.get("runtime") or os.environ.get("ASKLAKE_REVIEW_ANALYSIS_RUNTIME") or "gateway").strip().lower()
        if runtime not in {"gateway", "ai_gateway", "llm", "row_llm"}:
            raise ApiError(
                ErrorCode.VALIDATION_ERROR,
                "Review analysis supports only the configured AI Gateway runtime",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        payload["runtime"] = "gateway"
        max_rows = _bounded_int(os.environ.get("ASKLAKE_REVIEW_AI_MAX_ROWS"), default=100, minimum=1, maximum=1000)
        requested_limit = _bounded_int(payload.get("limit"), default=25, minimum=0, maximum=1_000_000)
        if bool(payload.get("full")) or requested_limit == 0 or requested_limit > max_rows:
            raise ApiError(
                ErrorCode.VALIDATION_ERROR,
                f"AI Gateway review analysis is limited to {max_rows} rows per interactive run; submit bounded batches",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                {"maxRows": max_rows, "runtime": "gateway"},
            )
        source = payload.get("source") if isinstance(payload.get("source"), dict) else {}
        default_source = self._source_descriptor()
        bucket = str(source.get("bucket") or default_source["bucket"]).strip()
        key = str(source.get("key") or default_source["key"]).strip()
        if not bucket or not key or any(character in f"{bucket}{key}" for character in ("\r", "\n", "\x00")):
            raise ApiError(
                ErrorCode.VALIDATION_ERROR,
                "Review analysis source bucket and key are required",
                status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        payload["source"] = {"bucket": bucket, "key": key}
        return payload

    @staticmethod
    def _serialize_run(row: ReviewAnalysisRunModel) -> dict[str, Any]:
        return {
            "runId": row.id,
            "status": row.status,
            "source": row.source,
            "result": row.result,
            "error": row.error,
            "createdAt": row.created_at.isoformat() if row.created_at else None,
            "startedAt": row.started_at.isoformat() if row.started_at else None,
            "finishedAt": row.finished_at.isoformat() if row.finished_at else None,
        }

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
