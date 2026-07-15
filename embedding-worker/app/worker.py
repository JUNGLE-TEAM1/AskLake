import os
from typing import Any

import httpx

from .document_builder import build_documents
from .metadata import typed_metadata_filter
from .rag_core import CHUNKING_VERSION, EMBEDDING_INPUT_VERSION, FIELD_RENDERING_VERSION, build_embedding_text
from .source_reader import read_manifest_rows


class EmbeddingWorker:
    def __init__(self, *, gateway_url: str, gateway_token: str, opensearch_url: str, opensearch_auth: tuple[str, str] | None = None, embedding_model: str = "text-embedding-3-small", timeout: float = 60.0, verify_tls: bool | str = True) -> None:
        self.gateway_url = gateway_url.rstrip("/")
        self.gateway_token = gateway_token
        self.opensearch_url = opensearch_url.rstrip("/")
        self.opensearch_auth = opensearch_auth
        self.embedding_model = embedding_model
        self.timeout = timeout
        self.verify_tls = verify_tls

    def process(self, *, dataset_id: str, dataset_name: str, rows: list[dict[str, Any]] | None, body_columns: list[str], metadata_columns: list[str], target_index: str, source_manifest: dict[str, Any] | None = None, title_columns: list[str] | None = None, identifier_columns: list[str] | None = None, semantic_bindings: dict[str, list[dict[str, Any]]] | None = None, chunks: list[dict[str, Any]] | None = None, embedding_model: str | None = None, embedding_dimensions: int | None = None, metadata_types: dict[str, str] | None = None) -> dict[str, Any]:
        if chunks:
            return self.index_chunks(dataset_id=dataset_id, dataset_name=dataset_name, chunks=chunks, target_index=target_index, embedding_model=embedding_model, embedding_dimensions=embedding_dimensions, metadata_types=metadata_types)
        if os.environ.get("RAG_LEGACY_DIRECT_INDEX_ENABLED", "false").casefold() not in {"1", "true", "yes"}:
            raise ValueError("RAG v2 indexing requires chunk staging; legacy direct row indexing is disabled")
        if not rows:
            if source_manifest is None:
                raise ValueError("Either rows or a Catalog source manifest is required")
            rows = read_manifest_rows(source_manifest, dataset_id=dataset_id)
        documents = build_documents(dataset_id, dataset_name, rows, body_columns, metadata_columns, target_index, title_columns=title_columns, identifier_columns=identifier_columns, semantic_bindings=semantic_bindings, metadata_types=metadata_types)
        return self.index_documents(documents, embedding_model=embedding_model, embedding_dimensions=embedding_dimensions, metadata_types=metadata_types)

    def index_chunks(self, *, dataset_id: str, dataset_name: str, chunks: list[dict[str, Any]], target_index: str, embedding_model: str | None = None, embedding_dimensions: int | None = None, metadata_types: dict[str, str] | None = None) -> dict[str, Any]:
        documents = []
        for chunk in chunks:
            embedding_text = str(chunk.get("embedding_text") or build_embedding_text(chunk.get("title"), str(chunk.get("text") or chunk.get("body") or "")))
            metadata = chunk.get("metadata") if isinstance(chunk.get("metadata"), dict) else {}
            documents.append({
                "document_id": str(chunk.get("chunk_document_id") or chunk.get("document_id") or ""),
                "job_id": str(chunk.get("job_id") or ""),
                "chunk_document_id": str(chunk.get("chunk_document_id") or chunk.get("document_id") or ""),
                "parent_document_id": str(chunk.get("parent_document_id") or ""),
                "dataset_id": dataset_id,
                "source_row_id": str(chunk.get("source_row_id") or ""),
                "title": chunk.get("title"),
                "body": str(chunk.get("text") or chunk.get("body") or ""),
                "embedding_text": embedding_text,
                "filter_terms": {key: str(value) for key, value in metadata.items()},
                "metadata_filter": typed_metadata_filter(metadata, metadata_types),
                "metadata_display": chunk.get("metadata_display") if isinstance(chunk.get("metadata_display"), dict) else metadata,
                "source_dataset": dataset_name,
                "source_columns": list(chunk.get("source_columns") or []),
                "source_fields": list(chunk.get("source_fields") or []),
                "parent_source_fields": list(chunk.get("parent_source_fields") or []),
                "title_blocks": list(chunk.get("title_blocks") or []),
                "body_blocks": list(chunk.get("body_blocks") or []),
                "semantic_bindings": chunk.get("semantic_bindings") or {},
                "target_index": target_index,
                "content_hash": str(chunk.get("content_hash") or ""),
                "chunk_index": int(chunk.get("chunk_index") or 0),
                "chunk_count": int(chunk.get("chunk_count") or 0),
                "start_sentence": int(chunk.get("start_sentence") or 0),
                "end_sentence": int(chunk.get("end_sentence") or 0),
                "char_start": int(chunk.get("char_start") or 0),
                "char_end": int(chunk.get("char_end") or 0),
                "chunking_strategy": str(chunk.get("chunking_strategy") or "unknown"),
                "chunking_version": str(chunk.get("chunking_version") or ""),
                "embedding_input_version": str(chunk.get("embedding_input_version") or EMBEDDING_INPUT_VERSION),
                "field_rendering_version": str(chunk.get("field_rendering_version") or FIELD_RENDERING_VERSION),
                "embedding_model": embedding_model or self.embedding_model,
                "embedding_dimensions": embedding_dimensions,
                "fallback_applied": bool(chunk.get("fallback_applied")),
                "fallback_reason": chunk.get("fallback_reason"),
            })
        existing_ids = self.existing_document_ids(target_index, [item["document_id"] for item in documents])
        documents = [item for item in documents if item["document_id"] not in existing_ids]
        if not documents:
            return {"indexedCount": 0, "skippedExistingCount": len(existing_ids), "targetIndex": target_index, "dimensions": embedding_dimensions, "embeddingModel": embedding_model or self.embedding_model}
        result = self.index_documents(documents, embedding_model=embedding_model, embedding_dimensions=embedding_dimensions, metadata_types=metadata_types)
        result["skippedExistingCount"] = len(existing_ids)
        return result

    def existing_document_ids(self, target_index: str, document_ids: list[str]) -> set[str]:
        """Return already persisted IDs so Spark task retries do not re-embed them."""
        values = [str(value) for value in document_ids if str(value).strip()]
        if not values:
            return set()
        try:
            with httpx.Client(timeout=self.timeout, verify=self.verify_tls) as client:
                response = client.post(f"{self.opensearch_url}/{target_index}/_search", auth=self.opensearch_auth, json={"size": len(values), "_source": False, "query": {"ids": {"values": values}}})
                if response.status_code == 404:
                    return set()
                response.raise_for_status()
                hits = response.json().get("hits", {}).get("hits", [])
                return {str(item.get("_id")) for item in hits if isinstance(item, dict) and item.get("_id")}
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                return set()
            raise

    def index_documents(self, documents: list[dict[str, Any]], *, embedding_model: str | None = None, embedding_dimensions: int | None = None, metadata_types: dict[str, str] | None = None) -> dict[str, Any]:
        if not documents:
            return {"indexedCount": 0, "targetIndex": None}
        model = embedding_model or self.embedding_model
        with httpx.Client(timeout=self.timeout, verify=self.verify_tls) as client:
            dimensions = 0
            import json
            for offset in range(0, len(documents), 64):
                batch = documents[offset:offset + 64]
                embedding_response = client.post(f"{self.gateway_url}/v1/embeddings", headers={"Authorization": f"Bearer {self.gateway_token}"}, json={"model": model, "input": [item["embedding_text"] for item in batch]})
                embedding_response.raise_for_status()
                embeddings = embedding_response.json().get("data") or []
                if len(embeddings) != len(batch):
                    raise RuntimeError("Embedding response count does not match document batch")
                batch_dimensions = len(embeddings[0]) if embeddings and embeddings[0] else 0
                if embedding_dimensions and batch_dimensions != embedding_dimensions:
                    raise RuntimeError("Embedding dimensions do not match the job manifest")
                if dimensions and batch_dimensions != dimensions:
                    raise RuntimeError("Embedding dimensions changed within one indexing job")
                dimensions = batch_dimensions
                self.assert_target_index_compatibility(client, batch[0].get("target_index"), model, dimensions)
                if offset == 0:
                    block_mapping = {"type": "object", "dynamic": False, "properties": {"logicalField": {"type": "keyword"}, "physicalField": {"type": "keyword"}, "text": {"type": "text"}, "fieldText": {"type": "text"}, "start": {"type": "integer"}, "end": {"type": "integer"}, "valueStart": {"type": "integer"}, "valueEnd": {"type": "integer"}, "fieldValueStart": {"type": "integer"}, "fragmentStart": {"type": "integer"}, "fragmentEnd": {"type": "integer"}}}
                    source_field_mapping = {"type": "object", "dynamic": False, "properties": {"logicalField": {"type": "keyword"}, "physicalField": {"type": "keyword"}, "role": {"type": "keyword"}}}
                    mapping = {"settings": {"index": {"knn": True}}, "mappings": {"properties": {"document_id": {"type": "keyword"}, "job_id": {"type": "keyword"}, "chunk_document_id": {"type": "keyword"}, "parent_document_id": {"type": "keyword"}, "dataset_id": {"type": "keyword"}, "source_row_id": {"type": "keyword"}, "title": {"type": "text"}, "body": {"type": "text"}, "embedding_text": {"type": "text"}, "body_vector": {"type": "knn_vector", "dimension": dimensions}, "filter_terms": {"type": "object", "enabled": True}, "metadata_filter": self._metadata_mapping(metadata_types), "metadata_display": {"type": "object", "enabled": False}, "semantic_bindings": {"type": "object", "enabled": True}, "source_columns": {"type": "keyword"}, "source_fields": source_field_mapping, "parent_source_fields": source_field_mapping, "title_blocks": block_mapping, "body_blocks": block_mapping, "chunk_index": {"type": "integer"}, "chunk_count": {"type": "integer"}, "start_sentence": {"type": "integer"}, "end_sentence": {"type": "integer"}, "char_start": {"type": "integer"}, "char_end": {"type": "integer"}, "chunking_strategy": {"type": "keyword"}, "chunking_version": {"type": "keyword"}, "embedding_input_version": {"type": "keyword"}, "field_rendering_version": {"type": "keyword"}, "content_hash": {"type": "keyword"}, "embedding_model": {"type": "keyword"}, "embedding_dimensions": {"type": "integer"}, "fallback_applied": {"type": "boolean"}, "fallback_reason": {"type": "keyword"}}}}
                    create_response = client.put(f"{self.opensearch_url}/{batch[0].get('target_index')}", auth=self.opensearch_auth, json=mapping)
                    if create_response.status_code >= 400 and "resource_already_exists_exception" not in create_response.text:
                        create_response.raise_for_status()
                lines: list[str] = []
                for document, vector in zip(batch, embeddings):
                    document["body_vector"] = vector
                    lines.extend([json.dumps({"index": {"_index": document["target_index"], "_id": document["document_id"]}}), json.dumps(document, ensure_ascii=False)])
                index_response = client.post(f"{self.opensearch_url}/_bulk?refresh=wait_for", auth=self.opensearch_auth, headers={"Content-Type": "application/x-ndjson"}, content=("\n".join(lines) + "\n").encode("utf-8"))
                index_response.raise_for_status()
                payload = index_response.json()
                if payload.get("errors"):
                    failed = []
                    for item in payload.get("items") or []:
                        operation = next(iter(item.values()), {}) if isinstance(item, dict) else {}
                        if isinstance(operation, dict) and int(operation.get("status") or 0) >= 300:
                            failed.append({"id": operation.get("_id"), "status": operation.get("status"), "error": operation.get("error")})
                    raise RuntimeError(f"OpenSearch bulk indexing returned {len(failed)} item errors: {failed[:5]}")
        return {"indexedCount": len(documents), "targetIndex": documents[0].get("target_index"), "dimensions": dimensions, "embeddingModel": model, "chunkingVersion": next((item.get("chunking_version") for item in documents if item.get("chunking_version")), None)}

    def assert_target_index_compatibility(self, client: httpx.Client, target_index: Any, model: str, dimensions: int) -> None:
        """Reject accidental writes that would mix RAG model contracts."""

        index = str(target_index or "").strip()
        if not index:
            raise ValueError("RAG target index is required")
        mapping_response = client.get(f"{self.opensearch_url}/{index}/_mapping", auth=self.opensearch_auth)
        if mapping_response.status_code == 404:
            return
        mapping_response.raise_for_status()
        mapping_payload = mapping_response.json()
        root = mapping_payload.get(index) if isinstance(mapping_payload, dict) else None
        if not isinstance(root, dict) and isinstance(mapping_payload, dict):
            root = next((value for value in mapping_payload.values() if isinstance(value, dict)), {})
        properties = ((root or {}).get("mappings") or {}).get("properties") if isinstance(root, dict) else {}
        vector_mapping = properties.get("body_vector") if isinstance(properties, dict) else None
        existing_dimensions = int((vector_mapping or {}).get("dimension") or 0) if isinstance(vector_mapping, dict) else 0
        if existing_dimensions and existing_dimensions != int(dimensions):
            raise RuntimeError("Target index vector dimensions do not match the requested embedding contract")
        sample_response = client.post(f"{self.opensearch_url}/{index}/_search", auth=self.opensearch_auth, json={"size": 1, "_source": ["embedding_model", "embedding_dimensions"], "query": {"match_all": {}}})
        if sample_response.status_code == 404:
            return
        sample_response.raise_for_status()
        hits = sample_response.json().get("hits", {}).get("hits", [])
        if not hits:
            return
        source = hits[0].get("_source") if isinstance(hits[0], dict) else {}
        existing_model = str((source or {}).get("embedding_model") or "").strip()
        if existing_model and existing_model != model:
            raise RuntimeError("Target index embedding model does not match the requested embedding contract")
        existing_document_dimensions = int((source or {}).get("embedding_dimensions") or 0)
        if existing_document_dimensions and existing_document_dimensions != int(dimensions):
            raise RuntimeError("Target index document dimensions do not match the requested embedding contract")

    @staticmethod
    def _metadata_mapping(metadata_types: dict[str, str] | None) -> dict[str, Any]:
        if not metadata_types:
            return {"type": "object", "dynamic": True}
        properties: dict[str, Any] = {}
        for field, data_type in metadata_types.items():
            kind = str(data_type or "string").casefold()
            value_properties: dict[str, Any] = {"type": {"type": "keyword"}, "keyword": {"type": "keyword"}}
            if any(token in kind for token in ("int", "long", "float", "double", "decimal", "numeric", "number")):
                value_properties["number"] = {"type": "double"}
            elif any(token in kind for token in ("date", "time", "timestamp")):
                value_properties["date"] = {"type": "date"}
            elif "bool" in kind:
                value_properties["boolean"] = {"type": "boolean"}
            properties[str(field)] = {"type": "object", "dynamic": False, "properties": value_properties}
        return {"type": "object", "dynamic": False, "properties": properties}
