from typing import Any, Iterable


def materialization_mode(run: dict[str, Any]) -> str:
    raw_mode = run.get("materializationMode") or run.get("materialization_mode")
    mode = str(raw_mode or "").strip().casefold()
    if mode:
        return mode if mode in {"snapshot", "delta"} else "snapshot"

    source_kind = str(
        run.get("sourceKind")
        or run.get("source_kind")
        or ""
    ).strip().casefold()
    return "delta" if source_kind == "kafka" else "snapshot"


def active_materialization_runs(runs: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return successful deltas newer than the latest successful snapshot, plus that snapshot."""
    successful = [run for run in runs if run.get("status") == "success"]
    active: list[dict[str, Any]] = []
    for run in successful:
        active.append(run)
        if materialization_mode(run) == "snapshot":
            break
    return active
