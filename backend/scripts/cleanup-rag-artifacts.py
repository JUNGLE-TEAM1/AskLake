"""Retention job for retired RAG indexes and job-scoped Iceberg tables.

Dry-run is the default. Production runs this script with ``--apply`` from a
durable scheduler after the active alias is known to be healthy.
"""

from __future__ import annotations

import argparse
import time
from datetime import datetime, timedelta, timezone
import re
import httpx

from sqlalchemy import select

from app.clients.opensearch_client import OpenSearchClient
from app.core.config import settings
from app.core.database import SessionLocal
from app.models.semantic_rag import RagIndexManifestModel
from app.services.trino_client import TrinoClient


def _safe_table(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_`.-]+", value):
        raise ValueError(f"Unsafe Iceberg table identifier: {value}")
    return value


def cleanup_once(*, apply: bool, retention_days: int, keep_previous: int) -> dict[str, object]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    report: dict[str, object] = {
        "cutoff": cutoff.isoformat(),
        "candidates": [],
        "deletedIndexes": [],
        "droppedTables": [],
        "pendingIndexes": [],
        "pendingTables": [],
    }
    with SessionLocal() as db:
        manifests = db.scalars(select(RagIndexManifestModel).where(RagIndexManifestModel.status == "retired").order_by(RagIndexManifestModel.dataset_id.asc(), RagIndexManifestModel.activated_at.desc())).all()
        retained_by_dataset: dict[str, int] = {}
        client = OpenSearchClient(settings) if settings.opensearch_base_url else None
        trino = TrinoClient(settings) if settings.trino_enabled else None
        for manifest in manifests:
            retained_by_dataset.setdefault(manifest.dataset_id, 0)
            if retained_by_dataset[manifest.dataset_id] < keep_previous or not manifest.retired_at or manifest.retired_at >= cutoff:
                retained_by_dataset[manifest.dataset_id] += 1
                continue
            candidate = {"datasetId": manifest.dataset_id, "index": manifest.index_name, "parentTable": manifest.parent_table, "chunkTable": manifest.chunk_table, "checkpointPath": manifest.checkpoint_path}
            report["candidates"].append(candidate)  # type: ignore[union-attr]
            if not apply:
                continue
            if manifest.index_name:
                if client is None:
                    report["pendingIndexes"].append(candidate)  # type: ignore[union-attr]
                    continue
                serving_indexes = client.alias_indices(manifest.alias_name)
                if manifest.index_name in serving_indexes:
                    report["pendingIndexes"].append(candidate)  # type: ignore[union-attr]
                    continue
                try:
                    client.delete_index(manifest.index_name)
                except httpx.HTTPStatusError as exc:
                    if exc.response.status_code != 404:
                        raise
                report["deletedIndexes"].append(manifest.index_name)  # type: ignore[union-attr]
            if trino:
                for table in (manifest.parent_table, manifest.chunk_table):
                    if table:
                        trino.execute_ddl(f"DROP TABLE IF EXISTS {_safe_table(table)}")
                        report["droppedTables"].append(table)  # type: ignore[union-attr]
            elif manifest.parent_table or manifest.chunk_table:
                # Never mark a manifest deleted while its Iceberg artifacts are
                # still present.  The next scheduled run can retry after Trino
                # is configured, without losing the cleanup intent.
                report["pendingTables"].append(candidate)  # type: ignore[union-attr]
                continue
            manifest.status = "deleted"
            manifest.retired_at = datetime.now(timezone.utc)
        if apply:
            db.commit()
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--retention-days", type=int, default=settings.rag_artifact_retention_days)
    parser.add_argument("--keep-previous", type=int, default=settings.rag_artifact_keep_previous_indexes)
    parser.add_argument("--loop", action="store_true")
    parser.add_argument("--interval-seconds", type=int, default=86_400)
    args = parser.parse_args()
    while True:
        print(cleanup_once(apply=args.apply, retention_days=args.retention_days, keep_previous=args.keep_previous), flush=True)
        if not args.loop:
            return 0
        time.sleep(max(60, args.interval_seconds))


if __name__ == "__main__":
    raise SystemExit(main())
