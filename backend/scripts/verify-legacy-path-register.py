#!/usr/bin/env python3
"""Validate ownership, guards, and observability of retained legacy paths."""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
REGISTER = ROOT / "docs/refactor-2026/legacy-path-register.json"
REQUIRED_FIELDS = {
    "activation",
    "classification",
    "id",
    "marker",
    "owner",
    "paths",
    "reachability",
    "removalCondition",
    "targetRelease",
    "telemetry",
}
REQUIRED_PATHS = {
    "auth.header-fallback",
    "catalog.synthetic-lineage-fallback",
    "continuous.legacy-error-string",
    "dashboard-assistant.degraded-no-ai",
    "dashboard.legacy-color-map",
    "etl.legacy-permission-roles",
    "frontend.catalog-local-storage",
    "frontend.etl-draft-v0",
    "frontend.initial-read-degraded",
    "frontend.mock-api",
    "frontend.source-direct-backend",
    "rules.legacy-draft-adapter",
    "runtime.versionless-json-reader",
    "sql.duckdb-compatibility-engine",
}


def main() -> int:
    payload = json.loads(REGISTER.read_text(encoding="utf-8"))
    entries = payload.get("entries", [])
    failures: list[str] = []
    ids: set[str] = set()
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            failures.append(f"entry {index} is not an object")
            continue
        missing = REQUIRED_FIELDS - set(entry)
        if missing:
            failures.append(f"entry {index} missing fields: {sorted(missing)}")
            continue
        path_id = str(entry["id"])
        if path_id in ids:
            failures.append(f"duplicate id: {path_id}")
        ids.add(path_id)
        if entry["reachability"] == "production" and entry["telemetry"] != "structured_warning+counter":
            failures.append(f"production path lacks standard telemetry: {path_id}")
        source_text = ""
        for relative in entry["paths"]:
            source = ROOT / relative
            if not source.is_file():
                failures.append(f"registered source is missing for {path_id}: {relative}")
                continue
            source_text += source.read_text(encoding="utf-8", errors="replace")
        if str(entry["marker"]) not in source_text:
            failures.append(f"marker not found for {path_id}: {entry['marker']}")

    missing_paths = REQUIRED_PATHS - ids
    if missing_paths:
        failures.append(f"required semantic paths are not registered: {sorted(missing_paths)}")

    runtime_mode = (ROOT / "frontend/src/services/apiRuntimeMode.ts").read_text(encoding="utf-8")
    if "requested && !isDevelopment" not in runtime_mode or "throw new Error" not in runtime_mode:
        failures.append("production mock API mode does not fail closed")

    print(json.dumps({
        "entryCount": len(entries),
        "failures": failures,
        "productionPathCount": sum(entry.get("reachability") == "production" for entry in entries if isinstance(entry, dict)),
        "status": "fail" if failures else "pass",
    }, ensure_ascii=False, indent=2, sort_keys=True))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
