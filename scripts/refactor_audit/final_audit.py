#!/usr/bin/env python3
"""Create deterministic final-refactor measurements and comparison evidence."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any, Mapping

try:
    from .collect_baseline import ROOT, collect_code_metrics, collect_contracts, write_json
except ImportError:  # Direct script execution.
    from collect_baseline import ROOT, collect_code_metrics, collect_contracts, write_json


DEFAULT_BASELINE = ROOT / "docs/refactor-2026/baseline/artifacts"
DEFAULT_OUTPUT = ROOT / "docs/refactor-2026/final/artifacts"
LEGACY_REGISTER = ROOT / "docs/refactor-2026/legacy-path-register.json"


def load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Expected JSON object: {path}")
    return payload


def delta(current: int, baseline: int) -> dict[str, int]:
    return {"baseline": baseline, "current": current, "delta": current - baseline}


def contract_keys(contracts: Mapping[str, Any]) -> dict[str, set[str]]:
    routes = {
        f"{item['method']} {item['path']}"
        for item in contracts.get("api_routes", [])
        if isinstance(item, Mapping) and item.get("method") and item.get("path")
    }
    models = contracts.get("models", {})
    tables = {
        str(item["table"])
        for item in models.get("tables", [])
        if isinstance(item, Mapping) and item.get("table")
    }
    return {
        "apiRoutes": routes,
        "persistedTables": tables,
        "frontendRoutes": set(contracts.get("frontend", {}).get("route_literals", [])),
        "wizardFlows": set(contracts.get("frontend", {}).get("wizard_flows", [])),
    }


def coupling_inventory() -> dict[str, dict[str, Any]]:
    patterns = {
        "processInvocation": re.compile(r"\b(?:subprocess\.|spawnSync\(|spawn\(|execFile\(|execFileSync\()"),
        "dockerCommandLiteral": re.compile(r"(?:docker compose|docker exec|docker run)"),
        "rawRuntimeFileAccess": re.compile(r"(?:report|checkpoint|manifest).{0,80}(?:read_text|write_text|open\()", re.IGNORECASE),
    }
    inventories: dict[str, dict[str, Any]] = {}
    roots = (ROOT / "backend/app", ROOT / "backend/scripts", ROOT / "backend/src")
    paths = sorted(
        path
        for root in roots
        for path in root.rglob("*")
        if path.is_file() and path.suffix in {".js", ".mjs", ".py", ".ts"}
    )
    for name, pattern in patterns.items():
        matches = []
        for path in paths:
            content = path.read_text(encoding="utf-8", errors="replace")
            if pattern.search(content):
                matches.append(path.relative_to(ROOT).as_posix())
        inventories[name] = {"fileCount": len(matches), "files": matches}
    return inventories


def legacy_evidence() -> dict[str, Any]:
    register = load_json(LEGACY_REGISTER)
    entries = register.get("entries", [])
    production = [item for item in entries if item.get("reachability") == "production"]
    invalid = [
        item.get("id", "<missing-id>")
        for item in entries
        if not all(item.get(key) for key in ("id", "owner", "removalCondition", "targetRelease", "telemetry"))
    ]
    unobserved = [item.get("id", "<missing-id>") for item in production if item.get("telemetry") != "structured_warning+counter"]
    return {
        "registered": len(entries),
        "productionReachable": len(production),
        "invalidEntries": invalid,
        "productionWithoutStructuredTelemetry": unobserved,
    }


def build_comparison(
    baseline_metrics: Mapping[str, Any],
    current_metrics: Mapping[str, Any],
    baseline_contracts: Mapping[str, Any],
    current_contracts: Mapping[str, Any],
) -> dict[str, Any]:
    baseline_summary = baseline_metrics["summary"]
    current_summary = current_metrics["summary"]
    metric_names = (
        "files",
        "loc",
        "files_over_500_lines",
        "files_over_1000_lines",
        "files_over_2000_lines",
        "files_over_5000_lines",
    )
    baseline_keys = contract_keys(baseline_contracts)
    current_keys = contract_keys(current_contracts)
    removed_contracts = {
        name: sorted(values - current_keys[name])
        for name, values in baseline_keys.items()
    }
    cycles = current_metrics["import_graph"]
    etl_service = next(
        (item for item in current_metrics["largest_files"] if item["file"] == "backend/app/services/etl_service.py"),
        {"loc": 0},
    )
    return {
        "schemaVersion": 1,
        "baselineHead": baseline_metrics.get("head"),
        "currentHead": current_metrics.get("head"),
        "metrics": {
            name: delta(int(current_summary[name]), int(baseline_summary[name]))
            for name in metric_names
        },
        "pythonFunctionsOver100Lines": delta(
            int(current_metrics["python"]["functions_over_100_lines"]),
            int(baseline_metrics["python"]["functions_over_100_lines"]),
        ),
        "largestFiles": current_metrics["largest_files"][:20],
        "importCycles": {
            "python": cycles["python_cycles"],
            "backendJavaScript": cycles["backend_js_cycles"],
            "frontend": cycles["frontend_cycles"],
        },
        "termInventory": {
            term: delta(
                int(current_metrics["term_inventory"][term]["file_count"]),
                int(baseline_metrics["term_inventory"][term]["file_count"]),
            )
            for term in ("fallback", "mock", "legacy", "compatibility")
        },
        "contracts": {
            "baselineCounts": {name: len(values) for name, values in baseline_keys.items()},
            "currentCounts": {name: len(values) for name, values in current_keys.items()},
            "removed": removed_contracts,
        },
        "couplingInventory": coupling_inventory(),
        "legacyRegister": legacy_evidence(),
        "hardFacts": {
            "noImportCycles": not any(
                cycles[name]
                for name in ("python_cycles", "backend_js_cycles", "frontend_cycles")
            ),
            "noRemovedStaticContracts": not any(removed_contracts.values()),
            "noPythonSyntaxErrors": not current_metrics["python"]["syntax_errors"],
            "legacyProductionPathsObserved": not legacy_evidence()["productionWithoutStructuredTelemetry"],
            "etlServiceWithinTarget": int(etl_service["loc"]) <= 1200,
        },
    }


def repository_path(value: str) -> Path:
    path = (ROOT / value).resolve()
    if ROOT not in path.parents:
        raise SystemExit("path must stay inside the repository")
    return path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline-dir", default=str(DEFAULT_BASELINE.relative_to(ROOT)))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT.relative_to(ROOT)))
    args = parser.parse_args()
    baseline_dir = repository_path(args.baseline_dir)
    output_dir = repository_path(args.output_dir)
    baseline_metrics = load_json(baseline_dir / "code-metrics.json")
    baseline_contracts = load_json(baseline_dir / "contracts.json")
    current_metrics = collect_code_metrics()
    current_contracts = collect_contracts()
    comparison = build_comparison(baseline_metrics, current_metrics, baseline_contracts, current_contracts)
    write_json(output_dir / "code-metrics.json", current_metrics)
    write_json(output_dir / "contracts.json", current_contracts)
    write_json(output_dir / "final-audit.json", comparison)
    for name in ("code-metrics.json", "contracts.json", "final-audit.json"):
        print((output_dir / name).relative_to(ROOT))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
