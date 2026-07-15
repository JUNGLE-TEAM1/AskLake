"""Spark dispatcher for final Chunk -> Embedding Gateway -> OpenSearch writes."""

from __future__ import annotations

import json
import hashlib
import os
import sys
import time
import urllib.request

from pyspark.sql import types as T

from rag_parent_contract import canonical_json
from spark_job_run import make_spark, required_env, quote_spark_identifier


def load_manifest() -> dict:
    value = json.loads(required_env("ASKLAKE_RAG_INDEX_MANIFEST_JSON"))
    if not isinstance(value, dict):
        raise ValueError("RAG_INDEX_MANIFEST_INVALID")
    return value


def callback(manifest: dict, payload: dict) -> None:
    url = str(manifest.get("callbackUrl") or "").strip()
    token = str(manifest.get("callbackToken") or "").strip()
    if not url or not token:
        return
    request = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), method="POST", headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=30):
        return


def post_index(endpoint: str, token: str, dataset_id: str, dataset_name: str, target_index: str, chunks: list[dict], *, embedding_model: str | None, embedding_dimensions: int | None, metadata_types: dict[str, str] | None = None, job_id: str | None = None) -> dict:
    payload = {"dataset_id": dataset_id, "dataset_name": dataset_name, "body_columns": ["text"], "target_index": target_index, "embedding_model": embedding_model, "embedding_dimensions": embedding_dimensions, "metadata_types": metadata_types or {}, "chunks": chunks}
    digest = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")).hexdigest()
    payload["idempotency_key"] = f"rag-index:{job_id}:{digest}"
    request = urllib.request.Request(endpoint, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), method="POST", headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=int(os.environ.get("ASKLAKE_RAG_WORKER_HTTP_TIMEOUT_SECONDS", "600"))) as response:
        payload = json.loads(response.read().decode("utf-8") or "{}")
    if not isinstance(payload, dict) or payload.get("indexedCount") is None:
        raise RuntimeError("Embedding Worker returned an invalid indexing result")
    return payload


def main() -> int:
    started = time.time()
    manifest = load_manifest()
    chunk_table = str(manifest.get("chunkTable") or "")
    if len(chunk_table.split(".")) != 3:
        raise ValueError("RAG_INDEX_CHUNK_TABLE_REQUIRED")
    spark = make_spark({}, {"catalog": chunk_table.split(".")[0], "namespace": chunk_table.split(".")[1], "table": chunk_table.split(".")[2], "writeMode": "replace", "tableUri": f"iceberg://{chunk_table}"}, disable_speculation=True)
    try:
        chunks = spark.table(".".join(quote_spark_identifier(item) for item in chunk_table.split("."))).persist()
        endpoint = f"{str(manifest.get('workerUrl') or '').rstrip('/')}/v1/index"
        token = str(manifest.get("workerToken") or "")
        dataset_id = str(manifest.get("datasetId") or "")
        dataset_name = str(manifest.get("datasetName") or dataset_id)
        target_index = str(manifest.get("targetIndex") or "")
        embedding_model = str(manifest.get("embeddingModel") or "") or None
        embedding_dimensions = int(manifest["embeddingDimensions"]) if manifest.get("embeddingDimensions") else None
        metadata_types = manifest.get("metadataTypes") if isinstance(manifest.get("metadataTypes"), dict) else {}

        def partition_dispatch(iterator):
            batch = []
            for row in iterator:
                chunk = row.asDict(recursive=True)
                chunk["metadata"] = json.loads(chunk.pop("metadata_json") or "{}")
                chunk["metadata_display"] = json.loads(chunk.pop("metadata_display_json") or "{}")
                chunk["title_blocks"] = json.loads(chunk.pop("title_blocks_json") or "[]")
                chunk["body_blocks"] = json.loads(chunk.pop("body_blocks_json") or "[]")
                chunk["source_fields"] = json.loads(chunk.pop("source_fields_json") or "[]")
                batch.append(chunk)
                if len(batch) >= 64:
                    yield post_index(endpoint, token, dataset_id, dataset_name, target_index, batch, embedding_model=embedding_model, embedding_dimensions=embedding_dimensions, metadata_types=metadata_types, job_id=str(manifest.get("jobId") or ""))
                    batch = []
            if batch:
                yield post_index(endpoint, token, dataset_id, dataset_name, target_index, batch, embedding_model=embedding_model, embedding_dimensions=embedding_dimensions, metadata_types=metadata_types, job_id=str(manifest.get("jobId") or ""))

        document_count = chunks.count()
        parent_count = int(chunks.select("parent_document_id").distinct().count())
        results = chunks.rdd.mapPartitions(partition_dispatch).collect()
        indexed_count = sum(int(item.get("indexedCount") or 0) for item in results)
        skipped_existing_count = sum(int(item.get("skippedExistingCount") or 0) for item in results)
        dimensions = next((int(item["dimensions"]) for item in results if item.get("dimensions") is not None), None)
        result = {"status": "validating", "datasetId": dataset_id, "jobId": manifest.get("jobId"), "indexedCount": document_count, "embeddedCount": indexed_count, "skippedExistingCount": skipped_existing_count, "documentCount": document_count, "chunkCount": document_count, "parentCount": parent_count, "dimensions": dimensions, "embeddingModel": manifest.get("embeddingModel"), "activeIndex": target_index, "chunkingVersion": "rag-chunk-v3", "embeddingInputVersion": "title_body_fields_v2", "fieldRenderingVersion": "field_blocks_v1", "durationMs": int((time.time() - started) * 1000)}
        print(f"ASKLAKE_RAG_INDEX_RESULT={canonical_json(result)}")
        callback(manifest, result)
        chunks.unpersist()
        return 0
    except Exception as exc:
        result = {"status": "failed", "datasetId": manifest.get("datasetId"), "jobId": manifest.get("jobId"), "error": str(exc), "durationMs": int((time.time() - started) * 1000)}
        try:
            callback(manifest, result)
        except Exception:
            pass
        print(f"ASKLAKE_RAG_INDEX_RESULT={canonical_json(result)}", file=sys.stderr)
        return 1
    finally:
        spark.stop()


if __name__ == "__main__":
    raise SystemExit(main())
