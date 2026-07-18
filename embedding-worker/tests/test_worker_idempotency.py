import httpx
import pytest

from app.worker import (
    EmbeddingWorker,
    parse_bounded_gateway_json,
    parse_embedding_response,
    validate_generation_response,
)
from fastapi import HTTPException

from app.main import IndexBatchRequest, index_batch
from app.idempotency import IdempotencyStore
from app.errors import PermanentRagContractError


def make_worker() -> EmbeddingWorker:
    return EmbeddingWorker(gateway_url="http://gateway", gateway_token="token", opensearch_url="http://opensearch", verify_tls=False)


def test_embedding_response_requires_exact_model_count_dimensions_and_finite_values() -> None:
    vectors, dimensions, provider = parse_embedding_response(
        {"provider": "openai_compatible", "model": "embed-model", "dimensions": 2, "data": [[0.1, 0.2], [0.3, 0.4]]},
        expected_count=2,
        expected_model="embed-model",
        expected_dimensions=2,
    )
    assert vectors == [[0.1, 0.2], [0.3, 0.4]]
    assert dimensions == 2
    assert provider == "openai_compatible"

    invalid_payloads = [
        {"provider": "openai_compatible", "model": "wrong", "dimensions": 2, "data": [[0.1, 0.2]]},
        {"provider": "openai_compatible", "model": "embed-model", "dimensions": 2, "data": []},
        {"provider": "openai_compatible", "model": "embed-model", "dimensions": 2, "data": [[0.1]]},
        {"provider": "openai_compatible", "model": "embed-model", "dimensions": 2, "data": [[float("nan"), 0.2]]},
    ]
    for payload in invalid_payloads:
        with pytest.raises(ValueError):
            parse_embedding_response(
                payload,
                expected_count=1,
                expected_model="embed-model",
                expected_dimensions=2,
            )


def test_gateway_response_size_and_generation_identity_are_validated() -> None:
    request = httpx.Request("POST", "http://ai-server:8090/v1/generate")
    oversized = httpx.Response(200, request=request, content=b"{}" + b" " * 128)
    with pytest.raises(ValueError, match="size limit"):
        parse_bounded_gateway_json(oversized, max_bytes=64)

    payload = {
        "request_id": "segment-1",
        "mode": "segment_document",
        "output": {"segments": []},
        "provider": "openai_compatible",
        "model": "segment-model",
        "usage": {"inputTokens": 10, "outputTokens": 2, "totalTokens": 12, "estimatedCostUsd": 0.001},
    }
    assert validate_generation_response(payload, request_id="segment-1", mode="segment_document") is payload
    with pytest.raises(ValueError, match="identity"):
        validate_generation_response(payload, request_id="other", mode="segment_document")


def test_index_contract_rejects_unsafe_target_and_duplicate_chunk_ids(monkeypatch) -> None:
    with pytest.raises(ValueError, match="safe lowercase"):
        IndexBatchRequest.model_validate({
            "dataset_id": "d",
            "dataset_name": "d",
            "body_columns": ["text"],
            "target_index": "../_cat/indices",
            "chunks": [{"chunk_document_id": "c1", "parent_document_id": "p1", "text": "body"}],
        })

    worker = make_worker()
    monkeypatch.setattr(worker, "existing_document_ids", lambda *_args: set())
    with pytest.raises(PermanentRagContractError, match="duplicate"):
        worker.index_chunks(
            dataset_id="reviews",
            dataset_name="reviews",
            target_index="reviews-v1",
            chunks=[
                {"chunk_document_id": "same", "parent_document_id": "p1", "embedding_text": "first"},
                {"chunk_document_id": "same", "parent_document_id": "p2", "embedding_text": "second"},
            ],
        )


def test_index_contract_accepts_256_schema_fields_and_rejects_257() -> None:
    columns = [f"field_{index}" for index in range(256)]
    request = IndexBatchRequest.model_validate({
        "dataset_id": "d",
        "dataset_name": "d",
        "body_columns": columns,
        "title_columns": [columns[0]],
        "metadata_columns": [columns[1]],
        "identifier_columns": [columns[2]],
        "target_index": "d-v1",
        "chunks": [{"chunk_document_id": "c1", "parent_document_id": "p1", "text": "body"}],
    })
    assert len(set(request.body_columns)) == 256

    with pytest.raises(ValueError, match="256"):
        IndexBatchRequest.model_validate({
            "dataset_id": "d",
            "dataset_name": "d",
            "body_columns": columns,
            "title_columns": ["field_256"],
            "target_index": "d-v1",
            "chunks": [{"chunk_document_id": "c1", "parent_document_id": "p1", "text": "body"}],
        })

    with pytest.raises(ValueError):
        IndexBatchRequest.model_validate({
            "dataset_id": "d",
            "dataset_name": "d",
            "body_columns": [*columns, "field_256"],
            "target_index": "d-v1",
            "chunks": [{"chunk_document_id": "c1", "parent_document_id": "p1", "text": "body"}],
        })


