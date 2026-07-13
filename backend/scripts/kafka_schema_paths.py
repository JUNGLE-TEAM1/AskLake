"""Pure helpers for Kafka JSON source-path contracts."""

import re
from typing import Any, Iterable


def split_source_path(value: str) -> tuple[str, ...]:
    source_path = str(value or "").strip()
    segments = tuple(source_path.split(".")) if source_path else ()
    if not segments or any(not segment for segment in segments):
        raise ValueError(f"Invalid Kafka source path: {value!r}")
    return segments


def build_nested_schema_tree(bindings: Iterable[tuple[str, Any]]) -> dict[str, Any]:
    root: dict[str, Any] = {}
    for source_path, field_type in bindings:
        segments = split_source_path(source_path)
        node = root
        for index, segment in enumerate(segments):
            leaf = index == len(segments) - 1
            existing = node.get(segment)
            if leaf:
                if isinstance(existing, dict):
                    raise ValueError(f"Kafka source path is both an object and a scalar: {source_path}")
                if existing is not None and existing != field_type:
                    raise ValueError(f"Kafka source path has conflicting types: {source_path}")
                node[segment] = field_type
                continue
            if existing is not None and not isinstance(existing, dict):
                raise ValueError(f"Kafka source path is both a scalar and an object: {source_path}")
            node = node.setdefault(segment, {})
    return root


def expected_object_keys(source_paths: Iterable[str]) -> dict[str, list[str]]:
    expected: dict[str, list[str]] = {}
    for source_path in source_paths:
        parent = ""
        for segment in split_source_path(source_path):
            children = expected.setdefault(parent, [])
            if segment not in children:
                children.append(segment)
            parent = f"{parent}.{segment}" if parent else segment
    return expected


def json_path(source_path: str) -> str:
    path = "$"
    for segment in split_source_path(source_path):
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", segment):
            path += f".{segment}"
        else:
            escaped = segment.replace("\\", "\\\\").replace("'", "\\'")
            path += f"['{escaped}']"
    return path
