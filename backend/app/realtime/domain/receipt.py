from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from typing import Iterable, Literal

from app.realtime.domain.source_position import SourcePosition


ReceiptStatus = Literal["contiguous", "blocked"]


@dataclass(frozen=True)
class ReceiptAudit:
    topic: str
    partition: int
    from_offset_inclusive: int
    to_offset_inclusive: int
    expected_offsets: tuple[int, ...]
    raw_offsets: tuple[int, ...]
    resolved_offsets: tuple[int, ...]
    missing_offsets: tuple[int, ...]
    unexpected_offsets: tuple[int, ...]
    status: ReceiptStatus
    expected_positions_hash: str
    raw_or_resolved_positions_hash: str
    advance_to_offset: int | None


def _offset_hash(offsets: Iterable[int]) -> str:
    payload = json.dumps(sorted(set(offsets)), separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def audit_receipt_range(
    *,
    expected: Iterable[SourcePosition],
    raw: Iterable[SourcePosition],
    resolved: Iterable[SourcePosition] = (),
    max_positions: int = 10_000,
) -> ReceiptAudit:
    expected_items = tuple(sorted(set(expected)))
    if not expected_items:
        raise ValueError("expected read_committed positions cannot be empty")
    if len(expected_items) > max_positions:
        raise ValueError("receipt range exceeds max_positions")
    topic = expected_items[0].topic
    partition = expected_items[0].partition

    def offsets(items: Iterable[SourcePosition]) -> tuple[int, ...]:
        normalized = tuple(sorted(set(items)))
        if any(item.topic != topic or item.partition != partition for item in normalized):
            raise ValueError("one receipt audit may cover only one topic partition")
        return tuple(item.offset for item in normalized)

    expected_offsets = offsets(expected_items)
    raw_offsets = offsets(raw)
    resolved_offsets = offsets(resolved)
    expected_set = set(expected_offsets)
    actual_set = set(raw_offsets) | set(resolved_offsets)
    missing = tuple(sorted(expected_set - actual_set))
    unexpected = tuple(sorted(actual_set - expected_set))
    status: ReceiptStatus = "contiguous" if not missing and not unexpected else "blocked"
    advance: int | None = None
    if not unexpected:
        for offset in expected_offsets:
            if offset not in actual_set:
                break
            advance = offset
    return ReceiptAudit(
        topic=topic,
        partition=partition,
        from_offset_inclusive=expected_offsets[0],
        to_offset_inclusive=expected_offsets[-1],
        expected_offsets=expected_offsets,
        raw_offsets=raw_offsets,
        resolved_offsets=resolved_offsets,
        missing_offsets=missing,
        unexpected_offsets=unexpected,
        status=status,
        expected_positions_hash=_offset_hash(expected_offsets),
        raw_or_resolved_positions_hash=_offset_hash(actual_set),
        advance_to_offset=advance,
    )
