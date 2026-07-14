from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.schemas.integration import CatalogModelArtifactResponse


def list_catalog_model_artifacts() -> list[CatalogModelArtifactResponse]:
    root = _model_root()
    if not root.exists():
        return []
    artifacts = [
        _artifact_from_file(path)
        for path in root.rglob("*.portable_linear_svc.json")
        if path.is_file()
    ]
    return sorted(artifacts, key=lambda artifact: artifact.updated_at or "", reverse=True)


def _model_root() -> Path:
    configured = str(os.environ.get("ASKLAKE_REVIEW_TEXT_MODEL_HOST_DIR") or "").strip()
    if configured:
        return Path(configured)
    return Path(__file__).resolve().parents[2] / ".." / "output" / "nlp-eval" / "template-model-validation" / "runtime" / "latest"


def _artifact_from_file(path: Path) -> CatalogModelArtifactResponse:
    payload: dict[str, Any] = {}
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(parsed, dict):
            payload = parsed
    except (OSError, json.JSONDecodeError):
        pass

    target_column = _normalize_column(path.name.removesuffix(".portable_linear_svc.json"))
    allowed_values = payload.get("allowedValues") or payload.get("classes") or []
    metrics = payload.get("metrics") if isinstance(payload.get("metrics"), dict) else {}
    try:
        updated_at = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()
    except OSError:
        updated_at = None
    return CatalogModelArtifactResponse(
        id=f"model_{target_column}",
        allowed_values=[str(value) for value in allowed_values] if isinstance(allowed_values, list) else [],
        model_artifact=path.name,
        model_kind="portable_linear_svc",
        method="one_of_values",
        metrics=metrics,
        runtime_status="portable_text_model_available",
        status="available",
        target_column=target_column,
        updated_at=updated_at,
        validation_rows=_optional_int(metrics.get("validationRows")),
        validation_status="available_for_selection",
    )


def _normalize_column(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9]+", "_", value).strip("_").lower()
    return normalized or "model"


def _optional_int(value: Any) -> int | None:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None
