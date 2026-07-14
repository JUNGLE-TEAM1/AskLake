import os
import json
from typing import Any

import httpx
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field, model_validator

from .worker import EmbeddingWorker
from .chunker import chunk_parent_document

app = FastAPI(title="AskLake Embedding Worker")


class IndexBatchRequest(BaseModel):
    dataset_id: str = Field(min_length=1, max_length=255)
    dataset_name: str = Field(min_length=1, max_length=255)
    rows: list[dict[str, Any]] | None = Field(default=None, max_length=1000)
    body_columns: list[str] = Field(min_length=1, max_length=50)
    title_columns: list[str] = Field(default_factory=list, max_length=20)
    metadata_columns: list[str] = Field(default_factory=list, max_length=100)
    identifier_columns: list[str] = Field(default_factory=list, max_length=20)
    semantic_bindings: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
    target_index: str = Field(min_length=1, max_length=255)
    embedding_model: str | None = Field(default=None, min_length=1, max_length=255)
    embedding_dimensions: int | None = Field(default=None, ge=1, le=16_384)
    source_manifest: dict[str, Any] | None = None
    chunks: list[dict[str, Any]] | None = Field(default=None, max_length=5_000)

    @model_validator(mode="after")
    def require_rows_or_manifest(self) -> "IndexBatchRequest":
        if not self.rows and not self.source_manifest and not self.chunks:
            raise ValueError("rows, chunks, or sourceManifest is required")
        if not self.chunks and os.environ.get("RAG_LEGACY_DIRECT_INDEX_ENABLED", "false").casefold() not in {"1", "true", "yes"}:
            raise ValueError("RAG v2 indexing requires staged chunks")
        return self


class ChunkBatchRequest(BaseModel):
    parents: list[dict[str, Any]] = Field(min_length=1, max_length=64)
    target_tokens: int = Field(default=800, ge=100, le=2_000)
    overlap_tokens: int = Field(default=400, ge=0, le=1_000)
    max_tokens: int = Field(default=1_200, ge=100, le=4_000)
    embedding_model: str | None = Field(default=None, min_length=1, max_length=255)


def worker_from_env() -> EmbeddingWorker:
    username = os.environ.get("OPENSEARCH_USERNAME")
    password = os.environ.get("OPENSEARCH_PASSWORD", "")
    return EmbeddingWorker(gateway_url=os.environ.get("AI_GATEWAY_BASE_URL", "http://ai-gateway:8080"), gateway_token=os.environ.get("AI_GATEWAY_SERVICE_TOKEN", ""), opensearch_url=os.environ.get("OPENSEARCH_BASE_URL", "http://opensearch:9200"), opensearch_auth=(username, password) if username else None, embedding_model=os.environ.get("RAG_EMBEDDING_MODEL", "text-embedding-3-small"), verify_tls=os.environ.get("OPENSEARCH_VERIFY_TLS", "true").casefold() in {"1", "true", "yes"})


def gateway_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {os.environ.get('AI_GATEWAY_SERVICE_TOKEN', '')}", "Content-Type": "application/json"}


def chunk_with_gateway(request: ChunkBatchRequest) -> list[dict[str, Any]]:
    gateway_url = os.environ.get("AI_GATEWAY_BASE_URL", "http://ai-gateway:8080").rstrip("/")
    timeout = float(os.environ.get("AI_GATEWAY_TIMEOUT_SECONDS", "60"))
    model = request.embedding_model or os.environ.get("RAG_EMBEDDING_MODEL", "text-embedding-3-small")

    def embed_sentences(inputs: list[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        with httpx.Client(timeout=timeout) as client:
            for offset in range(0, len(inputs), 64):
                response = client.post(f"{gateway_url}/v1/embeddings", headers=gateway_headers(), json={"model": model, "input": inputs[offset:offset + 64]})
                response.raise_for_status()
                vectors.extend(response.json().get("data") or [])
        if len(vectors) != len(inputs):
            raise RuntimeError("Sentence embedding count does not match sentence count")
        return vectors

    def refine(sentences: list[dict[str, Any]], boundaries: list[int]) -> list[dict[str, int]]:
        if len(json.dumps({"sentences": sentences, "candidateBoundaries": boundaries}, ensure_ascii=False, separators=(",", ":"))) > 24_000:
            raise ValueError("Document segmentation context exceeds the bounded AI Gateway refinement budget")
        with httpx.Client(timeout=timeout) as client:
            response = client.post(f"{gateway_url}/v1/generate", headers=gateway_headers(), json={"mode": "segment_document", "request_id": f"chunk-{os.urandom(8).hex()}", "prompt": "Refine only the proposed sentence boundaries.", "context": {"sentences": sentences, "candidateBoundaries": boundaries}, "selected_dataset_ids": []})
            response.raise_for_status()
            output = response.json().get("output") or {}
            return list(output.get("segments") or [])

    chunks = []
    for parent in request.parents:
        chunks.extend(chunk_parent_document(parent, embed_sentences=embed_sentences, refine_boundaries=refine, target_tokens=request.target_tokens, overlap_tokens=request.overlap_tokens, max_tokens=request.max_tokens))
    return chunks


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "embedding-worker"}


@app.post("/v1/index")
def index_batch(request: IndexBatchRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    expected = os.environ.get("WORKER_INTERNAL_TOKEN")
    if not expected:
        raise HTTPException(status_code=503, detail="Worker internal token is not configured")
    if authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="Invalid worker token")
    try:
        return worker_from_env().process(dataset_id=request.dataset_id, dataset_name=request.dataset_name, rows=request.rows, body_columns=request.body_columns, title_columns=request.title_columns, metadata_columns=request.metadata_columns, identifier_columns=request.identifier_columns, semantic_bindings=request.semantic_bindings, target_index=request.target_index, source_manifest=request.source_manifest, chunks=request.chunks, embedding_model=request.embedding_model, embedding_dimensions=request.embedding_dimensions)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="RAG indexing failed") from exc


@app.post("/v1/chunk")
def chunk_batch(request: ChunkBatchRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    expected = os.environ.get("WORKER_INTERNAL_TOKEN")
    if not expected:
        raise HTTPException(status_code=503, detail="Worker internal token is not configured")
    if authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="Invalid worker token")
    try:
        chunks = chunk_with_gateway(request)
        return {"schemaVersion": "rag-chunk-v1", "chunkCount": len(chunks), "chunks": chunks}
    except Exception as exc:
        raise HTTPException(status_code=502, detail="RAG chunking failed") from exc