def test_index_api_contract_rejects_direct_rows_without_explicit_legacy_flag(monkeypatch):
    monkeypatch.delenv("RAG_LEGACY_DIRECT_INDEX_ENABLED", raising=False)
    try:
        IndexBatchRequest.model_validate({"dataset_id": "d", "dataset_name": "d", "rows": [{"text": "legacy"}], "body_columns": ["text"], "target_index": "d-v1"})
    except ValueError as exc:
        assert "staged chunks" in str(exc)
    else:
        raise AssertionError("direct row indexing must be disabled for RAG v2")


def test_retry_skips_chunks_already_persisted_before_embedding(monkeypatch):
    worker = make_worker()
    captured = {}
    monkeypatch.setattr(worker, "existing_document_ids", lambda index, ids: {ids[0]})

    def fake_index(documents, **kwargs):
        captured["documents"] = documents
        return {"indexedCount": len(documents), "dimensions": 2}

    monkeypatch.setattr(worker, "index_documents", fake_index)
    result = worker.index_chunks(
        dataset_id="reviews",
        dataset_name="reviews",
        target_index="reviews-v1",
        chunks=[
            {"chunk_document_id": "already", "parent_document_id": "p1", "text": "old", "embedding_text": "old"},
            {"chunk_document_id": "new", "parent_document_id": "p2", "text": "new", "embedding_text": "new"},
        ],
    )
    assert result["indexedCount"] == 1
    assert result["skippedExistingCount"] == 1
    assert [item["document_id"] for item in captured["documents"]] == ["new"]


def test_retry_with_all_chunks_persisted_does_not_call_embedding(monkeypatch):
    worker = make_worker()
    monkeypatch.setattr(worker, "existing_document_ids", lambda index, ids: set(ids))
    monkeypatch.setattr(
        worker,
        "existing_embedding_contract",
        lambda index, ids, **kwargs: {
            "embeddingProvider": "openai_compatible",
            "embeddingModel": "text-embedding-3-small",
            "dimensions": 1536,
        },
    )
    monkeypatch.setattr(worker, "index_documents", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("embedding must not run")))
    result = worker.index_chunks(dataset_id="reviews", dataset_name="reviews", target_index="reviews-v1", embedding_dimensions=1536, chunks=[{"chunk_document_id": "already", "parent_document_id": "p1", "text": "old", "embedding_text": "old"}])
    assert result["indexedCount"] == 0
    assert result["skippedExistingCount"] == 1
    assert result["embeddingProvider"] == "openai_compatible"
    assert result["embeddingModel"] == "text-embedding-3-small"
    assert result["dimensions"] == 1536


def test_all_existing_retry_rejects_missing_or_mixed_persisted_contract(monkeypatch):
    worker = make_worker()

    class Response:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {
                "hits": {
                    "hits": [
                        {"_id": "a", "_source": {"embedding_provider": "openai", "embedding_model": "model", "embedding_dimensions": 2}},
                        {"_id": "b", "_source": {"embedding_provider": "other", "embedding_model": "model", "embedding_dimensions": 2}},
                    ]
                }
            }

    class Client:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def post(self, *args, **kwargs):
            return Response()

    monkeypatch.setattr("app.worker.httpx.Client", Client)
    with pytest.raises(PermanentRagContractError, match="mixed"):
        worker.existing_embedding_contract(
            "reviews-v1",
            ["a", "b"],
            expected_model="model",
            expected_dimensions=2,
        )


