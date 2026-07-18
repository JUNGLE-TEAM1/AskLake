from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
import hashlib
import json
from typing import Iterable, Literal


DimensionSemantics = Literal["current", "temporal"]
MissingPolicy = Literal["hold_and_repair", "publish_null_then_correct"]


@dataclass(frozen=True)
class DimensionRow:
    key: str
    payload: dict[str, object]
    valid_from: datetime | None = None
    valid_to: datetime | None = None
    row_version: int = 1

    def __post_init__(self) -> None:
        if not self.key.strip() or len(self.key) > 2_000:
            raise ValueError("dimension key must be bounded and non-empty")
        if self.row_version < 1:
            raise ValueError("row_version must be positive")

    def canonical_payload(self) -> str:
        return json.dumps(self.payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


@dataclass(frozen=True)
class DimensionPlan:
    semantics: DimensionSemantics
    rows: tuple[DimensionRow, ...]
    row_count: int
    checksum: str


def build_dimension_plan(
    *,
    semantics: DimensionSemantics,
    rows: Iterable[DimensionRow],
) -> DimensionPlan:
    normalized = tuple(sorted(rows, key=lambda item: (
        item.key,
        _utc(item.valid_from) or datetime.min.replace(tzinfo=UTC),
        item.row_version,
    )))
    if semantics not in {"current", "temporal"}:
        raise ValueError("dimension semantics must be current or temporal")
    if semantics == "current":
        keys = [item.key for item in normalized]
        if len(keys) != len(set(keys)):
            raise ValueError("current dimension keys must be unique within a version")
        if any(item.valid_from is not None or item.valid_to is not None for item in normalized):
            raise ValueError("current dimension rows cannot contain temporal bounds")
    else:
        _validate_temporal_intervals(normalized)
    digest = hashlib.sha256()
    for item in normalized:
        document = {
            "key": item.key,
            "payload": item.payload,
            "validFrom": _utc(item.valid_from).isoformat() if item.valid_from else None,
            "validTo": _utc(item.valid_to).isoformat() if item.valid_to else None,
            "rowVersion": item.row_version,
        }
        digest.update(json.dumps(document, sort_keys=True, separators=(",", ":")).encode("utf-8"))
        digest.update(b"\n")
    return DimensionPlan(semantics, normalized, len(normalized), digest.hexdigest())


def default_missing_policy(join_type: str) -> MissingPolicy:
    normalized = join_type.strip().upper()
    if normalized == "INNER":
        return "hold_and_repair"
    if normalized == "LEFT":
        return "publish_null_then_correct"
    raise ValueError("only INNER and LEFT JOIN missing policies are supported")


def _validate_temporal_intervals(rows: tuple[DimensionRow, ...]) -> None:
    previous_by_key: dict[str, DimensionRow] = {}
    for item in rows:
        start = _utc(item.valid_from)
        end = _utc(item.valid_to)
        if start is None:
            raise ValueError("temporal dimension rows require valid_from")
        if end is not None and end <= start:
            raise ValueError("temporal interval must be half-open with valid_to after valid_from")
        previous = previous_by_key.get(item.key)
        if previous is not None:
            previous_end = _utc(previous.valid_to)
            if previous_end is None or start < previous_end:
                raise ValueError(f"temporal dimension intervals overlap for key {item.key}")
        previous_by_key[item.key] = item


def _utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=value.tzinfo or UTC).astimezone(UTC)
