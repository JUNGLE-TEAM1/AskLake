import hashlib
import json
from decimal import Decimal, InvalidOperation
from typing import Any

from app.services.catalog_schema import dataset_schema, schema_names


CHUNKING_VERSION = "rag-chunk-v3"
EMBEDDING_INPUT_VERSION = "title_body_fields_v2"
FIELD_RENDERING_VERSION = "field_blocks_v1"
PARENT_SCHEMA_VERSION = "rag-parent-v3"


def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def typed_metadata_filter(metadata: dict[str, Any], expected_types: dict[str, str] | None = None) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    expected_types = expected_types or {}
    for key, value in metadata.items():
        expected = str(expected_types.get(str(key)) or "").casefold()
        if any(token in expected for token in ("boolean", "bool")):
            normalized = value if isinstance(value, bool) else str(value).strip().casefold() == "true"
            if not isinstance(value, bool) and str(value).strip().casefold() not in {"true", "false"}:
                raise ValueError(f"Metadata field {key} is declared boolean but contains a non-boolean value")
            result[str(key)] = {"type": "boolean", "keyword": "true" if normalized else "false", "boolean": normalized}
        elif any(token in expected for token in ("int", "long", "float", "double", "decimal", "numeric", "number")):
            result[str(key)] = {"type": "number", "keyword": str(value), "number": float(value)}
        elif any(token in expected for token in ("date", "datetime", "timestamp", "time")):
            serialized = value.isoformat() if hasattr(value, "isoformat") else str(value).strip()
            result[str(key)] = {"type": "date", "keyword": serialized, "date": serialized}
        elif isinstance(value, bool):
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


def physical_column_name(column: str) -> str:
    import re
    value = re.sub(r"[^0-9A-Za-z_]+", "_", str(column or "").strip().lower())
    return re.sub(r"_+", "_", value).strip("_") or "column"


def render_value(value: Any, data_type: str = "") -> str:
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
    if hasattr(value, "isoformat") and any(token in kind for token in ("date", "time", "timestamp")):
        return str(value.isoformat()).strip()
    if any(token in kind for token in ("date", "time", "timestamp")) and isinstance(value, str):
        text = value.strip()
        try:
            from datetime import date, datetime
            if kind == "date" or ("date" in kind and not any(token in kind for token in ("time", "timestamp", "datetime"))):
                return date.fromisoformat(text).isoformat()
            return datetime.fromisoformat(text.replace("Z", "+00:00")).isoformat()
        except ValueError:
            try:
                return date.fromisoformat(text).isoformat()
            except ValueError:
                pass
    if isinstance(value, (dict, list, tuple)):
        return compact_json(value)
    return str(value).strip()


def render_section(row: dict[str, Any], field_names: list[str], schema_types: dict[str, str], section: str, physical_column_mapping: dict[str, str] | None = None) -> tuple[str, list[dict[str, Any]]]:
    section_name = section.upper()
    parts = [f"[{section_name}]\n"]
    blocks: list[dict[str, Any]] = []
    cursor = len(parts[0])
    emitted = 0
    physical_column_mapping = physical_column_mapping or {}
    for logical in field_names:
        text = render_value(row.get(logical), schema_types.get(logical, ""))
        if not text:
            continue
        if emitted:
            parts.append("\n\n")
            cursor += 2
        prefix = f"{logical}: "
        start = cursor
        parts.append(prefix)
        cursor += len(prefix)
        value_start = cursor
        parts.append(text)
        cursor += len(text)
        blocks.append({"logicalField": logical, "physicalField": physical_column_mapping.get(logical, physical_column_name(logical)), "dataType": schema_types.get(logical, ""), "text": text, "start": start, "end": cursor, "valueStart": value_start, "valueEnd": cursor})
        emitted += 1
    if not blocks:
        return "", []
    parts.append(f"\n[/{section_name}]")
    return "".join(parts), blocks


