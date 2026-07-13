from collections.abc import Mapping
from typing import Any, Literal


MaterializationMode = Literal["snapshot", "delta"]


def canonical_materialization_mode(run: Mapping[str, Any]) -> MaterializationMode:
    explicit_mode = str(
        run.get("materializationMode")
        or run.get("materialization_mode")
        or ""
    ).strip().casefold()
    if explicit_mode:
        return "delta" if explicit_mode == "delta" else "snapshot"

    source_kind = str(
        run.get("sourceKind")
        or run.get("source_kind")
        or ""
    ).strip().casefold()
    return "delta" if source_kind == "kafka" else "snapshot"


def active_materialization_runs(runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return the current logical dataset segments from newest-first run history."""
    active_runs: list[dict[str, Any]] = []
    for run in runs:
        if str(run.get("status") or "").strip().casefold() != "success":
            continue
        active_runs.append(run)
        if canonical_materialization_mode(run) == "snapshot":
            break
    return active_runs


def aggregate_materialization_runs(runs: list[dict[str, Any]]) -> dict[str, Any]:
    active_runs = active_materialization_runs(runs)
    latest_run = active_runs[0] if active_runs else None
    return {
        "activeRunIds": [str(run.get("runId") or "") for run in active_runs],
        "latestRunId": latest_run.get("runId") if latest_run else None,
        "latestStorageFormat": latest_run.get("storageFormat") if latest_run else None,
        "latestStorageLocation": latest_run.get("storageLocation") if latest_run else None,
        "lastUpdated": latest_run.get("createdAt") if latest_run else None,
        "rowCount": sum(parse_count_value(run.get("rowCount")) for run in active_runs),
        "storageSizeBytes": sum(parse_count_value(run.get("storageSizeBytes")) for run in active_runs),
    }


def parse_count_value(value: Any) -> int:
    if isinstance(value, bool) or value is None:
        return 0
    if isinstance(value, int):
        return max(value, 0)
    if isinstance(value, float):
        return max(int(value), 0)
    digits = "".join(character for character in str(value) if character.isdigit())
    return int(digits) if digits else 0
