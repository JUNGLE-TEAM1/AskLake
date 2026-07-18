import hashlib
import json
import logging
import os
import re
from typing import Any

import httpx
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator

from .worker import (
    DEFAULT_GATEWAY_MAX_RESPONSE_BYTES,
    EmbeddingWorker,
    parse_bounded_gateway_json,
    parse_embedding_response,
    validate_generation_response,
)
from .chunker import chunk_parent_document
from .rag_core import CHUNKING_VERSION
from .idempotency import IdempotencyStore, LeaseHeartbeat
from .errors import PermanentRagContractError

app = FastAPI(title="AskLake Embedding Worker")
logger = logging.getLogger(__name__)
MAX_RAG_SCHEMA_FIELDS = 256


def release_claim(store: IdempotencyStore, key: str, request_hash: str, lease_token: str | None, *, retryable: bool, error: str = "") -> None:
    """Best-effort cleanup that never masks the original request failure."""
    if not lease_token:
        return
    try:
        store.fail_or_release(key, request_hash, lease_token, retryable=retryable, error=error)
    except Exception:
        logger.exception("Could not release RAG idempotency lease for %s", key)


class IndexBatchRequest(BaseModel):
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=512)
    dataset_id: str = Field(min_length=1, max_length=255)
    dataset_name: str = Field(min_length=1, max_length=255)
    rows: list[dict[str, Any]] | None = Field(default=None, max_length=1000)
    body_columns: list[str] = Field(min_length=1, max_length=MAX_RAG_SCHEMA_FIELDS)
    title_columns: list[str] = Field(default_factory=list, max_length=MAX_RAG_SCHEMA_FIELDS)
    metadata_columns: list[str] = Field(default_factory=list, max_length=MAX_RAG_SCHEMA_FIELDS)
    identifier_columns: list[str] = Field(default_factory=list, max_length=MAX_RAG_SCHEMA_FIELDS)
    semantic_bindings: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
    target_index: str = Field(min_length=1, max_length=255)
    embedding_model: str | None = Field(default=None, min_length=1, max_length=255)
    embedding_dimensions: int | None = Field(default=None, ge=1, le=16_384)
    metadata_types: dict[str, str] = Field(default_factory=dict, max_length=MAX_RAG_SCHEMA_FIELDS)
    source_manifest: dict[str, Any] | None = None
    chunks: list[dict[str, Any]] | None = Field(default=None, max_length=5_000)

    @field_validator("target_index")
    @classmethod
    def validate_target_index(cls, value: str) -> str:
        normalized = value.strip()
        if (
            normalized in {".", ".."}
            or re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,254}", normalized) is None
        ):
            raise ValueError("targetIndex must be a safe lowercase OpenSearch index name")
        return normalized

    @field_validator("body_columns", "title_columns", "metadata_columns", "identifier_columns")
    @classmethod
    def validate_role_columns(cls, values: list[str]) -> list[str]:
        normalized = [str(value).strip() for value in values]
        if any(not value for value in normalized):
            raise ValueError("RAG role columns cannot contain blank names")
        if len(set(normalized)) != len(normalized):
            raise ValueError("RAG role columns cannot contain duplicates")
        return normalized

    @model_validator(mode="after")
    def require_rows_or_manifest(self) -> "IndexBatchRequest":
        if not self.rows and not self.source_manifest and not self.chunks:
            raise ValueError("rows, chunks, or sourceManifest is required")
        if not self.chunks and os.environ.get("RAG_LEGACY_DIRECT_INDEX_ENABLED", "false").casefold() not in {"1", "true", "yes"}:
            raise ValueError("RAG v2 indexing requires staged chunks")
        approved_schema_fields = {
            *self.body_columns,
            *self.title_columns,
            *self.metadata_columns,
            *self.identifier_columns,
        }
        if len(approved_schema_fields) > MAX_RAG_SCHEMA_FIELDS:
            raise ValueError(f"RAG role columns cannot reference more than {MAX_RAG_SCHEMA_FIELDS} schema fields")
        return self


class ChunkBatchRequest(BaseModel):
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=512)
    parents: list[dict[str, Any]] = Field(min_length=1, max_length=64)
    target_tokens: int = Field(default=800, ge=100, le=2_000)
    overlap_tokens: int = Field(default=400, ge=0, le=1_000)
    max_tokens: int = Field(default=1_200, ge=100, le=4_000)
    embedding_model: str | None = Field(default=None, min_length=1, max_length=255)
    embedding_dimensions: int | None = Field(default=None, ge=1, le=16_384)


def gateway_max_response_bytes() -> int:
    try:
        value = int(os.environ.get("AI_GATEWAY_MAX_EMBEDDING_RESPONSE_BYTES", DEFAULT_GATEWAY_MAX_RESPONSE_BYTES))
    except (TypeError, ValueError):
        value = DEFAULT_GATEWAY_MAX_RESPONSE_BYTES
    return max(64 * 1024, min(value, 128 * 1024 * 1024))


