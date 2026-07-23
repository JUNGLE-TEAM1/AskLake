#!/usr/bin/env python3
"""Verify live Trino nodes and a non-empty Iceberg read without exposing identities."""

from __future__ import annotations

import hashlib
import json
import sys

from app.core.config import settings
from app.services.trino_client import TrinoClient


def fail(message: str) -> None:
    raise SystemExit(message)


def retry(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(75)


def integer_stat(raw_stats: dict[str, object], *keys: str) -> int:
    values: list[int] = []
    for key in keys:
        value = raw_stats.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)) and value >= 0:
            values.append(int(value))
    return max(values, default=0)


def consume_query(client: TrinoClient, query: str, *, page_limit: int = 100) -> tuple[list[list[object]], str, int]:
    page = client.submit(query, timeout_seconds=30)
    rows: list[list[object]] = list(page.rows)
    query_id = page.query_id
    processed_rows = integer_stat(
        page.raw_stats,
        "processedRows",
        "processedInputPositions",
        "physicalInputPositions",
    )
    for _ in range(page_limit):
        if page.error is not None:
            fail("Trino query failed")
        if not page.next_uri:
            break
        page = client.fetch(page.next_uri, timeout_seconds=30)
        rows.extend(page.rows)
        processed_rows = max(
            processed_rows,
            integer_stat(
                page.raw_stats,
                "processedRows",
                "processedInputPositions",
                "physicalInputPositions",
            ),
        )
    else:
        fail("Trino query exceeded the page limit")
    if page.error is not None:
        fail("Trino query failed")
    return rows, query_id, processed_rows


def quote_identifier(value: object) -> str:
    text = str(value)
    return '"' + text.replace('"', '""') + '"'


def verify_non_empty_iceberg_read(client: TrinoClient) -> dict[str, object]:
    tables, _, _ = consume_query(
        client,
        """
        SELECT table_schema, table_name
        FROM iceberg.information_schema.tables
        WHERE table_schema <> 'information_schema'
          AND table_type = 'BASE TABLE'
        ORDER BY table_schema, table_name
        LIMIT 100
        """,
    )
    for row in tables:
        if len(row) != 2 or row[0] is None or row[1] is None:
            continue
        target = f'iceberg.{quote_identifier(row[0])}.{quote_identifier(row[1])}'
        try:
            rows, query_id, processed_rows = consume_query(client, f"SELECT * FROM {target} LIMIT 1")
        except Exception:
            continue
        if not rows:
            continue
        if processed_rows < 1:
            fail("non-empty Iceberg query did not report processed input")
        return {
            "catalog": "iceberg",
            "nonEmptyInput": True,
            "processedRows": processed_rows,
            "queryIdHash": "sha256:" + hashlib.sha256(query_id.encode("utf-8")).hexdigest(),
        }
    fail("no readable non-empty Iceberg table is available for the deployment gate")


if len(sys.argv) != 2:
    fail("usage: verify_eks_trino_active_workers.py <expected-worker-count>")

try:
    expected_workers = int(sys.argv[1])
except ValueError:
    fail("expected worker count must be an integer")

if expected_workers < 0 or expected_workers > 5:
    fail("expected worker count must be between 0 and 5")
if not settings.trino_materializer_username or not settings.trino_materializer_password:
    fail("materializer credentials are unavailable")

client = TrinoClient(
    username=settings.trino_materializer_username,
    password=settings.trino_materializer_password,
)
if expected_workers == 0:
    query_evidence = verify_non_empty_iceberg_read(client)
    print(
        json.dumps(
            {
                "contract": "eks-trino-single-iceberg-query-v1",
                "query": query_evidence,
                "status": "passed",
            },
            separators=(",", ":"),
        )
    )
    raise SystemExit(0)

rows, _, _ = consume_query(
    client,
    """
    SELECT
      count_if(coordinator),
      count_if(NOT coordinator AND lower(state) = 'active')
    FROM system.runtime.nodes
    """,
)
if len(rows) != 1 or len(rows[0]) != 2:
    retry("Trino node query is not ready")

coordinator_count = int(rows[0][0])
active_worker_count = int(rows[0][1])
if coordinator_count != 1:
    retry("Trino coordinator count is not ready")
if active_worker_count != expected_workers:
    retry("active Trino worker count is not ready")

query_evidence = verify_non_empty_iceberg_read(client)

print(
    json.dumps(
        {
            "contract": "eks-trino-active-workers-and-iceberg-v1",
            "coordinatorCount": coordinator_count,
            "activeWorkerCount": active_worker_count,
            "expectedWorkerCount": expected_workers,
            "query": query_evidence,
            "status": "passed",
        },
        separators=(",", ":"),
    )
)
