import hashlib
import json
from typing import Any

from .rag_core import EMBEDDING_INPUT_VERSION, FIELD_RENDERING_VERSION, build_embedding_text, render_field_section
from .metadata import typed_metadata_filter


def _contract_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(key): _contract_value(item)
            for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
        }
    if isinstance(value, (list, tuple)):
        return [_contract_value(item) for item in value]
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )


def composite_source_row_id(row: dict[str, Any], identifier_columns: list[str]) -> str:
    """Mirror the Spark ordered-composite identifier contract exactly."""

    identifiers = [str(column).strip() for column in identifier_columns if str(column).strip()]
    if not identifiers:
        raise ValueError("RAG_SOURCE_IDENTIFIER_COLUMNS_REQUIRED")
    values: list[dict[str, Any]] = []
    missing: list[str] = []
    for column in identifiers:
        value = row.get(column)
        if value in (None, "") or (isinstance(value, str) and not value.strip()):
            missing.append(column)
        else:
            values.append({"column": column, "value": _contract_value(value)})
    if missing:
        raise ValueError(f"RAG_SOURCE_IDENTIFIER_MISSING: {','.join(missing)}")
    digest = hashlib.sha256(_canonical_json(values).encode("utf-8")).hexdigest()
    return f"identifier:{digest[:32]}"


def _source_row_id(row: dict[str, Any], identifier_columns: list[str]) -> str:
    if identifier_columns:
        return composite_source_row_id(row, identifier_columns)
    for fallback in ("id", "review_id", "row_id"):
        value = row.get(fallback)
        if value not in (None, ""):
            return str(value).strip()
    digest = hashlib.sha256(_canonical_json(_contract_value(row)).encode("utf-8")).hexdigest()
    return f"rowhash:{digest[:32]}"


def _merge_source_fields(role_columns: tuple[tuple[str, list[str]], ...]) -> list[dict[str, Any]]:
    merged: dict[tuple[str, str], dict[str, Any]] = {}
    for role, columns in role_columns:
        for raw_column in columns:
            column = str(raw_column).strip()
            if not column:
                continue
            key = (column, column)
            current = merged.get(key)
            if current is None:
                current = {
                    "logicalField": column,
                    "physicalField": column,
                    "role": role,
                    "roles": [role],
                }
                merged[key] = current
            elif role not in current["roles"]:
                current["roles"].append(role)
    return list(merged.values())


def build_documents(
    dataset_id: str,
    dataset_name: str,
    rows: list[dict[str, Any]],
    body_columns: list[str],
    metadata_columns: list[str],
    target_index: str,
    title_columns: list[str] | None = None,
    identifier_columns: list[str] | None = None,
    semantic_bindings: dict[str, list[dict[str, Any]]] | None = None,
    metadata_types: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    title_columns = title_columns or []
    identifier_columns = identifier_columns or []
    semantic_bindings = semantic_bindings or {}
    documents: list[dict[str, Any]] = []
    for ordinal, row in enumerate(rows):
        source_row_id = _source_row_id(row, identifier_columns)
        body_blocks = [{"logicalField": column, "physicalField": column, "text": str(row[column]).strip()} for column in body_columns if row.get(column) not in (None, "")]
        title_blocks = [{"logicalField": column, "physicalField": column, "text": str(row[column]).strip()} for column in title_columns if row.get(column) not in (None, "")]
        body, body_blocks = render_field_section(body_blocks, "BODY")
        title, title_blocks = render_field_section(title_blocks, "TITLE")
        title = title or None
        metadata = {column: row[column] for column in metadata_columns if row.get(column) is not None}
        embedding_text = build_embedding_text(title, body)
        content_hash = hashlib.sha256(embedding_text.encode("utf-8")).hexdigest()
        document_id = hashlib.sha256(f"{dataset_id}:{source_row_id}:{content_hash}".encode("utf-8")).hexdigest()[:32]
        source_fields = _merge_source_fields(
            (
                ("body", body_columns),
                ("title", title_columns),
                ("metadata", metadata_columns),
                ("identifier", identifier_columns),
            )
        )
        documents.append({"document_id": document_id, "dataset_id": dataset_id, "source_row_id": source_row_id, "body": body, "title": title, "embedding_text": embedding_text, "filter_terms": {key: str(value) for key, value in metadata.items()}, "metadata_filter": typed_metadata_filter(metadata, metadata_types), "metadata_display": metadata, "source_dataset": dataset_name, "semantic_bindings": semantic_bindings, "source_columns": list(dict.fromkeys(field["logicalField"] for field in source_fields)), "source_fields": source_fields, "title_blocks": title_blocks, "body_blocks": body_blocks, "embedding_input_version": EMBEDDING_INPUT_VERSION, "field_rendering_version": FIELD_RENDERING_VERSION, "target_index": target_index, "content_hash": content_hash})
    return documents
