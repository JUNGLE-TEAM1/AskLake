from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

from fastapi import status

from app.core.errors import ApiError
from app.schemas.common import ErrorCode


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
        return self._call_node("suggestReviewAnalysisSchema", request)

    def run(self, request: dict[str, Any]) -> dict[str, Any]:
        return self._call_node("runCellphonesReviewAnalysis", request)

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
