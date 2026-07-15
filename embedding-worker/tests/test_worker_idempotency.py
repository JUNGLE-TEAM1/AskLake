from app.worker import EmbeddingWorker
from app.main import IndexBatchRequest


def make_worker() -> EmbeddingWorker:
    return EmbeddingWorker(gateway_url="http://gateway", gateway_token="token", opensearch_url="http://opensearch", verify_tls=False)


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
    monkeypatch.setattr(worker, "index_documents", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("embedding must not run")))
    result = worker.index_chunks(dataset_id="reviews", dataset_name="reviews", target_index="reviews-v1", chunks=[{"chunk_document_id": "already", "parent_document_id": "p1", "text": "old", "embedding_text": "old"}])
    assert result["indexedCount"] == 0
    assert result["skippedExistingCount"] == 1


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
        worker.assert_target_index_compatibility(Client(), "reviews-v1", "model-a", 2)
    except RuntimeError as exc:
        assert "dimensions" in str(exc)
    else:
        raise AssertionError("expected target index dimension mismatch")
