import json
import math
import os
from typing import Any

import httpx

from .document_builder import build_documents
from .metadata import typed_metadata_filter
from .rag_core import CHUNKING_VERSION, EMBEDDING_INPUT_VERSION, FIELD_RENDERING_VERSION, build_embedding_text
from .source_reader import read_manifest_rows
from .errors import PermanentRagContractError


DEFAULT_GATEWAY_MAX_RESPONSE_BYTES = 8 * 1024 * 1024


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"Invalid JSON constant {value}")


def parse_bounded_gateway_json(response: httpx.Response, *, max_bytes: int) -> dict[str, Any]:
    declared_length = response.headers.get("content-length")
    if declared_length:
        try:
            if int(declared_length) > max_bytes:
                raise ValueError("AI Gateway response exceeded the configured size limit")
        except ValueError as exc:
            if "exceeded" in str(exc):
                raise
    raw = response.content
    if len(raw) > max_bytes:
        raise ValueError("AI Gateway response exceeded the configured size limit")
    try:
        payload = json.loads(raw, parse_constant=_reject_json_constant)
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
        raise ValueError("AI Gateway returned invalid JSON") from exc
    if not isinstance(payload, dict):
        raise ValueError("AI Gateway response must be an object")
    return payload


def validate_generation_response(payload: Any, *, request_id: str, mode: str) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("AI Gateway generation response must be an object")
    if payload.get("request_id") != request_id or payload.get("mode") != mode:
        raise ValueError("AI Gateway generation response identity does not match the request")
    if not isinstance(payload.get("provider"), str) or not payload["provider"].strip():
        raise ValueError("AI Gateway generation provider is missing")
    if not isinstance(payload.get("model"), str) or not payload["model"].strip():
        raise ValueError("AI Gateway generation model is missing")
    if not isinstance(payload.get("output"), dict):
        raise ValueError("AI Gateway generation output is missing")
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        raise ValueError("AI Gateway generation usage is missing")
    for key in ("inputTokens", "outputTokens", "totalTokens"):
        value = usage.get(key)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError("AI Gateway generation usage is invalid")
    cost = usage.get("estimatedCostUsd")
    if isinstance(cost, bool) or not isinstance(cost, (int, float)) or not math.isfinite(float(cost)) or cost < 0:
        raise ValueError("AI Gateway generation cost is invalid")
    return payload


def parse_embedding_response(
    payload: Any,
    *,
    expected_count: int,
    expected_model: str,
    expected_dimensions: int | None = None,
) -> tuple[list[list[float]], int, str]:
    """Validate the private Gateway embedding contract before indexing."""

    if not isinstance(payload, dict):
        raise ValueError("Embedding response must be an object")
    provider = payload.get("provider")
    if not isinstance(provider, str) or not provider.strip():
        raise ValueError("Embedding response provider is missing")
    if payload.get("model") != expected_model:
        raise ValueError("Embedding response model does not match the request")
    dimensions = payload.get("dimensions")
    if isinstance(dimensions, bool) or not isinstance(dimensions, int) or dimensions < 1:
        raise ValueError("Embedding response dimensions are invalid")
    if expected_dimensions is not None and dimensions != expected_dimensions:
        raise PermanentRagContractError("Embedding dimensions do not match the job manifest")
    data = payload.get("data")
    if not isinstance(data, list) or len(data) != expected_count:
        raise ValueError("Embedding response count does not match the request")

    vectors: list[list[float]] = []
    for vector in data:
        if not isinstance(vector, list) or len(vector) != dimensions:
            raise ValueError("Embedding vector dimensions are inconsistent")
        normalized: list[float] = []
        for component in vector:
            if isinstance(component, bool) or not isinstance(component, (int, float)):
                raise ValueError("Embedding vector contains a non-numeric value")
            numeric = float(component)
            if not math.isfinite(numeric):
                raise ValueError("Embedding vector contains a non-finite value")
            normalized.append(numeric)
        vectors.append(normalized)
    return vectors, dimensions, provider.strip()


