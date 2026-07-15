import time

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


def test_idempotency_store_claims_a_lease_and_reclaims_after_expiry(tmp_path, monkeypatch):
    store = IdempotencyStore(str(tmp_path / "idempotency.sqlite3"))
    payload_hash = store.input_hash({"request": "same"})

    assert store.claim("request-lease", payload_hash, lease_seconds=30)[0] == "claimed"
    assert store.claim("request-lease", payload_hash, lease_seconds=30)[0] == "in_progress"

    current = time.time()
    monkeypatch.setattr("app.idempotency.time.time", lambda: current + 31.0)
    store = IdempotencyStore(str(tmp_path / "idempotency.sqlite3"))
    assert store.claim("request-lease", payload_hash, lease_seconds=30)[0] == "claimed"

    store.put("request-lease", payload_hash, {"ok": True})
    state, response = store.claim("request-lease", payload_hash)
    assert state == "completed"
    assert response == {"ok": True}
