"""Catalog-issued source contracts for Semantic RAG indexing."""

from datetime import UTC, datetime, timedelta
import hashlib
import json
from typing import Any

from app.core.config import settings


def rag_source_manifest_from_spark_result(
    *,
    result: dict[str, Any],
    dataset_id: str,
    schema_json: list[list[str]],
) -> dict[str, Any] | None:
    """Issue the immutable Catalog source contract consumed by the RAG DAG."""

    storage_location = str(
        result.get("warehouseLocation")
        or result.get("materializationOutputPath")
        or result.get("outputPath")
        or ""
    ).strip()
    if not storage_location or storage_location == "-":
        return None

    query_engine_table = result.get("queryEngineTable")
    query_engine_available = (
        result.get("queryEngineVerified") is True
        and isinstance(query_engine_table, dict)
        and all(
            str(query_engine_table.get(key) or "").strip()
            for key in ("catalog", "schema", "table", "format")
        )
        and str(query_engine_table.get("format") or "").strip().casefold() == "iceberg"
    )
    snapshot_id = ""
    if query_engine_available:
        iceberg_commit = result.get("icebergCommit")
        snapshot_id = (
            str(iceberg_commit.get("snapshotId") or "").strip()
            if isinstance(iceberg_commit, dict)
            else ""
        )
        if not snapshot_id:
            return None
        catalog = str(query_engine_table["catalog"]).strip()
        namespace = str(query_engine_table["schema"]).strip()
        table = str(query_engine_table["table"]).strip()
        spark_catalog = str(settings.asklake_spark_iceberg_catalog_name or catalog).strip()
        spark_path = f"iceberg:{spark_catalog}.{namespace}.{table}"
        source_format = "iceberg"
    else:
        spark_path = storage_location
        source_format = "parquet"

    run_id = str(result.get("runId") or "").strip()
    fingerprint_payload = {
        "datasetId": dataset_id,
        "format": source_format,
        "runId": run_id,
        "schema": schema_json,
        "snapshotId": snapshot_id,
        "sparkPath": spark_path,
        "storageLocation": storage_location,
    }
    fingerprint = hashlib.sha256(
        json.dumps(
            fingerprint_payload,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()
    source_collection = result.get("sourceCollection")
    return {
        "datasetId": dataset_id,
        "expiresAt": (datetime.now(UTC) + timedelta(hours=1)).isoformat(),
        "fingerprint": fingerprint,
        "format": source_format,
        **({"icebergSnapshotId": snapshot_id} if snapshot_id else {}),
        "manifestVersion": 1,
        "readUrl": storage_location,
        "runId": run_id or None,
        "sourceCollection": source_collection if isinstance(source_collection, dict) else {},
        "sparkPath": spark_path,
    }