def build_documents(*, dataset_id: str, dataset_name: str, rows: list[Any], columns: list[str], body_columns: list[str], metadata_columns: list[str], target_index: str, title_columns: list[str] | None = None, identifier_columns: list[str] | None = None, semantic_bindings: dict[str, list[dict[str, Any]]] | None = None, schema_types: dict[str, str] | None = None, physical_column_mapping: dict[str, str] | None = None, limit: int = 20) -> list[dict[str, Any]]:
    documents: list[dict[str, Any]] = []
    title_columns = title_columns or []
    identifier_columns = identifier_columns or []
    semantic_bindings = semantic_bindings or {}
    schema_types = schema_types or {}
    physical_column_mapping = physical_column_mapping or {}
    for index, raw_row in enumerate(rows[:limit]):
        row = row_as_dict(raw_row, columns)
        source_row_id = next((str(row.get(column)) for column in identifier_columns if row.get(column) not in (None, "")), None)
        source_row_id = source_row_id or str(row.get("id") or row.get("review_id") or row.get("row_id") or "")
        body, body_blocks = render_section(row, body_columns, schema_types, "BODY", physical_column_mapping)
        metadata = {physical_column_mapping.get(column, physical_column_name(column)): row.get(column) for column in metadata_columns if row.get(column) is not None}
        metadata_display = {column: row.get(column) for column in metadata_columns if row.get(column) is not None}
        title, title_blocks = render_section(row, title_columns, schema_types, "TITLE", physical_column_mapping)
        title = title or None
        normalized_columns = list(dict.fromkeys([*body_columns, *title_columns, *metadata_columns, *identifier_columns]))
        normalized_row = {}
        for column in sorted(normalized_columns, key=lambda item: physical_column_mapping.get(item, physical_column_name(item))):
            physical = physical_column_mapping.get(column, physical_column_name(column))
            value = row.get(column) if column in row else row.get(physical)
            if column in row or physical in row:
                normalized_row[physical] = value
        content_hash = hashlib.sha256(compact_json({"title": title, "body": body, "metadata": metadata, "normalizedRow": normalized_row}).encode("utf-8")).hexdigest()
        parent_document_id = hashlib.sha256(f"{dataset_id}\x00{source_row_id}\x00{content_hash}".encode("utf-8")).hexdigest()[:32]
        embedding_text = "\n\n".join(value for value in (title, body) if value)
        chunk_hash = hashlib.sha256(embedding_text.encode("utf-8")).hexdigest()
        document_id = hashlib.sha256(f"{parent_document_id}:0:{chunk_hash}".encode("utf-8")).hexdigest()[:32]
        source_fields = [{"logicalField": column, "physicalField": physical_column_mapping.get(column, physical_column_name(column)), "role": role} for role, names in (("body", body_columns), ("title", title_columns), ("metadata", metadata_columns), ("identifier", identifier_columns)) for column in names]
        documents.append({
            "documentId": document_id, "parentDocumentId": parent_document_id, "chunkIndex": 0, "startSentence": 0, "endSentence": 0, "datasetId": dataset_id, "sourceRowId": source_row_id,
            "body": body, "title": title,
            "filterTerms": {key: str(value) for key, value in metadata.items() if isinstance(value, (str, int, float, bool))},
            "metadataFilter": typed_metadata_filter(metadata, {physical_column_mapping.get(column, physical_column_name(column)): schema_types.get(column, "") for column in metadata_columns}),
            "metadataDisplay": metadata_display, "sourceDataset": dataset_name, "sourceColumns": [*body_columns, *title_columns, *metadata_columns, *identifier_columns],
            "semanticBindings": semantic_bindings,
            "sourceFields": source_fields,
            "targetIndex": target_index, "embeddingStatus": "pending", "contentHash": content_hash, "embeddingText": embedding_text, "chunkingStrategy": "pending", "chunkingVersion": CHUNKING_VERSION,
            "embeddingInputVersion": EMBEDDING_INPUT_VERSION, "fieldRenderingVersion": FIELD_RENDERING_VERSION, "parentSchemaVersion": PARENT_SCHEMA_VERSION,
        })
    return documents