class EmbeddingWorker:
    def __init__(self, *, gateway_url: str, gateway_token: str, opensearch_url: str, opensearch_auth: tuple[str, str] | None = None, embedding_model: str = "text-embedding-3-small", timeout: float = 60.0, verify_tls: bool | str = True, gateway_max_response_bytes: int = DEFAULT_GATEWAY_MAX_RESPONSE_BYTES) -> None:
        self.gateway_url = gateway_url.rstrip("/")
        self.gateway_token = gateway_token
        self.opensearch_url = opensearch_url.rstrip("/")
        self.opensearch_auth = opensearch_auth
        self.embedding_model = embedding_model
        self.timeout = timeout
        self.verify_tls = verify_tls
        self.gateway_max_response_bytes = max(64 * 1024, min(int(gateway_max_response_bytes), 128 * 1024 * 1024))

    def process(self, *, dataset_id: str, dataset_name: str, rows: list[dict[str, Any]] | None, body_columns: list[str], metadata_columns: list[str], target_index: str, source_manifest: dict[str, Any] | None = None, title_columns: list[str] | None = None, identifier_columns: list[str] | None = None, semantic_bindings: dict[str, list[dict[str, Any]]] | None = None, chunks: list[dict[str, Any]] | None = None, embedding_model: str | None = None, embedding_dimensions: int | None = None, metadata_types: dict[str, str] | None = None) -> dict[str, Any]:
        if chunks:
            return self.index_chunks(dataset_id=dataset_id, dataset_name=dataset_name, chunks=chunks, target_index=target_index, embedding_model=embedding_model, embedding_dimensions=embedding_dimensions, metadata_types=metadata_types)
        if os.environ.get("RAG_LEGACY_DIRECT_INDEX_ENABLED", "false").casefold() not in {"1", "true", "yes"}:
            raise PermanentRagContractError("RAG v2 indexing requires chunk staging; legacy direct row indexing is disabled")
        if not rows:
            if source_manifest is None:
                raise PermanentRagContractError("Either rows or a Catalog source manifest is required")
            rows = read_manifest_rows(source_manifest, dataset_id=dataset_id)
        documents = build_documents(dataset_id, dataset_name, rows, body_columns, metadata_columns, target_index, title_columns=title_columns, identifier_columns=identifier_columns, semantic_bindings=semantic_bindings, metadata_types=metadata_types)
        return self.index_documents(documents, embedding_model=embedding_model, embedding_dimensions=embedding_dimensions, metadata_types=metadata_types)

    def index_chunks(self, *, dataset_id: str, dataset_name: str, chunks: list[dict[str, Any]], target_index: str, embedding_model: str | None = None, embedding_dimensions: int | None = None, metadata_types: dict[str, str] | None = None) -> dict[str, Any]:
        documents = []
        seen_document_ids: set[str] = set()
        for chunk in chunks:
            embedding_text = str(chunk.get("embedding_text") or build_embedding_text(chunk.get("title"), str(chunk.get("text") or chunk.get("body") or "")))
            document_id = str(chunk.get("chunk_document_id") or chunk.get("document_id") or "").strip()
            parent_document_id = str(chunk.get("parent_document_id") or "").strip()
            if not document_id or not parent_document_id or not embedding_text.strip():
                raise PermanentRagContractError(
                    "Staged RAG chunks require document, parent, and embedding text identities"
                )
            if document_id in seen_document_ids:
                raise PermanentRagContractError("Staged RAG chunks contain duplicate document identities")
            seen_document_ids.add(document_id)
            metadata = chunk.get("metadata") if isinstance(chunk.get("metadata"), dict) else {}
            documents.append({
                "document_id": document_id,
                "job_id": str(chunk.get("job_id") or ""),
                "chunk_document_id": document_id,
                "parent_document_id": parent_document_id,
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
        requested_model = embedding_model or self.embedding_model
        all_document_ids = [item["document_id"] for item in documents]
        existing_ids = self.existing_document_ids(target_index, all_document_ids)
        documents = [item for item in documents if item["document_id"] not in existing_ids]
        if not documents:
            stored_contract = self.existing_embedding_contract(
                target_index,
                all_document_ids,
                expected_model=requested_model,
                expected_dimensions=embedding_dimensions,
            )
            return {
                "indexedCount": 0,
                "skippedExistingCount": len(existing_ids),
                "targetIndex": target_index,
                "dimensions": stored_contract["dimensions"],
                "embeddingProvider": stored_contract["embeddingProvider"],
                "embeddingModel": stored_contract["embeddingModel"],
            }
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

    def existing_embedding_contract(
        self,
        target_index: str,
        document_ids: list[str],
        *,
        expected_model: str,
        expected_dimensions: int | None,
    ) -> dict[str, Any]:
        """Read the persisted model contract when a retry has nothing to embed."""

        values = list(dict.fromkeys(str(value) for value in document_ids if str(value).strip()))
        if not values:
            raise PermanentRagContractError("Existing RAG document contract requires document identities")
        with httpx.Client(timeout=self.timeout, verify=self.verify_tls) as client:
            response = client.post(
                f"{self.opensearch_url}/{target_index}/_search",
                auth=self.opensearch_auth,
                json={
                    "size": len(values),
                    "_source": ["embedding_provider", "embedding_model", "embedding_dimensions"],
                    "query": {"ids": {"values": values}},
                },
            )
            if response.status_code == 404:
                raise PermanentRagContractError("Existing RAG documents disappeared before contract verification")
            response.raise_for_status()
            hits = response.json().get("hits", {}).get("hits", [])

        found_ids = {
            str(item.get("_id"))
            for item in hits
            if isinstance(item, dict) and item.get("_id")
        }
        if found_ids != set(values):
            raise PermanentRagContractError("Existing RAG documents changed before contract verification")
        contracts: set[tuple[str, str, int]] = set()
        for item in hits:
            source = item.get("_source") if isinstance(item, dict) else None
            provider = str((source or {}).get("embedding_provider") or "").strip()
            model = str((source or {}).get("embedding_model") or "").strip()
            raw_dimensions = (source or {}).get("embedding_dimensions")
            if (
                not provider
                or not model
                or isinstance(raw_dimensions, bool)
                or not isinstance(raw_dimensions, int)
                or raw_dimensions < 1
            ):
                raise PermanentRagContractError("Existing RAG document is missing its embedding contract")
            contracts.add((provider, model, raw_dimensions))
        if len(contracts) != 1:
            raise PermanentRagContractError("Existing RAG documents contain mixed embedding contracts")
        provider, model, dimensions = next(iter(contracts))
        if model != expected_model:
            raise PermanentRagContractError("Existing RAG document model does not match the retry contract")
        if expected_dimensions is not None and dimensions != expected_dimensions:
            raise PermanentRagContractError("Existing RAG document dimensions do not match the retry contract")
        return {
            "embeddingProvider": provider,
            "embeddingModel": model,
            "dimensions": dimensions,
        }

    def index_documents(self, documents: list[dict[str, Any]], *, embedding_model: str | None = None, embedding_dimensions: int | None = None, metadata_types: dict[str, str] | None = None) -> dict[str, Any]:
        if not documents:
            return {"indexedCount": 0, "targetIndex": None}
        model = embedding_model or self.embedding_model
        if not model.strip():
            raise PermanentRagContractError("Embedding model is required")
        with httpx.Client(timeout=self.timeout, verify=self.verify_tls) as client:
            dimensions = 0
            embedding_provider = ""
            for offset in range(0, len(documents), 64):
                batch = documents[offset:offset + 64]
                embedding_response = client.post(f"{self.gateway_url}/v1/embeddings", headers={"Authorization": f"Bearer {self.gateway_token}"}, json={"model": model, "input": [item["embedding_text"] for item in batch]})
                embedding_response.raise_for_status()
                embeddings, batch_dimensions, batch_provider = parse_embedding_response(
                    parse_bounded_gateway_json(embedding_response, max_bytes=self.gateway_max_response_bytes),
                    expected_count=len(batch),
                    expected_model=model,
                    expected_dimensions=embedding_dimensions,
                )
                if dimensions and batch_dimensions != dimensions:
                    raise PermanentRagContractError("Embedding dimensions changed within one indexing job")
                if embedding_provider and batch_provider != embedding_provider:
                    raise PermanentRagContractError("Embedding provider changed within one indexing job")
                dimensions = batch_dimensions
                embedding_provider = batch_provider
                self.assert_target_index_compatibility(
                    client,
                    batch[0].get("target_index"),
                    model,
                    dimensions,
                    embedding_provider,
                )
                if offset == 0:
                    block_mapping = {"type": "object", "dynamic": False, "properties": {"logicalField": {"type": "keyword"}, "physicalField": {"type": "keyword"}, "text": {"type": "text"}, "fieldText": {"type": "text"}, "start": {"type": "integer"}, "end": {"type": "integer"}, "valueStart": {"type": "integer"}, "valueEnd": {"type": "integer"}, "fieldValueStart": {"type": "integer"}, "fragmentStart": {"type": "integer"}, "fragmentEnd": {"type": "integer"}}}
                    source_field_mapping = {"type": "object", "dynamic": False, "properties": {"logicalField": {"type": "keyword"}, "physicalField": {"type": "keyword"}, "role": {"type": "keyword"}, "roles": {"type": "keyword"}}}
                    mapping = {"settings": {"index": {"knn": True}}, "mappings": {"properties": {"document_id": {"type": "keyword"}, "job_id": {"type": "keyword"}, "chunk_document_id": {"type": "keyword"}, "parent_document_id": {"type": "keyword"}, "dataset_id": {"type": "keyword"}, "source_row_id": {"type": "keyword"}, "title": {"type": "text"}, "body": {"type": "text"}, "embedding_text": {"type": "text"}, "body_vector": {"type": "knn_vector", "dimension": dimensions}, "filter_terms": {"type": "object", "enabled": True}, "metadata_filter": self._metadata_mapping(metadata_types), "metadata_display": {"type": "object", "enabled": False}, "semantic_bindings": {"type": "object", "enabled": True}, "source_columns": {"type": "keyword"}, "source_fields": source_field_mapping, "parent_source_fields": source_field_mapping, "title_blocks": block_mapping, "body_blocks": block_mapping, "chunk_index": {"type": "integer"}, "chunk_count": {"type": "integer"}, "start_sentence": {"type": "integer"}, "end_sentence": {"type": "integer"}, "char_start": {"type": "integer"}, "char_end": {"type": "integer"}, "chunking_strategy": {"type": "keyword"}, "chunking_version": {"type": "keyword"}, "embedding_input_version": {"type": "keyword"}, "field_rendering_version": {"type": "keyword"}, "content_hash": {"type": "keyword"}, "embedding_provider": {"type": "keyword"}, "embedding_model": {"type": "keyword"}, "embedding_dimensions": {"type": "integer"}, "fallback_applied": {"type": "boolean"}, "fallback_reason": {"type": "keyword"}}}}
                    create_response = client.put(f"{self.opensearch_url}/{batch[0].get('target_index')}", auth=self.opensearch_auth, json=mapping)
                    if create_response.status_code >= 400 and "resource_already_exists_exception" not in create_response.text:
                        create_response.raise_for_status()
                lines: list[str] = []
                for document, vector in zip(batch, embeddings):
                    document["body_vector"] = vector
                    document["embedding_provider"] = embedding_provider
                    lines.extend([
                        json.dumps({"index": {"_index": document["target_index"], "_id": document["document_id"]}}, allow_nan=False),
                        json.dumps(document, ensure_ascii=False, allow_nan=False),
                    ])
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
        return {"indexedCount": len(documents), "targetIndex": documents[0].get("target_index"), "dimensions": dimensions, "embeddingProvider": embedding_provider, "embeddingModel": model, "chunkingVersion": next((item.get("chunking_version") for item in documents if item.get("chunking_version")), None)}

    def assert_target_index_compatibility(
        self,
        client: httpx.Client,
        target_index: Any,
        model: str,
        dimensions: int,
        provider: str,
    ) -> None:
        """Reject accidental writes that would mix RAG model contracts."""

        index = str(target_index or "").strip()
        if not index:
            raise PermanentRagContractError("RAG target index is required")
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
            raise PermanentRagContractError("Target index vector dimensions do not match the requested embedding contract")
        sample_response = client.post(f"{self.opensearch_url}/{index}/_search", auth=self.opensearch_auth, json={"size": 1, "_source": ["embedding_provider", "embedding_model", "embedding_dimensions"], "query": {"match_all": {}}})
        if sample_response.status_code == 404:
            return
        sample_response.raise_for_status()
        hits = sample_response.json().get("hits", {}).get("hits", [])
        if not hits:
            return
        source = hits[0].get("_source") if isinstance(hits[0], dict) else {}
        existing_provider = str((source or {}).get("embedding_provider") or "").strip()
        if existing_provider and existing_provider != provider:
            raise PermanentRagContractError("Target index embedding provider does not match the requested embedding contract")
        existing_model = str((source or {}).get("embedding_model") or "").strip()
        if existing_model and existing_model != model:
            raise PermanentRagContractError("Target index embedding model does not match the requested embedding contract")
        existing_document_dimensions = int((source or {}).get("embedding_dimensions") or 0)
        if existing_document_dimensions and existing_document_dimensions != int(dimensions):
            raise PermanentRagContractError("Target index document dimensions do not match the requested embedding contract")

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
