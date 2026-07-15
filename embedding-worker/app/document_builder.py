import hashlib
import json
from typing import Any

from .rag_core import EMBEDDING_INPUT_VERSION, FIELD_RENDERING_VERSION, build_embedding_text, render_field_section
from .metadata import typed_metadata_filter


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
        source_row_id = next((str(row[column]) for column in identifier_columns if row.get(column) not in (None, "")), None)
        source_row_id = source_row_id or str(row.get("id") or row.get("review_id") or row.get("row_id") or f"rowhash:{hashlib.sha256(json.dumps(row, sort_keys=True, ensure_ascii=False, default=str).encode('utf-8')).hexdigest()[:32]}")
        body_blocks = [{"logicalField": column, "physicalField": column, "text": str(row[column]).strip()} for column in body_columns if row.get(column) not in (None, "")]
        title_blocks = [{"logicalField": column, "physicalField": column, "text": str(row[column]).strip()} for column in title_columns if row.get(column) not in (None, "")]
        body, body_blocks = render_field_section(body_blocks, "BODY")
        title, title_blocks = render_field_section(title_blocks, "TITLE")
        title = title or None
        metadata = {column: row[column] for column in metadata_columns if row.get(column) is not None}
        embedding_text = build_embedding_text(title, body)
        content_hash = hashlib.sha256(embedding_text.encode("utf-8")).hexdigest()
        document_id = hashlib.sha256(f"{dataset_id}:{source_row_id}:{content_hash}".encode("utf-8")).hexdigest()[:32]
        documents.append({"document_id": document_id, "dataset_id": dataset_id, "source_row_id": source_row_id, "body": body, "title": title, "embedding_text": embedding_text, "filter_terms": {key: str(value) for key, value in metadata.items()}, "metadata_filter": typed_metadata_filter(metadata, metadata_types), "metadata_display": metadata, "source_dataset": dataset_name, "semantic_bindings": semantic_bindings, "source_columns": [*body_columns, *title_columns, *metadata_columns, *identifier_columns], "source_fields": [{"logicalField": column, "physicalField": column, "role": role} for role, fields in (("body", body_columns), ("title", title_columns), ("metadata", metadata_columns), ("identifier", identifier_columns)) for column in fields], "title_blocks": title_blocks, "body_blocks": body_blocks, "embedding_input_version": EMBEDDING_INPUT_VERSION, "field_rendering_version": FIELD_RENDERING_VERSION, "target_index": target_index, "content_hash": content_hash})
    return documents
