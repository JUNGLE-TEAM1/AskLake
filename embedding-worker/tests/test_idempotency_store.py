from app.idempotency import IdempotencyStore


def test_idempotency_store_replays_same_payload_and_rejects_key_reuse(tmp_path):
    store = IdempotencyStore(str(tmp_path / "idempotency.sqlite3"))
    payload = {"parents": [{"parent_document_id": "p1"}]}
    digest = store.input_hash(payload)
    store.put("request-1", digest, {"chunks": [{"chunk_document_id": "c1"}]})
    assert store.get("request-1", digest) == {"chunks": [{"chunk_document_id": "c1"}]}
    other_digest = store.input_hash({"parents": [{"parent_document_id": "p2"}]})
    try:
        store.get("request-1", other_digest)
    except ValueError as exc:
        assert "different request payload" in str(exc)
    else:
        raise AssertionError("reusing an idempotency key for a different payload must fail")
