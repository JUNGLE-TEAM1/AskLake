from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from fastapi import status

from app.core.errors import ApiError
from app.infrastructure.runtime_io import VersionedNodeBridge
from app.ports.runtime_io import VersionedNodeBridgePort
from app.schemas.common import ErrorCode


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
            "message": "Cell phones review analysis has not run yet.",
            "source": self._source_descriptor(),
        }

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
