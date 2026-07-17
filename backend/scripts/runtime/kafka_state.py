"""Spark-free cursor normalization for Kafka Continuous recovery."""

from __future__ import annotations

from typing import Any


def normalize_stream_partition_cursors(value: Any) -> dict[tuple[str, int], int]:
    cursors: dict[tuple[str, int], int] = {}
    if not isinstance(value, list):
        return cursors
    for item in value:
        if not isinstance(item, dict):
            continue
        topic = str(item.get("topic") or "").strip()
        try:
            partition = int(item.get("partition"))
            next_offset = int(item.get("nextOffset"))
        except (TypeError, ValueError):
            continue
        if not topic or partition < 0 or next_offset < 0:
            continue
        key = (topic, partition)
        cursors[key] = max(cursors.get(key, 0), next_offset)
    return cursors


def stream_partition_cursor_payload(
    cursors: dict[tuple[str, int], int],
) -> list[dict[str, Any]]:
    return [
        {"topic": topic, "partition": partition, "nextOffset": next_offset}
        for (topic, partition), next_offset in sorted(cursors.items())
    ]