def worker_from_env() -> EmbeddingWorker:
    username = os.environ.get("OPENSEARCH_USERNAME")
    password = os.environ.get("OPENSEARCH_PASSWORD", "")
    return EmbeddingWorker(gateway_url=os.environ.get("AI_GATEWAY_BASE_URL", "http://ai-server:8090"), gateway_token=os.environ.get("AI_GATEWAY_SERVICE_TOKEN", ""), opensearch_url=os.environ.get("OPENSEARCH_BASE_URL", "http://opensearch:9200"), opensearch_auth=(username, password) if username else None, embedding_model=os.environ.get("RAG_EMBEDDING_MODEL", "text-embedding-3-small"), timeout=float(os.environ.get("AI_GATEWAY_TIMEOUT_SECONDS", "60")), verify_tls=os.environ.get("OPENSEARCH_CA_CERT") or os.environ.get("OPENSEARCH_VERIFY_TLS", "true").casefold() in {"1", "true", "yes"}, gateway_max_response_bytes=gateway_max_response_bytes())


def gateway_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {os.environ.get('AI_GATEWAY_SERVICE_TOKEN', '')}", "Content-Type": "application/json"}


def chunk_with_gateway(request: ChunkBatchRequest) -> list[dict[str, Any]]:
    gateway_url = os.environ.get("AI_GATEWAY_BASE_URL", "http://ai-server:8090").rstrip("/")
    timeout = float(os.environ.get("AI_GATEWAY_TIMEOUT_SECONDS", "60"))
    model = request.embedding_model or os.environ.get("RAG_EMBEDDING_MODEL", "text-embedding-3-small")

    def embed_sentences(inputs: list[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        with httpx.Client(timeout=timeout) as client:
            for offset in range(0, len(inputs), 64):
                response = client.post(f"{gateway_url}/v1/embeddings", headers=gateway_headers(), json={"model": model, "input": inputs[offset:offset + 64]})
                response.raise_for_status()
                batch = inputs[offset:offset + 64]
                parsed, _dimensions, _provider = parse_embedding_response(
                    parse_bounded_gateway_json(response, max_bytes=gateway_max_response_bytes()),
                    expected_count=len(batch),
                    expected_model=model,
                    expected_dimensions=request.embedding_dimensions,
                )
                vectors.extend(parsed)
        return vectors

    def refine(sentences: list[dict[str, Any]], boundaries: list[int], parent: dict[str, Any]) -> list[dict[str, int]]:
        if len(json.dumps({"sentences": sentences, "candidateBoundaries": boundaries}, ensure_ascii=False, separators=(",", ":"))) > 24_000:
            raise ValueError("Document segmentation context exceeds the bounded AI Gateway refinement budget")
        with httpx.Client(timeout=timeout) as client:
            parent_key = str(parent.get("parent_document_id") or "")
            parent_digest = hashlib.sha256(parent_key.encode("utf-8")).hexdigest()[:24]
            request_id = f"chunk-boundary:{parent_digest}:{request.target_tokens}:{request.overlap_tokens}:{request.max_tokens}"
            response = client.post(f"{gateway_url}/v1/generate", headers=gateway_headers(), json={"mode": "segment_document", "request_id": request_id, "prompt": "Refine only the proposed sentence boundaries.", "context": {"parentDocumentId": parent.get("parent_document_id"), "title": parent.get("title"), "targetTokens": request.target_tokens, "overlapTokens": request.overlap_tokens, "maxTokens": request.max_tokens, "sentences": sentences, "candidateBoundaries": boundaries}, "selected_dataset_ids": []})
            response.raise_for_status()
            payload = parse_bounded_gateway_json(response, max_bytes=min(gateway_max_response_bytes(), 1024 * 1024))
            output = validate_generation_response(payload, request_id=request_id, mode="segment_document")["output"]
            return list(output.get("segments") or [])

    chunks = []
    for parent in request.parents:
        parent = {**parent, "embedding_model": model, "embedding_dimensions": request.embedding_dimensions}
        chunks.extend(chunk_parent_document(parent, embed_sentences=embed_sentences, refine_boundaries=lambda sentences, boundaries, current_parent=parent: refine(sentences, boundaries, current_parent), target_tokens=request.target_tokens, overlap_tokens=request.overlap_tokens, max_tokens=request.max_tokens))
    return chunks


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "embedding-worker"}


@app.get("/ready")
def ready() -> dict[str, str]:
    """Readiness probe that verifies both downstream services are reachable."""

    worker = worker_from_env()
    auth = worker.opensearch_auth
    with httpx.Client(timeout=5, verify=worker.verify_tls) as client:
        opensearch = client.get(f"{worker.opensearch_url}/_cluster/health", auth=auth)
        opensearch.raise_for_status()
        if str(opensearch.json().get("status") or "").casefold() not in {"yellow", "green"}:
            raise HTTPException(status_code=503, detail="OpenSearch cluster is not ready")
        gateway = client.get(f"{worker.gateway_url}/health", headers=gateway_headers())
        gateway.raise_for_status()
    return {"status": "ready", "service": "embedding-worker"}


@app.post("/v1/index")
def index_batch(request: IndexBatchRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    expected = os.environ.get("WORKER_INTERNAL_TOKEN")
    if not expected:
        raise HTTPException(status_code=503, detail="Worker internal token is not configured")
    if authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="Invalid worker token")
    try:
        store = IdempotencyStore()
        payload = request.model_dump(mode="json")
        key = request.idempotency_key or store.input_hash(payload)
        request_hash = store.input_hash(payload)
        state, cached, lease_token = store.claim(key, request_hash, lease_seconds=float(os.environ.get("RAG_IDEMPOTENCY_LEASE_SECONDS", "1800")))
        if state == "completed" and cached is not None:
            return {**cached, "idempotentReplay": True}
        if state == "in_progress":
            raise HTTPException(status_code=409, detail="An identical RAG indexing request is already in progress")
        if state == "permanent_failed":
            raise HTTPException(status_code=409, detail="An identical RAG indexing request previously failed permanently")
        lease_seconds = float(os.environ.get("RAG_IDEMPOTENCY_LEASE_SECONDS", "1800"))
        with LeaseHeartbeat(store, key, request_hash, lease_token or "", lease_seconds=lease_seconds) as heartbeat:
            result = worker_from_env().process(dataset_id=request.dataset_id, dataset_name=request.dataset_name, rows=request.rows, body_columns=request.body_columns, title_columns=request.title_columns, metadata_columns=request.metadata_columns, identifier_columns=request.identifier_columns, semantic_bindings=request.semantic_bindings, target_index=request.target_index, source_manifest=request.source_manifest, chunks=request.chunks, embedding_model=request.embedding_model, embedding_dimensions=request.embedding_dimensions, metadata_types=request.metadata_types)
            heartbeat.assert_owned()
            store.put(key, request_hash, result, lease_token=lease_token)
        return result
    except PermanentRagContractError as exc:
        if "store" in locals() and "lease_token" in locals():
            release_claim(store, key, request_hash, lease_token, retryable=False, error=str(exc))
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        if "store" in locals() and "lease_token" in locals():
            release_claim(store, key, request_hash, lease_token, retryable=True, error=str(exc))
        raise HTTPException(status_code=502, detail="RAG indexing upstream response was invalid or transient") from exc
    except HTTPException:
        if "store" in locals() and "lease_token" in locals():
            release_claim(store, key, request_hash, lease_token, retryable=True)
        raise
    except Exception as exc:
        if "store" in locals() and "lease_token" in locals():
            release_claim(store, key, request_hash, lease_token, retryable=True, error=str(exc))
        raise HTTPException(status_code=502, detail="RAG indexing failed") from exc


@app.post("/v1/chunk")
def chunk_batch(request: ChunkBatchRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    expected = os.environ.get("WORKER_INTERNAL_TOKEN")
    if not expected:
        raise HTTPException(status_code=503, detail="Worker internal token is not configured")
    if authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="Invalid worker token")
    try:
        store = IdempotencyStore()
        payload = request.model_dump(mode="json")
        key = request.idempotency_key or store.input_hash(payload)
        request_hash = store.input_hash(payload)
        state, cached, lease_token = store.claim(key, request_hash, lease_seconds=float(os.environ.get("RAG_IDEMPOTENCY_LEASE_SECONDS", "1800")))
        if state == "completed" and cached is not None:
            return {**cached, "idempotentReplay": True}
        if state == "in_progress":
            raise HTTPException(status_code=409, detail="An identical RAG chunking request is already in progress")
        if state == "permanent_failed":
            raise HTTPException(status_code=409, detail="An identical RAG chunking request previously failed permanently")
        lease_seconds = float(os.environ.get("RAG_IDEMPOTENCY_LEASE_SECONDS", "1800"))
        with LeaseHeartbeat(store, key, request_hash, lease_token or "", lease_seconds=lease_seconds) as heartbeat:
            chunks = chunk_with_gateway(request)
            result = {"schemaVersion": CHUNKING_VERSION, "chunkCount": len(chunks), "chunks": chunks}
            heartbeat.assert_owned()
            store.put(key, request_hash, result, lease_token=lease_token)
        return result
    except PermanentRagContractError as exc:
        if "store" in locals() and "lease_token" in locals():
            release_claim(store, key, request_hash, lease_token, retryable=False, error=str(exc))
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        if "store" in locals() and "lease_token" in locals():
            release_claim(store, key, request_hash, lease_token, retryable=True, error=str(exc))
        raise HTTPException(status_code=502, detail="RAG chunking upstream response was invalid or transient") from exc
    except HTTPException:
        if "store" in locals() and "lease_token" in locals():
            release_claim(store, key, request_hash, lease_token, retryable=True)
        raise
    except Exception as exc:
        if "store" in locals() and "lease_token" in locals():
            release_claim(store, key, request_hash, lease_token, retryable=True, error=str(exc))
        raise HTTPException(status_code=502, detail="RAG chunking failed") from exc
