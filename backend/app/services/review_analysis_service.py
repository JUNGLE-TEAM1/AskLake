from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import status

from app.core.errors import ApiError
from app.schemas.common import ErrorCode
from app.services.ai_gateway_client import AiGatewayClient


class ReviewAnalysisService:
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
            "message": "Cell phones review analysis has not run yet.",
            "source": self._source_descriptor(),
        }

    def suggest_schema(self, request: dict[str, Any]) -> dict[str, Any]:
        source_columns = request.get("sourceColumns") or request.get("source_columns") or []
        sample_rows = request.get("sampleRows") or request.get("sample_rows") or []
        return AiGatewayClient().suggest_review_schema(
            request_id=str(uuid4()),
            source_columns=source_columns if isinstance(source_columns, list) else [],
            sample_rows=sample_rows if isinstance(sample_rows, list) else [],
        )

    def run(self, request: dict[str, Any]) -> dict[str, Any]:
        payload = dict(request)
        runtime = str(payload.get("runtime") or os.environ.get("ASKLAKE_REVIEW_ANALYSIS_RUNTIME") or "gateway").strip().lower()
        payload["runtime"] = "gateway" if runtime in {"gateway", "ai_gateway", "llm", "row_llm"} else "scalable"
        if payload["runtime"] == "gateway":
            max_rows = _bounded_int(os.environ.get("ASKLAKE_REVIEW_AI_MAX_ROWS"), default=100, minimum=1, maximum=1000)
            requested_limit = _bounded_int(payload.get("limit"), default=25, minimum=0, maximum=1_000_000)
            if bool(payload.get("full")) or requested_limit == 0 or requested_limit > max_rows:
                raise ApiError(
                    ErrorCode.VALIDATION_ERROR,
                    f"AI Gateway review analysis is limited to {max_rows} rows; use the scalable runtime for bulk processing",
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    {"maxRows": max_rows, "runtime": "gateway"},
                )
        return self._call_node("runCellphonesReviewAnalysis", payload)

    def _call_node(self, function_name: str, request: dict[str, Any]) -> dict[str, Any]:
        module_uri = (Path(__file__).resolve().parents[2] / "src" / "reviewRowAnalysis.mjs").as_uri()
        script = (
            "const module = await import(process.argv[1]);"
            f"const result = await module.{function_name}(JSON.parse(process.argv[2]));"
            "process.stdout.write(JSON.stringify(result));"
        )
        try:
            completed = subprocess.run(
                ["node", "--input-type=module", "-e", script, module_uri, json.dumps(request)],
                capture_output=True,
                check=False,
                text=True,
                timeout=max(1, int(os.environ.get("ASKLAKE_REVIEW_ANALYSIS_TIMEOUT_SECONDS", "900"))),
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise ApiError(
                ErrorCode.BACKEND_TIMEOUT,
                "Review analysis request timed out or could not start",
                status.HTTP_504_GATEWAY_TIMEOUT,
                {"message": str(error)},
            ) from error
        if completed.returncode != 0:
            raise ApiError(
                "REVIEW_ANALYSIS_FAILED",
                "Review analysis request failed",
                status.HTTP_502_BAD_GATEWAY,
                {"message": (completed.stderr or "").strip()[-2000:]},
            )
        try:
            payload = json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise ApiError(
                "REVIEW_ANALYSIS_INVALID_RESPONSE",
                "Review analysis returned invalid JSON",
                status.HTTP_502_BAD_GATEWAY,
            ) from error
        if not isinstance(payload, dict):
            raise ApiError(
                "REVIEW_ANALYSIS_INVALID_RESPONSE",
                "Review analysis returned an invalid response",
                status.HTTP_502_BAD_GATEWAY,
            )
        return payload

    def _output_root(self) -> Path:
        configured = str(os.environ.get("ASKLAKE_REVIEW_ANALYSIS_DIR") or "").strip()
        return Path(configured) if configured else Path(__file__).resolve().parents[2] / "tmp" / "review-row-analysis"

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
