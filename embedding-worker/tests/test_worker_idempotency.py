from app.worker import EmbeddingWorker


def make_worker() -> EmbeddingWorker:
    return EmbeddingWorker(gateway_url="http://gateway", gateway_token="token", opensearch_url="http://opensearch", verify_tls=False)


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


def test_legacy_direct_path_remains_callable_when_explicitly_enabled(monkeypatch):
    worker = make_worker()
    monkeypatch.setattr("app.worker.build_documents", lambda *args, **kwargs: [{"document_id": "legacy", "embedding_text": "legacy", "target_index": "reviews-v1"}])
    monkeypatch.setattr(worker, "index_documents", lambda documents, **kwargs: {"indexedCount": len(documents)})
    result = worker.process(dataset_id="reviews", dataset_name="reviews", rows=[{"review": "legacy"}], body_columns=["review"], metadata_columns=[], target_index="reviews-v1")
    assert result == {"indexedCount": 1}
