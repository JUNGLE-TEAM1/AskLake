from typing import Any, Iterable


SOURCE_WINDOW_CONTRACT_VERSION = 2
SUPPORTED_SOURCE_WINDOW_CONTRACT_VERSIONS = frozenset({1, SOURCE_WINDOW_CONTRACT_VERSION})


def materialization_mode(run: dict[str, Any]) -> str:
    mode_values = [
        run.get("materializationMode"),
        run.get("materialization_mode"),
        run.get("spark_materialization_mode"),
    ]
    raw_mode = next((value for value in mode_values if str(value or "").strip()), None)
    has_explicit_mode = raw_mode is not None
    mode = str(raw_mode or "").strip().casefold()
    if mode in {"snapshot", "delta"}:
        return mode
    if has_explicit_mode:
        return "snapshot"
    source_kind = str(run.get("sourceKind") or run.get("source_kind") or "").strip().casefold()
    return "delta" if source_kind == "kafka" else "snapshot"


def active_materialization_runs(runs: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return the newest snapshot and successful deltas newer than it."""
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


def source_window_contract_version(run: dict[str, Any]) -> int | None:
    window = materialization_source_window(run)
    if not window:
        return None
    version = window.get("contractVersion") or window.get("contract_version")
    try:
        parsed = int(version)
    except (TypeError, ValueError):
        return None
    return parsed if parsed in SUPPORTED_SOURCE_WINDOW_CONTRACT_VERSIONS else None


def materialization_source_object_inventory(run: dict[str, Any]) -> list[dict[str, Any]] | None:
    window = materialization_source_window(run)
    if not window:
        return None
    value = window.get("objectInventory") if "objectInventory" in window else window.get("object_inventory")
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        return None
    return list(value)


def has_bounded_source_window(run: dict[str, Any]) -> bool:
    window = materialization_source_window(run)
    if not window:
        return False
    upper = window.get("upperBound") or window.get("upper_bound")
    return source_window_contract_version(run) is not None and bool(str(upper or "").strip())
