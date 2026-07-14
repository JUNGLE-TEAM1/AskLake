import hashlib
import json
from typing import Any

from .rag_core import build_embedding_text
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
) -> list[dict[str, Any]]:
    title_columns = title_columns or []
    identifier_columns = identifier_columns or []
    semantic_bindings = semantic_bindings or {}
    documents: list[dict[str, Any]] = []
    for ordinal, row in enumerate(rows):
        source_row_id = next((str(row[column]) for column in identifier_columns if row.get(column) not in (None, "")), None)
        source_row_id = source_row_id or str(row.get("id") or row.get("review_id") or row.get("row_id") or ordinal)
        body = "\n".join(str(row[column]).strip() for column in body_columns if row.get(column) not in (None, ""))
        title = "\n".join(str(row[column]).strip() for column in title_columns if row.get(column) not in (None, "")) or None
        metadata = {column: row[column] for column in metadata_columns if row.get(column) is not None}
        content_hash = hashlib.sha256(json.dumps({"body": body, "metadata": metadata}, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")).hexdigest()
        document_id = hashlib.sha256(f"{dataset_id}:{source_row_id}:{content_hash}".encode("utf-8")).hexdigest()[:32]
        documents.append({"document_id": document_id, "dataset_id": dataset_id, "source_row_id": source_row_id, "body": body, "title": title, "embedding_text": build_embedding_text(title, body), "filter_terms": {key: str(value) for key, value in metadata.items()}, "metadata_filter": typed_metadata_filter(metadata), "metadata_display": metadata, "source_dataset": dataset_name, "semantic_bindings": semantic_bindings, "target_index": target_index, "content_hash": content_hash})
    return documents
