"""Pure RAG parent-document contract shared by Spark staging and tests.

This module deliberately has no Spark or application imports.  The parent
stage is the deterministic boundary between Catalog rows and later AI work:
Spark may normalize and persist rows here, but it must not call an LLM.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Iterable


RAG_PARENT_SCHEMA_VERSION = "rag-parent-v1"
EMBEDDING_INPUT_VERSION = "title_body_v1"
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
    values = []
    for column in columns:
        value = row.get(str(column))
        if value is None:
            continue
        text = str(value).strip()
        if text:
            values.append(text)
    return "\n".join(values)


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
    return f"ordinal:{ordinal}"


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
) -> dict[str, Any]:
    normalized = normalized_row(row, included_columns if included_columns is not None else schema_columns)
    body = join_columns(normalized, body_columns)
    title = join_columns(normalized, title_columns) or None
    metadata = {column: normalized.get(column) for column in metadata_columns if column in normalized and normalized.get(column) is not None}
    source_id = source_row_id(normalized, identifier_columns, ordinal)
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
        "metadata": metadata,
        "normalized_row": normalized,
        "source_columns": sorted(set(str(column) for column in [*body_columns, *title_columns, *metadata_columns, *identifier_columns])),
        "content_hash": content_hash,
        "embedding_input_version": EMBEDDING_INPUT_VERSION,
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
