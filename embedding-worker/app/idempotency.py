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
from typing import Any


class IdempotencyStore:
    def __init__(self, path: str | None = None) -> None:
        self.path = path or os.environ.get("RAG_IDEMPOTENCY_STORE_PATH", "/var/lib/asklake/embedding-worker/idempotency.sqlite3")
        directory = os.path.dirname(self.path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        self._lock = threading.Lock()
        with self._connect() as connection:
            connection.execute("CREATE TABLE IF NOT EXISTS rag_idempotency (request_key TEXT PRIMARY KEY, input_hash TEXT NOT NULL, response_json TEXT NOT NULL)")

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
            row = connection.execute("SELECT input_hash, response_json FROM rag_idempotency WHERE request_key = ?", (request_key,)).fetchone()
        if row is None:
            return None
        if row[0] != input_hash:
            raise ValueError("Idempotency key was reused for a different request payload")
        value = json.loads(row[1])
        return value if isinstance(value, dict) else None

    def put(self, request_key: str, input_hash: str, response: dict[str, Any]) -> None:
        encoded = json.dumps(response, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
        with self._lock, self._connect() as connection:
            connection.execute("INSERT OR REPLACE INTO rag_idempotency(request_key, input_hash, response_json) VALUES (?, ?, ?)", (request_key, input_hash, encoded))
            connection.commit()
