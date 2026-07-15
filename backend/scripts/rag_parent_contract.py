"""Pure RAG parent-document contract shared by Spark staging and tests.

This module deliberately has no Spark or application imports.  The parent
stage is the deterministic boundary between Catalog rows and later AI work:
Spark may normalize and persist rows here, but it must not call an LLM.
"""

from __future__ import annotations

import hashlib
import json
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable


RAG_PARENT_SCHEMA_VERSION = "rag-parent-v3"
EMBEDDING_INPUT_VERSION = "title_body_fields_v2"
FIELD_RENDERING_VERSION = "field_blocks_v1"
CHUNKING_VERSION = "rag-chunk-v3"
DEFAULT_CHUNK_TARGET_TOKENS = 800
DEFAULT_CHUNK_OVERLAP_TOKENS = 400
DEFAULT_CHUNK_MAX_TOKENS = 1200


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def sha256_hex(value: Any) -> str:
    payload = value if isinstance(value, bytes) else canonical_json(value).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def normalize_scalar(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def render_scalar(value: Any, data_type: str | None = None) -> str:
    """Render a Catalog value deterministically for title/body text."""

    if value is None:
        return ""
    kind = str(data_type or "").casefold()
    if "bool" in kind:
        if isinstance(value, bool):
            return "true" if value else "false"
        text = str(value).strip().casefold()
        if text in {"true", "false"}:
            return text
    if any(token in kind for token in ("int", "long", "short")):
        try:
            return str(int(Decimal(str(value).strip())))
        except (InvalidOperation, ValueError):
            pass
    if any(token in kind for token in ("float", "double", "decimal", "numeric", "number")):
        try:
            normalized = format(Decimal(str(value).strip()), "f")
            if "." in normalized:
                normalized = normalized.rstrip("0").rstrip(".")
            return normalized or "0"
        except (InvalidOperation, ValueError):
            pass
    if any(token in kind for token in ("date", "time", "timestamp")) and hasattr(value, "isoformat"):
        return str(value.isoformat()).strip()
    if any(token in kind for token in ("date", "time", "timestamp")) and isinstance(value, str):
        text = value.strip()
        if kind == "date" or ("date" in kind and not any(token in kind for token in ("time", "timestamp", "datetime"))):
            try:
                return date.fromisoformat(text).isoformat()
            except ValueError:
                pass
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00")).isoformat()
        except ValueError:
            try:
                return date.fromisoformat(text).isoformat()
            except ValueError:
                pass
    if isinstance(value, (dict, list, tuple)):
        return canonical_json(flatten_value(value))
    return str(value).strip()


def _field_spec(field: Any, mapping: dict[str, str], schema_types: dict[str, str]) -> tuple[str, str, str]:
    if isinstance(field, dict):
        logical = str(field.get("logicalField") or field.get("logical_field") or field.get("name") or "").strip()
        physical = str(field.get("physicalField") or field.get("physical_field") or mapping.get(logical) or logical).strip()
        data_type = str(field.get("dataType") or field.get("data_type") or schema_types.get(logical) or "").strip()
    else:
        logical = str(field).strip()
        physical = str(mapping.get(logical) or logical).strip()
        data_type = str(schema_types.get(logical) or "").strip()
    return logical, physical, data_type


def build_field_blocks(
    row: dict[str, Any],
    fields: Iterable[Any],
    *,
    logical_to_physical: dict[str, str] | None = None,
    schema_types: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Create ordered, labeled field blocks from the approved role columns."""

    mapping = logical_to_physical or {}
    types = schema_types or {}
    blocks: list[dict[str, Any]] = []
    for field in fields:
        logical, physical, data_type = _field_spec(field, mapping, types)
        if not logical:
            continue
        value = row.get(physical)
        if value is None and logical != physical:
            value = row.get(logical)
        text = render_scalar(value, data_type)
        if not text:
            continue
        blocks.append({"logicalField": logical, "physicalField": physical, "dataType": data_type, "text": text})
    return blocks


def render_field_blocks(blocks: list[dict[str, Any]], section: str) -> tuple[str, list[dict[str, Any]]]:
    """Render labeled blocks and attach canonical source offsets."""

    section_name = str(section).upper()
    parts = [f"[{section_name}]\n"]
    enriched: list[dict[str, Any]] = []
    cursor = len(parts[0])
    for index, block in enumerate(blocks):
        logical = str(block.get("logicalField") or "").strip()
        text = str(block.get("text") or "").strip()
        if not logical or not text:
            continue
        prefix = f"{logical}: "
        if index:
            parts.append("\n\n")
            cursor += 2
        block_start = cursor
        parts.append(prefix)
        cursor += len(prefix)
        value_start = cursor
        parts.append(text)
        cursor += len(text)
        value_end = cursor
        block_end = cursor
        enriched.append({**block, "start": block_start, "end": block_end, "valueStart": value_start, "valueEnd": value_end})
    if not enriched:
        return "", []
    parts.append(f"\n[/{section_name}]")
    return "".join(parts), enriched


def flatten_value(value: Any) -> Any:
    """Keep arrays atomic while making nested objects addressable.

    Arrays are intentionally compact JSON, rather than exploded rows.  Row
    identity must remain one source row per parent document.
    """

    if isinstance(value, dict):
        return {str(key): flatten_value(item) for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))}
    if isinstance(value, (list, tuple)):
        return [flatten_value(item) for item in value]
    return normalize_scalar(value)


def normalized_row(row: dict[str, Any], schema_columns: Iterable[str]) -> dict[str, Any]:
    allowed = {str(column).strip() for column in schema_columns if str(column).strip()}
    return {column: flatten_value(row.get(column)) for column in sorted(allowed) if column in row}


def join_columns(row: dict[str, Any], columns: Iterable[str]) -> str:
    blocks = []
    for column in columns:
        logical = str(column).strip()
        value = row.get(logical)
        text = render_scalar(value)
        if logical and text:
            blocks.append({"logicalField": logical, "physicalField": logical, "text": text})
    rendered, _ = render_field_blocks(blocks, "BODY")
    return rendered


def embedding_text(title: str | None, body: str) -> str:
    title_text = str(title or "").strip()
    body_text = str(body or "").strip()
    return "\n\n".join(item for item in (title_text, body_text) if item)


def source_row_id(row: dict[str, Any], identifier_columns: Iterable[str], ordinal: int) -> str:
    for column in identifier_columns:
        value = row.get(str(column))
        if value not in (None, ""):
            return str(value).strip()
    for fallback in ("id", "review_id", "row_id"):
        value = row.get(fallback)
        if value not in (None, ""):
            return str(value).strip()
    # A Spark row ordinal is not stable across repartitioning, file listing
    # order, or a retry in a new application.  Keep the argument for API
    # compatibility, but derive the fallback from canonical row content.
    # Approval requires a real identifier for production indexing; this
    # fallback is only a deterministic safety net for local/legacy callers.
    return f"rowhash:{sha256_hex(row)[:32]}"


def parent_document_id(dataset_id: str, source_row: str, content_hash: str) -> str:
    return sha256_hex(f"{dataset_id}\x00{source_row}\x00{content_hash}".encode("utf-8"))[:32]


def build_parent_document(
    *,
    dataset_id: str,
    source_fingerprint: str,
    row: dict[str, Any],
    schema_columns: Iterable[str],
    body_columns: Iterable[str],
    title_columns: Iterable[str],
    metadata_columns: Iterable[str],
    identifier_columns: Iterable[str],
    included_columns: Iterable[str] | None = None,
    semantic_bindings: dict[str, Any] | None = None,
    ordinal: int,
    job_id: str,
    policy_fingerprint: str,
    staged_at: str | None = None,
    body_fields: Iterable[Any] | None = None,
    title_fields: Iterable[Any] | None = None,
    metadata_fields: Iterable[Any] | None = None,
    identifier_fields: Iterable[Any] | None = None,
    logical_to_physical: dict[str, str] | None = None,
    schema_types: dict[str, str] | None = None,
) -> dict[str, Any]:
    normalized = normalized_row(row, included_columns if included_columns is not None else schema_columns)
    mapping = logical_to_physical or {}
    types = schema_types or {}
    body_specs = list(body_fields) if body_fields is not None else [{"logicalField": column, "physicalField": mapping.get(str(column), str(column)), "dataType": types.get(str(column), "")} for column in body_columns]
    title_specs = list(title_fields) if title_fields is not None else [{"logicalField": column, "physicalField": mapping.get(str(column), str(column)), "dataType": types.get(str(column), "")} for column in title_columns]
    metadata_specs = list(metadata_fields) if metadata_fields is not None else list(metadata_columns)
    identifier_specs = list(identifier_fields) if identifier_fields is not None else list(identifier_columns)
    body_blocks, title_blocks = build_field_blocks(normalized, body_specs, logical_to_physical=mapping, schema_types=types), build_field_blocks(normalized, title_specs, logical_to_physical=mapping, schema_types=types)
    body, body_blocks = render_field_blocks(body_blocks, "BODY")
    title, title_blocks = render_field_blocks(title_blocks, "TITLE")
    title = title or None
    metadata = {}
    metadata_display = {}
    for field in metadata_specs:
        logical, physical, _ = _field_spec(field, mapping, types)
        value = normalized.get(physical)
        if value is None:
            value = normalized.get(logical)
        if value is not None:
            metadata[physical] = value
            metadata_display[logical] = value
    source_id = source_row_id(normalized, identifier_columns, ordinal)
    def source_field_specs(specs: Iterable[Any], role: str) -> list[dict[str, str]]:
        output: list[dict[str, str]] = []
        for field in specs:
            logical, physical, _ = _field_spec(field, mapping, types)
            if logical:
                output.append({"logicalField": logical, "physicalField": physical, "role": role})
        return output
    source_fields = [
        *source_field_specs(body_specs, "body"),
        *source_field_specs(title_specs, "title"),
        *source_field_specs(metadata_specs, "metadata"),
        *source_field_specs(identifier_specs, "identifier"),
    ]
    content_hash = sha256_hex({"title": title, "body": body, "metadata": metadata, "normalizedRow": normalized})
    parent_id = parent_document_id(dataset_id, source_id, content_hash)
    return {
        "schema_version": RAG_PARENT_SCHEMA_VERSION,
        "dataset_id": dataset_id,
        "source_fingerprint": source_fingerprint,
        "source_row_id": source_id,
        "row_ordinal": ordinal,
        "parent_document_id": parent_id,
        "title": title,
        "body": body,
        "title_blocks": title_blocks,
        "body_blocks": body_blocks,
        "metadata": metadata,
        "metadata_display": metadata_display,
        "normalized_row": normalized,
        "source_columns": [str(field["logicalField"]) for field in source_fields],
        "source_fields": source_fields,
        "content_hash": content_hash,
        "embedding_input_version": EMBEDDING_INPUT_VERSION,
        "field_rendering_version": FIELD_RENDERING_VERSION,
        "policy_fingerprint": policy_fingerprint,
        "job_id": job_id,
        "semantic_bindings": semantic_bindings or {},
        "staged_at": staged_at or datetime.now(timezone.utc).isoformat(),
    }


def validate_parent_document(document: dict[str, Any]) -> None:
    required = ("schema_version", "dataset_id", "source_fingerprint", "source_row_id", "parent_document_id", "body", "content_hash")
    missing = [field for field in required if not str(document.get(field) or "").strip()]
    if missing:
        raise ValueError(f"RAG_PARENT_REQUIRED_FIELDS_MISSING: {','.join(missing)}")
    if document.get("schema_version") != RAG_PARENT_SCHEMA_VERSION:
        raise ValueError("RAG_PARENT_SCHEMA_VERSION_UNSUPPORTED")
    if not isinstance(document.get("metadata"), dict) or not isinstance(document.get("normalized_row"), dict):
        raise ValueError("RAG_PARENT_OBJECT_FIELDS_INVALID")


def build_staging_paths(*, base_path: str, dataset_id: str, job_id: str) -> dict[str, str]:
    root = f"{base_path.rstrip('/')}/rag/parents/dataset_id={dataset_id}"
    return {
        "table": root,
        "checkpoint": f"{base_path.rstrip('/')}/rag/checkpoints/parents/dataset_id={dataset_id}/job_id={job_id}",
        "report": f"{base_path.rstrip('/')}/rag/reports/parents/{job_id}.json",
    }


def failed_row_report(*, row_count: int, failed_count: int, threshold: float, quarantined_table: str) -> dict[str, Any]:
    """Build the persisted row-quality contract used by every staging path."""

    total = max(0, int(row_count))
    failed = min(total, max(0, int(failed_count)))
    return {
        "rowCount": total,
        "validCount": total - failed,
        "failedCount": failed,
        "failedRate": failed / total if total else 0.0,
        "threshold": float(threshold),
        "quarantinedTable": str(quarantined_table),
    }
