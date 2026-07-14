import hashlib
import json
from typing import Any

from app.services.catalog_schema import dataset_schema, schema_names


CHUNKING_VERSION = "rag-chunk-v2"


def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def typed_metadata_filter(metadata: dict[str, Any]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for key, value in metadata.items():
        if isinstance(value, bool):
            result[str(key)] = {"type": "boolean", "keyword": "true" if value else "false", "boolean": value}
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            result[str(key)] = {"type": "number", "keyword": str(value), "number": float(value)}
        else:
            result[str(key)] = {"type": "string", "keyword": str(value)}
    return result

def dataset_columns(dataset: dict[str, Any]) -> list[str]:
    return schema_names(dataset)


def row_as_dict(row: Any, columns: list[str]) -> dict[str, Any]:
    if isinstance(row, dict):
        return {str(key): value for key, value in row.items()}
    if isinstance(row, list):
        return {column: row[index] if index < len(row) else None for index, column in enumerate(columns)}
    return {}


def build_documents(*, dataset_id: str, dataset_name: str, rows: list[Any], columns: list[str], body_columns: list[str], metadata_columns: list[str], target_index: str, title_columns: list[str] | None = None, identifier_columns: list[str] | None = None, semantic_bindings: dict[str, list[dict[str, Any]]] | None = None, limit: int = 20) -> list[dict[str, Any]]:
    documents: list[dict[str, Any]] = []
    title_columns = title_columns or []
    identifier_columns = identifier_columns or []
    semantic_bindings = semantic_bindings or {}
    for index, raw_row in enumerate(rows[:limit]):
        row = row_as_dict(raw_row, columns)
        source_row_id = next((str(row.get(column)) for column in identifier_columns if row.get(column) not in (None, "")), None)
        source_row_id = source_row_id or str(row.get("id") or row.get("review_id") or row.get("row_id") or index)
        body_parts = [str(row.get(column)).strip() for column in body_columns if row.get(column) not in (None, "")]
        body = "\n".join(part for part in body_parts if part)
        metadata = {column: row.get(column) for column in metadata_columns if row.get(column) is not None}
        title = "\n".join(str(row.get(column)).strip() for column in title_columns if row.get(column) not in (None, "")) or None
        normalized_row = {column: row.get(column) for column in sorted(columns) if column in row}
        content_hash = hashlib.sha256(compact_json({"title": title, "body": body, "metadata": metadata, "normalizedRow": normalized_row}).encode("utf-8")).hexdigest()
        parent_document_id = hashlib.sha256(f"{dataset_id}\x00{source_row_id}\x00{content_hash}".encode("utf-8")).hexdigest()[:32]
        embedding_text = "\n\n".join(value for value in (title, body) if value)
        chunk_hash = hashlib.sha256(compact_json({"embeddingText": embedding_text, "metadata": metadata, "version": CHUNKING_VERSION}).encode("utf-8")).hexdigest()
        document_id = hashlib.sha256(f"{parent_document_id}:0:{chunk_hash}".encode("utf-8")).hexdigest()[:32]
        documents.append({
            "documentId": document_id, "parentDocumentId": parent_document_id, "chunkIndex": 0, "startSentence": 0, "endSentence": 0, "datasetId": dataset_id, "sourceRowId": source_row_id,
            "body": body, "title": title or str(row.get("title") or row.get("name") or "") or None,
            "filterTerms": {key: str(value) for key, value in metadata.items() if isinstance(value, (str, int, float, bool))},
            "metadataFilter": typed_metadata_filter(metadata),
            "metadataDisplay": metadata, "sourceDataset": dataset_name, "sourceColumns": [*body_columns, *title_columns, *metadata_columns, *identifier_columns],
            "semanticBindings": semantic_bindings,
            "targetIndex": target_index, "embeddingStatus": "pending", "contentHash": content_hash, "embeddingText": embedding_text, "chunkingStrategy": "pending", "chunkingVersion": CHUNKING_VERSION,
        })
    return documents
