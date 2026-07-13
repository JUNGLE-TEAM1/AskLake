#!/usr/bin/env python3
"""Verify Python Storage Layout V1 conformance against the shared fixture."""

from __future__ import annotations

import json
from pathlib import Path

from app.core.errors import ApiError
from app.services.storage_layout import (
    assert_production_data_plane_path,
    canonical_object_storage_uri,
    create_storage_layout,
    storage_layout_config,
)


BACKEND_DIR = Path(__file__).resolve().parents[1]
CONTRACT = json.loads(
    (BACKEND_DIR / "fixtures" / "contracts" / "storage-layout-v1.json").read_text(encoding="utf-8")
)


def main() -> None:
    for case in CONTRACT["cases"]:
        request = case["input"]
        actual = create_storage_layout(
            dataset_id=request["datasetId"],
            explicit_root=request.get("explicitRoot"),
            job_id=request.get("jobId"),
            layer=request.get("layer", "bronze"),
            run_id=request.get("runId"),
            bucket=request.get("bucket"),
            environment=case["environment"],
        )
        comparable = {name: actual[name] for name in case["expected"]}
        assert comparable == case["expected"], case["name"]

    defaults = storage_layout_config({})
    assert defaults["retentionDays"] == CONTRACT["defaults"]["retentionDays"]
    configured = storage_layout_config({
        "ASKLAKE_STORAGE_DATA_RETENTION_DAYS": "365",
        "ASKLAKE_STORAGE_CHECKPOINT_RETENTION_DAYS": "7",
        "ASKLAKE_STORAGE_MANIFEST_RETENTION_DAYS": "45",
        "ASKLAKE_STORAGE_QUARANTINE_RETENTION_DAYS": "21",
        "ASKLAKE_STORAGE_LOG_RETENTION_DAYS": "3",
    })
    assert configured["retentionDays"] == {
        "data": 365,
        "checkpoints": 7,
        "manifests": 45,
        "quarantine": 21,
        "logs": 3,
    }

    for case in CONTRACT["invalidCases"]:
        try:
            canonical_object_storage_uri(case["value"], {})
        except ApiError as error:
            assert error.code == "STORAGE_LAYOUT_INVALID", case["name"]
        else:
            raise AssertionError(f"Invalid URI was accepted: {case['name']}")

    try:
        assert_production_data_plane_path("file:///tmp/output", {"APP_ENV": "production"})
    except ApiError as error:
        assert error.code == "STORAGE_LAYOUT_LOCAL_PATH_FORBIDDEN"
    else:
        raise AssertionError("Production local data-plane path must be rejected")

    print("Python Storage Layout V1 contract verification passed")


if __name__ == "__main__":
    main()
