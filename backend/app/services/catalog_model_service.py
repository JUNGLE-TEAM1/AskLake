from __future__ import annotations

import hashlib
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
    manifest = _published_manifest(root)
    trained_models = manifest.get("trainedModels") if isinstance(manifest.get("trainedModels"), dict) else {}
    digests = manifest.get("artifactSha256s") if isinstance(manifest.get("artifactSha256s"), dict) else {}
    artifacts: list[CatalogModelArtifactResponse] = []
    for target, published in trained_models.items():
        if not isinstance(published, dict) or published.get("status") != "trained":
            continue
        artifact_name = Path(str(published.get("artifact") or "")).name
        digest = str(digests.get(artifact_name) or "").strip().lower()
        path = (root / artifact_name).resolve()
        if not artifact_name or not digest or path.parent != root.resolve() or not path.is_file():
            continue
        artifact = _artifact_from_file(path, expected_digest=digest, expected_target=str(target))
        if artifact is not None:
            artifacts.append(artifact)
    return sorted(artifacts, key=lambda artifact: artifact.updated_at or "", reverse=True)


def _model_root() -> Path:
    configured = str(os.environ.get("ASKLAKE_REVIEW_TEXT_MODEL_HOST_DIR") or "").strip()
    if configured:
        return Path(configured)
    return Path(__file__).resolve().parents[2] / "tmp" / "review-text-models" / "latest"


def _published_manifest(root: Path) -> dict[str, Any]:
    try:
        manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(manifest, dict) or manifest.get("promotionStatus") != "promoted":
        return {}
    if not isinstance(manifest.get("artifactSha256s"), dict):
        return {}
    return manifest


def _artifact_from_file(
    path: Path,
    *,
    expected_digest: str,
    expected_target: str,
) -> CatalogModelArtifactResponse | None:
    if _sha256_file(path) != expected_digest:
        return None
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(parsed, dict):
            return None
    except (OSError, json.JSONDecodeError):
        return None
    payload = parsed

    target_column = _normalize_column(payload.get("targetName") or payload.get("targetColumn") or "")
    allowed_values = payload.get("allowedValues") or payload.get("classes") or []
    metrics = payload.get("metrics") if isinstance(payload.get("metrics"), dict) else {}
    provenance = payload.get("provenance") if isinstance(payload.get("provenance"), dict) else {}
    classes = payload.get("classes") if isinstance(payload.get("classes"), list) else []
    label_source = str(provenance.get("labelSource") or "").strip().lower()
    label_models = [str(value).strip() for value in provenance.get("labelModels") or [] if str(value).strip()]
    provenance_source = provenance.get("source") if isinstance(provenance.get("source"), dict) else {}
    minimum_quality = float(os.environ.get("ASKLAKE_REVIEW_MODEL_MINIMUM_QUALITY", "0.75"))
    accuracy = _optional_float(metrics.get("accuracy"))
    macro_f1 = _optional_float(metrics.get("macroF1"))
    validation_rows = _optional_int(metrics.get("validationRows"))
    validation_counts = metrics.get("validationLabelCounts") if isinstance(metrics.get("validationLabelCounts"), dict) else {}
    class_values = [str(value) for value in classes]
    allowed_value_strings = [str(value) for value in allowed_values] if isinstance(allowed_values, list) else []
    if (
        not target_column
        or target_column != _normalize_column(expected_target)
        or not isinstance(allowed_values, list)
        or not allowed_values
        or not classes
        or {value.strip().lower() for value in class_values} != {value.strip().lower() for value in allowed_value_strings}
        or label_source not in {"ai_gateway", "human_labeled"}
        or (label_source == "ai_gateway" and not label_models)
        or not provenance_source
        or accuracy is None
        or macro_f1 is None
        or accuracy < minimum_quality
        or macro_f1 < minimum_quality
        or not validation_rows
        or validation_rows < len(class_values)
        or any(int(validation_counts.get(value) or 0) <= 0 for value in class_values)
    ):
        return None
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
        provenance=provenance,
        runtime_status="portable_text_model_available",
        status="available",
        target_column=target_column,
        updated_at=updated_at,
        validation_rows=validation_rows,
        validation_status="quality_gate_passed",
    )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        return ""
    return digest.hexdigest()


def _normalize_column(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9]+", "_", value).strip("_").lower()
    return normalized or "model"


def _optional_int(value: Any) -> int | None:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _optional_float(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None
