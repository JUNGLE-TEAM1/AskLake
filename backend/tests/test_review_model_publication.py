from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

from app.services.catalog_model_service import list_catalog_model_artifacts


def _training_request() -> dict[str, object]:
    rows = []
    for index in range(10):
        rows.append({
            "title": "Excellent product",
            "text": f"Works perfectly and I love it number {index}",
            "rating": 5,
            "labels": {"sentiment": "positive"},
        })
        rows.append({
            "title": "Broken product",
            "text": f"Defective and stopped working number {index}",
            "rating": 1,
            "labels": {"sentiment": "negative"},
        })
    return {
        "columns": [{
            "allowedValues": ["positive", "negative"],
            "method": "one_of_values",
            "targetName": "sentiment",
        }],
        "labelModels": ["gateway-model-real"],
        "labelSource": "ai_gateway",
        "minimumClassRows": 2,
        "minimumQuality": 0.75,
        "source": {"bucket": "actual-amazon", "key": "reviews.jsonl"},
        "trainRows": rows,
    }


def _run_trainer(tmp_path: Path, payload: dict[str, object]) -> tuple[dict[str, object], Path]:
    output_dir = tmp_path / "run"
    latest_dir = tmp_path / "latest"
    script = Path(__file__).parents[1] / "scripts" / "train_text_structuring_models.py"
    completed = subprocess.run(
        [
            sys.executable,
            str(script),
            "--output-dir",
            str(output_dir),
            "--latest-dir",
            str(latest_dir),
        ],
        input=json.dumps(payload),
        capture_output=True,
        check=False,
        text=True,
        timeout=60,
    )
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout), latest_dir


def test_model_publication_requires_provenance_and_publishes_verified_artifact(
    tmp_path: Path,
    monkeypatch,
) -> None:
    manifest, latest_dir = _run_trainer(tmp_path, _training_request())

    assert manifest["promotionStatus"] == "promoted"
    model = manifest["trainedModels"]["sentiment"]
    assert model["validationCoversAllClasses"] is True
    assert set(model["metrics"]["validationLabelCounts"]) == {"positive", "negative"}
    artifact_path = latest_dir / model["artifact"]
    expected_digest = manifest["artifactSha256s"][model["artifact"]]
    assert hashlib.sha256(artifact_path.read_bytes()).hexdigest() == expected_digest

    artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
    assert artifact["provenance"]["labelSource"] == "ai_gateway"
    assert artifact["provenance"]["labelModels"] == ["gateway-model-real"]
    assert artifact["provenance"]["source"]["bucket"] == "actual-amazon"

    monkeypatch.setenv("ASKLAKE_REVIEW_TEXT_MODEL_HOST_DIR", str(latest_dir))
    listed = list_catalog_model_artifacts()
    assert len(listed) == 1
    assert listed[0].target_column == "sentiment"

    artifact_path.write_text(artifact_path.read_text(encoding="utf-8") + " ", encoding="utf-8")
    assert list_catalog_model_artifacts() == []


def test_model_training_rejects_unverifiable_label_source(tmp_path: Path) -> None:
    payload = _training_request()
    payload["labelSource"] = "unknown"
    output_dir = tmp_path / "run"
    latest_dir = tmp_path / "latest"
    script = Path(__file__).parents[1] / "scripts" / "train_text_structuring_models.py"
    completed = subprocess.run(
        [sys.executable, str(script), "--output-dir", str(output_dir), "--latest-dir", str(latest_dir)],
        input=json.dumps(payload),
        capture_output=True,
        check=False,
        text=True,
        timeout=60,
        env=os.environ.copy(),
    )

    assert completed.returncode != 0
    assert not (latest_dir / "manifest.json").exists()
