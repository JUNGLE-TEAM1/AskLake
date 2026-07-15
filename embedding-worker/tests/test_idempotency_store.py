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

    state, _, first_token = store.claim("request-lease", payload_hash, lease_seconds=30)
    assert state == "claimed"
    assert store.claim("request-lease", payload_hash, lease_seconds=30)[0] == "in_progress"

    current = time.time()
    monkeypatch.setattr("app.idempotency.time.time", lambda: current + 31.0)
    store = IdempotencyStore(str(tmp_path / "idempotency.sqlite3"))
    state, _, second_token = store.claim("request-lease", payload_hash, lease_seconds=30)
    assert state == "claimed"
    assert first_token != second_token

    try:
        store.put("request-lease", payload_hash, {"stale": True}, lease_token=first_token)
    except RuntimeError as exc:
        assert "lease was lost" in str(exc)
    else:
        raise AssertionError("a stale worker must not commit after lease reclaim")
    store.put("request-lease", payload_hash, {"ok": True}, lease_token=second_token)
    state, response, _ = store.claim("request-lease", payload_hash)
    assert state == "completed"
    assert response == {"ok": True}


def test_retryable_failure_releases_owned_lease_immediately(tmp_path):
    store = IdempotencyStore(str(tmp_path / "idempotency.sqlite3"))
    payload_hash = store.input_hash({"request": "retry"})
    state, _, token = store.claim("request-retry", payload_hash, lease_seconds=300)
    assert state == "claimed"
    assert store.fail_or_release("request-retry", payload_hash, token, retryable=True)
    state, _, replacement = store.claim("request-retry", payload_hash, lease_seconds=300)
    assert state == "claimed"
    assert replacement != token


def test_permanent_failure_rejects_same_request(tmp_path):
    store = IdempotencyStore(str(tmp_path / "idempotency.sqlite3"))
    payload_hash = store.input_hash({"request": "invalid"})
    state, _, token = store.claim("request-invalid", payload_hash)
    assert state == "claimed"
    assert store.fail_or_release("request-invalid", payload_hash, token, retryable=False, error="bad contract")
    state, response, token = store.claim("request-invalid", payload_hash)
    assert state == "permanent_failed"
    assert response is None
    assert token is None
