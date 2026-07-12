from typing import Any, Iterable


def materialization_mode(run: dict[str, Any]) -> str:
    mode = str(run.get("materializationMode") or run.get("materialization_mode") or "").strip().casefold()
    return mode if mode in {"snapshot", "delta"} else "snapshot"


def active_materialization_runs(runs: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return the newest snapshot and only the successful deltas newer than it."""
    successful = [run for run in runs if run.get("status") == "success"]
    active: list[dict[str, Any]] = []
    for run in successful:
        active.append(run)
        if materialization_mode(run) == "snapshot":
            break
    return active


def materialization_source_window(run: dict[str, Any]) -> dict[str, Any] | None:
    value = run.get("sourceWindow") or run.get("source_window")
    return value if isinstance(value, dict) else None


def has_bounded_source_window(run: dict[str, Any]) -> bool:
    window = materialization_source_window(run)
    if not window:
        return False
    version = window.get("contractVersion") or window.get("contract_version")
    upper = window.get("upperBound") or window.get("upper_bound")
    try:
        return int(version) == 1 and bool(str(upper or "").strip())
    except (TypeError, ValueError):
        return False
