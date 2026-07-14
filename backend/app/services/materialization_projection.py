from collections.abc import Mapping
from datetime import UTC, datetime
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


def upsert_materialization_run(
    previous_runs: Any,
    next_run: dict[str, Any],
) -> list[dict[str, Any]]:
    runs = [dict(run) for run in previous_runs if isinstance(run, dict)] if isinstance(previous_runs, list) else []
    run_id = str(next_run.get("runId") or "")
    if not run_id:
        return sorted(runs, key=materialization_run_sort_key, reverse=True)

    kafka_snapshot_id = nested_identity(next_run, "kafkaSnapshot", "snapshotId")
    iceberg_snapshot_id = str(next_run.get("icebergSnapshotId") or "")
    deduplicated = [
        run
        for run in runs
        if str(run.get("runId") or "") != run_id
        and (not kafka_snapshot_id or nested_identity(run, "kafkaSnapshot", "snapshotId") != kafka_snapshot_id)
        and (not iceberg_snapshot_id or str(run.get("icebergSnapshotId") or "") != iceberg_snapshot_id)
    ]
    return sorted(
        [dict(next_run), *deduplicated],
        key=materialization_run_sort_key,
        reverse=True,
    )


def materialization_run_sort_key(run: Mapping[str, Any]) -> tuple[datetime, str, str]:
    timestamp = parse_materialization_timestamp(
        run.get("icebergCommittedAt")
        or run.get("iceberg_committed_at")
        or run.get("createdAt")
        or run.get("created_at")
    )
    snapshot_id = str(run.get("icebergSnapshotId") or run.get("iceberg_snapshot_id") or "")
    return timestamp, snapshot_id, str(run.get("runId") or run.get("run_id") or "")


def parse_materialization_timestamp(value: Any) -> datetime:
    text = str(value or "").strip()
    if not text:
        return datetime.min.replace(tzinfo=UTC)
    if text.upper().endswith(" UTC"):
        text = f"{text[:-4]}+00:00"
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return datetime.min.replace(tzinfo=UTC)
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)


def nested_identity(run: Mapping[str, Any], object_key: str, value_key: str) -> str:
    nested = run.get(object_key)
    return str(nested.get(value_key) or "") if isinstance(nested, Mapping) else ""


def parse_count_value(value: Any) -> int:
    if isinstance(value, bool) or value is None:
        return 0
    if isinstance(value, int):
        return max(value, 0)
    if isinstance(value, float):
        return max(int(value), 0)
    digits = "".join(character for character in str(value) if character.isdigit())
    return int(digits) if digits else 0
