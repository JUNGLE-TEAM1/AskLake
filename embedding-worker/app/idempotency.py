"""Small durable request-result store for Spark task retries.

Spark may retry a partition after the HTTP call already reached the worker.
Persisting successful responses by an input hash prevents a retry from
re-running sentence segmentation, provider embeddings, or OpenSearch bulk
writes. The path must be backed by a persistent volume in production.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
import time
from typing import Any
from uuid import uuid4


class IdempotencyStore:
    def __init__(self, path: str | None = None) -> None:
        self.path = path or os.environ.get("RAG_IDEMPOTENCY_STORE_PATH", "/var/lib/asklake/embedding-worker/idempotency.sqlite3")
        directory = os.path.dirname(self.path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        self._lock = threading.Lock()
        with self._connect() as connection:
            connection.execute("CREATE TABLE IF NOT EXISTS rag_idempotency (request_key TEXT PRIMARY KEY, input_hash TEXT NOT NULL, response_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'completed', lease_until REAL NOT NULL DEFAULT 0, lease_token TEXT NOT NULL DEFAULT '')")
            columns = {str(row[1]) for row in connection.execute("PRAGMA table_info(rag_idempotency)").fetchall()}
            if "state" not in columns:
                connection.execute("ALTER TABLE rag_idempotency ADD COLUMN state TEXT NOT NULL DEFAULT 'completed'")
            if "lease_until" not in columns:
                connection.execute("ALTER TABLE rag_idempotency ADD COLUMN lease_until REAL NOT NULL DEFAULT 0")
            if "lease_token" not in columns:
                connection.execute("ALTER TABLE rag_idempotency ADD COLUMN lease_token TEXT NOT NULL DEFAULT ''")

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.execute("PRAGMA journal_mode=WAL")
        return connection

    @staticmethod
    def input_hash(payload: Any) -> str:
        encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    def get(self, request_key: str, input_hash: str) -> dict[str, Any] | None:
        with self._lock, self._connect() as connection:
            row = connection.execute("SELECT input_hash, response_json, state FROM rag_idempotency WHERE request_key = ?", (request_key,)).fetchone()
        if row is None:
            return None
        if row[0] != input_hash:
            raise ValueError("Idempotency key was reused for a different request payload")
        if row[2] != "completed":
            return None
        value = json.loads(row[1])
        return value if isinstance(value, dict) else None

    def claim(self, request_key: str, input_hash: str, *, lease_seconds: float = 300.0) -> tuple[str, dict[str, Any] | None, str | None]:
        """Atomically claim work or report a completed/in-progress request.

        A lease prevents concurrent Spark retries from running the same costly
        embedding/LLM operation at the same time. Expired leases are safely
        reclaimed, allowing a crashed worker to be retried.
        """

        now = time.time()
        lease_until = now + max(1.0, float(lease_seconds))
        lease_token = uuid4().hex
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT input_hash, response_json, state, lease_until, lease_token FROM rag_idempotency WHERE request_key = ?", (request_key,)).fetchone()
            if row is not None and row[0] != input_hash:
                connection.rollback()
                raise ValueError("Idempotency key was reused for a different request payload")
            if row is None:
                connection.execute("INSERT INTO rag_idempotency(request_key, input_hash, response_json, state, lease_until, lease_token) VALUES (?, ?, ?, 'processing', ?, ?)", (request_key, input_hash, "{}", lease_until, lease_token))
                connection.commit()
                return "claimed", None, lease_token
            if row[2] == "completed":
                connection.commit()
                value = json.loads(row[1])
                return "completed", value if isinstance(value, dict) else None, None
            if row[2] == "permanent_failed":
                connection.commit()
                return "permanent_failed", None, None
            if float(row[3] or 0) > now:
                connection.commit()
                return "in_progress", None, None
            connection.execute("UPDATE rag_idempotency SET state = 'processing', lease_until = ?, lease_token = ?, response_json = '{}' WHERE request_key = ?", (lease_until, lease_token, request_key))
            connection.commit()
            return "claimed", None, lease_token

    def put(self, request_key: str, input_hash: str, response: dict[str, Any], *, lease_token: str | None = None) -> None:
        encoded = json.dumps(response, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
        with self._lock, self._connect() as connection:
            if lease_token:
                updated = connection.execute("UPDATE rag_idempotency SET response_json = ?, state = 'completed', lease_until = 0, lease_token = '' WHERE request_key = ? AND input_hash = ? AND state = 'processing' AND lease_token = ?", (encoded, request_key, input_hash, lease_token)).rowcount
            else:
                updated = connection.execute("UPDATE rag_idempotency SET response_json = ?, state = 'completed', lease_until = 0, lease_token = '' WHERE request_key = ? AND input_hash = ?", (encoded, request_key, input_hash)).rowcount
            if not updated:
                if lease_token:
                    raise RuntimeError("Idempotency lease was lost before the response could be committed")
                connection.execute("INSERT INTO rag_idempotency(request_key, input_hash, response_json, state, lease_until, lease_token) VALUES (?, ?, ?, 'completed', 0, '')", (request_key, input_hash, encoded))
            connection.commit()

    def fail_or_release(self, request_key: str, input_hash: str, lease_token: str, *, retryable: bool, error: str = "") -> bool:
        """Release a failed owned lease or permanently reject the request.

        The lease token prevents a late worker from releasing a newer retry's
        lease. Retryable failures delete the processing row so the next Spark
        retry can claim immediately; permanent failures remain terminal.
        """
        with self._lock, self._connect() as connection:
            if retryable:
                changed = connection.execute("DELETE FROM rag_idempotency WHERE request_key = ? AND input_hash = ? AND state = 'processing' AND lease_token = ?", (request_key, input_hash, lease_token)).rowcount
            else:
                changed = connection.execute("UPDATE rag_idempotency SET state = 'permanent_failed', response_json = ?, lease_until = 0, lease_token = '' WHERE request_key = ? AND input_hash = ? AND state = 'processing' AND lease_token = ?", (json.dumps({"error": error[:1_000]}, ensure_ascii=False, separators=(",", ":")), request_key, input_hash, lease_token)).rowcount
            connection.commit()
            return bool(changed)
