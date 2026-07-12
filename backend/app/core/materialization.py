from typing import Any, Iterable


def materialization_mode(run: dict[str, Any]) -> str:
    mode = str(run.get("materializationMode") or run.get("materialization_mode") or "").strip().casefold()
    return mode if mode in {"snapshot", "delta"} else "snapshot"


def active_materialization_runs(runs: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return successful deltas newer than the latest successful snapshot, plus that snapshot."""
    successful = [run for run in runs if run.get("status") == "success"]
    active: list[dict[str, Any]] = []
    for run in successful:
        active.append(run)
        if materialization_mode(run) == "snapshot":
            break
    return active