def test_chunk_indexing_keeps_logical_display_and_physical_filter_fields(monkeypatch):
    worker = make_worker()
    captured = {}
    monkeypatch.setattr(worker, "existing_document_ids", lambda index, ids: set())

    def fake_index(documents, **kwargs):
        captured["documents"] = documents
        return {"indexedCount": len(documents), "dimensions": 2}

    monkeypatch.setattr(worker, "index_documents", fake_index)
    worker.index_chunks(
        dataset_id="reviews",
        dataset_name="reviews",
        target_index="reviews-v3",
        metadata_types={"review_rating": "integer"},
        chunks=[{
            "chunk_document_id": "chunk-1",
            "parent_document_id": "parent-1",
            "body": "[BODY]\nreview_text: late\n[/BODY]",
            "embedding_text": "[TITLE]\ntitle: item\n[/TITLE]\n\n[BODY]\nreview_text: late\n[/BODY]",
            "metadata": {"review_rating": 3},
            "metadata_display": {"Review.Rating": 3},
            "source_fields": [{"logicalField": "Review.Rating", "physicalField": "review_rating", "role": "metadata"}],
            "body_blocks": [{"logicalField": "review_text", "physicalField": "review_text", "fragmentStart": 10, "fragmentEnd": 14, "text": "late"}],
        }],
    )
    document = captured["documents"][0]
    assert document["metadata_filter"]["review_rating"]["number"] == 3.0
    assert document["metadata_display"] == {"Review.Rating": 3}
    assert document["source_fields"][0]["physicalField"] == "review_rating"
    assert document["body_blocks"][0]["logicalField"] == "review_text"


def test_legacy_direct_path_remains_callable_when_explicitly_enabled(monkeypatch):
    worker = make_worker()
    monkeypatch.setenv("RAG_LEGACY_DIRECT_INDEX_ENABLED", "true")
    monkeypatch.setattr("app.worker.build_documents", lambda *args, **kwargs: [{"document_id": "legacy", "embedding_text": "legacy", "target_index": "reviews-v1"}])
    monkeypatch.setattr(worker, "index_documents", lambda documents, **kwargs: {"indexedCount": len(documents)})
    result = worker.process(dataset_id="reviews", dataset_name="reviews", rows=[{"review": "legacy"}], body_columns=["review"], metadata_columns=[], target_index="reviews-v1")
    assert result == {"indexedCount": 1}


def test_existing_target_index_rejects_embedding_dimension_mismatch():
    worker = make_worker()

    class Response:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"reviews-v1": {"mappings": {"properties": {"body_vector": {"dimension": 3}}}}}

    class Client:
        def get(self, *args, **kwargs):
            return Response()

        def post(self, *args, **kwargs):
            raise AssertionError("dimension mismatch must fail before document inspection")

    try:
        worker.assert_target_index_compatibility(Client(), "reviews-v1", "model-a", 2, "openai_compatible")
    except PermanentRagContractError as exc:
        assert "dimensions" in str(exc)
    else:
        raise AssertionError("expected target index dimension mismatch")


def test_upstream_value_error_releases_request_for_retry(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKER_INTERNAL_TOKEN", "token")
    monkeypatch.setenv("RAG_IDEMPOTENCY_STORE_PATH", str(tmp_path / "idempotency.sqlite3"))
    monkeypatch.setattr("app.main.worker_from_env", lambda: type("FailingWorker", (), {"process": lambda *args, **kwargs: (_ for _ in ()).throw(ValueError("invalid upstream JSON"))})())
    request = IndexBatchRequest(dataset_id="reviews", dataset_name="reviews", body_columns=["review"], target_index="reviews-v1", chunks=[{"chunk_document_id": "c1", "parent_document_id": "p1", "text": "body"}], idempotency_key="request-json-retry")
    try:
        index_batch(request, "Bearer token")
    except HTTPException as exc:
        assert exc.status_code == 502
    else:
        raise AssertionError("upstream response parsing errors must be retryable")
    store = IdempotencyStore()
    digest = store.input_hash(request.model_dump(mode="json"))
    assert store.claim("request-json-retry", digest)[0] == "claimed"


def test_contract_error_is_permanent(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKER_INTERNAL_TOKEN", "token")
    monkeypatch.setenv("RAG_IDEMPOTENCY_STORE_PATH", str(tmp_path / "idempotency.sqlite3"))
    monkeypatch.setattr("app.main.worker_from_env", lambda: type("FailingWorker", (), {"process": lambda *args, **kwargs: (_ for _ in ()).throw(PermanentRagContractError("bad contract"))})())
    request = IndexBatchRequest(dataset_id="reviews", dataset_name="reviews", body_columns=["review"], target_index="reviews-v1", chunks=[{"chunk_document_id": "c1", "parent_document_id": "p1", "text": "body"}], idempotency_key="request-contract")
    try:
        index_batch(request, "Bearer token")
    except HTTPException as exc:
        assert exc.status_code == 409
    else:
        raise AssertionError("contract errors must be permanent")
    store = IdempotencyStore()
    digest = store.input_hash(request.model_dump(mode="json"))
    assert store.claim("request-contract", digest)[0] == "permanent_failed"
