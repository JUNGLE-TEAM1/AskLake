"""Spark dispatcher for final Chunk -> Embedding Gateway -> OpenSearch writes."""

from __future__ import annotations

import json
import hashlib
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone
from typing import Any

from pyspark.sql import types as T

from rag_parent_contract import (
    CHUNKING_VERSION,
    EMBEDDING_INPUT_VERSION,
    FIELD_RENDERING_VERSION,
    RagJobAlreadyComplete,
    RagStageRejectedError,
    canonical_json,
    ensure_rag_callback_allows_work,
    post_rag_callback,
)
from spark_job_run import make_spark, required_env, quote_spark_identifier


def load_manifest() -> dict:
    value = json.loads(required_env("ASKLAKE_RAG_INDEX_MANIFEST_JSON"))
    if not isinstance(value, dict):
        raise ValueError("RAG_INDEX_MANIFEST_INVALID")
    return value


def callback(manifest: dict, payload: dict, *, require_continue: bool = True) -> dict[str, Any]:
    url = str(manifest.get("callbackUrl") or "").strip()
    token = str(manifest.get("callbackToken") or "").strip()
    response = post_rag_callback(
        url,
        token,
        payload,
        timeout_seconds=int(os.environ.get("ASKLAKE_RAG_CALLBACK_TIMEOUT_SECONDS", "30")),
        max_attempts=int(os.environ.get("ASKLAKE_RAG_CALLBACK_ATTEMPTS", "3")),
    )
    expected_stage = str(
        payload.get("stage")
        or {
            "embedding": "embedding",
            "indexing": "indexing",
            "validating": "validating",
        }.get(str(payload.get("status") or ""))
        or ""
    )
    return ensure_rag_callback_allows_work(response, expected_stage=expected_stage) if require_continue else response


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


def begin_embedding_stage(manifest: dict) -> int | None:
    try:
        callback(
            manifest,
            {
                "status": "embedding",
                "event": "stage_started",
                "stage": "embedding",
                "datasetId": manifest.get("datasetId"),
                "jobId": manifest.get("jobId"),
                "observedAt": datetime.now(timezone.utc).isoformat(),
            },
        )
    except RagJobAlreadyComplete as exc:
        print(
            f"ASKLAKE_RAG_INDEX_SKIPPED={canonical_json({'jobId': manifest.get('jobId'), 'reason': str(exc)})}"
        )
        return 0
    except RagStageRejectedError as exc:
        print(
            f"ASKLAKE_RAG_INDEX_REJECTED={canonical_json({'jobId': manifest.get('jobId'), 'reason': str(exc)})}",
            file=sys.stderr,
        )
        return 1
    except Exception as exc:
        print(
            f"ASKLAKE_RAG_INDEX_CALLBACK_ERROR={canonical_json({'jobId': manifest.get('jobId'), 'error': str(exc)})}",
            file=sys.stderr,
        )
        return 1
    return None


def build_partition_dispatch(
    *,
    endpoint: str,
    token: str,
    dataset_id: str,
    dataset_name: str,
    target_index: str,
    embedding_model: str | None,
    embedding_dimensions: int | None,
    metadata_types: dict[str, str],
    job_id: str,
):
    def partition_dispatch(iterator):
        batch = []
        for row in iterator:
            chunk = row.asDict(recursive=True)
            chunk["metadata"] = json.loads(chunk.pop("metadata_json") or "{}")
            chunk["metadata_display"] = json.loads(
                chunk.pop("metadata_display_json") or "{}"
            )
            chunk["title_blocks"] = json.loads(
                chunk.pop("title_blocks_json") or "[]"
            )
            chunk["body_blocks"] = json.loads(
                chunk.pop("body_blocks_json") or "[]"
            )
            chunk["source_fields"] = json.loads(
                chunk.pop("source_fields_json") or "[]"
            )
            chunk["parent_source_fields"] = json.loads(
                chunk.pop("parent_source_fields_json") or "[]"
            )
            batch.append(chunk)
            if len(batch) >= 64:
                yield post_index(
                    endpoint,
                    token,
                    dataset_id,
                    dataset_name,
                    target_index,
                    batch,
                    embedding_model=embedding_model,
                    embedding_dimensions=embedding_dimensions,
                    metadata_types=metadata_types,
                    job_id=job_id,
                )
                batch = []
        if batch:
            yield post_index(
                endpoint,
                token,
                dataset_id,
                dataset_name,
                target_index,
                batch,
                embedding_model=embedding_model,
                embedding_dimensions=embedding_dimensions,
                metadata_types=metadata_types,
                job_id=job_id,
            )

    return partition_dispatch


def main() -> int:
    started = time.time()
    manifest = load_manifest()
    chunk_table = str(manifest.get("chunkTable") or "")
    if len(chunk_table.split(".")) != 3:
        raise ValueError("RAG_INDEX_CHUNK_TABLE_REQUIRED")
    early_exit = begin_embedding_stage(manifest)
    if early_exit is not None:
        return early_exit
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

        partition_dispatch = build_partition_dispatch(
            endpoint=endpoint,
            token=token,
            dataset_id=dataset_id,
            dataset_name=dataset_name,
            target_index=target_index,
            embedding_model=embedding_model,
            embedding_dimensions=embedding_dimensions,
            metadata_types=metadata_types,
            job_id=str(manifest.get("jobId") or ""),
        )

        document_count = chunks.count()
        parent_count = int(chunks.select("parent_document_id").distinct().count())
        callback(
            manifest,
            {
                "status": "indexing",
                "event": "stage_started",
                "stage": "indexing",
                "datasetId": dataset_id,
                "jobId": manifest.get("jobId"),
                "documentCount": document_count,
                "chunkCount": document_count,
                "parentCount": parent_count,
                "observedAt": datetime.now(timezone.utc).isoformat(),
            },
        )
        results = chunks.rdd.mapPartitions(partition_dispatch).collect()
        indexed_count = sum(int(item.get("indexedCount") or 0) for item in results)
        skipped_existing_count = sum(int(item.get("skippedExistingCount") or 0) for item in results)
        if indexed_count + skipped_existing_count != document_count:
            raise RuntimeError("Embedding Worker result counts do not cover the staged chunk table")
        dimensions_seen = {
            int(item["dimensions"])
            for item in results
            if item.get("dimensions") is not None
        }
        if document_count and (not dimensions_seen or 0 in dimensions_seen or len(dimensions_seen) != 1):
            raise RuntimeError("Embedding dimensions are missing or inconsistent across Spark index partitions")
        dimensions = next(iter(dimensions_seen), None)
        embedding_providers = {
            str(item.get("embeddingProvider"))
            for item in results
            if str(item.get("embeddingProvider") or "").strip()
        }
        if document_count and len(embedding_providers) != 1:
            raise RuntimeError("Embedding provider is missing or inconsistent across Spark index partitions")
        embedding_provider = next(iter(embedding_providers), None)
        embedding_models = {
            str(item.get("embeddingModel"))
            for item in results
            if str(item.get("embeddingModel") or "").strip()
        }
        if document_count and (len(embedding_models) != 1 or embedding_model not in embedding_models):
            raise RuntimeError("Embedding model is missing or inconsistent across Spark index partitions")
        result = {"status": "validating", "datasetId": dataset_id, "jobId": manifest.get("jobId"), "indexedCount": document_count, "embeddedCount": indexed_count, "skippedExistingCount": skipped_existing_count, "documentCount": document_count, "chunkCount": document_count, "parentCount": parent_count, "dimensions": dimensions, "embeddingProvider": embedding_provider, "embeddingModel": manifest.get("embeddingModel"), "activeIndex": target_index, "chunkingVersion": CHUNKING_VERSION, "embeddingInputVersion": EMBEDDING_INPUT_VERSION, "fieldRenderingVersion": FIELD_RENDERING_VERSION, "durationMs": int((time.time() - started) * 1000)}
        print(f"ASKLAKE_RAG_INDEX_RESULT={canonical_json(result)}")
        callback(manifest, result)
        chunks.unpersist()
        return 0
    except RagJobAlreadyComplete as exc:
        print(f"ASKLAKE_RAG_INDEX_SKIPPED={canonical_json({'jobId': manifest.get('jobId'), 'reason': str(exc)})}")
        return 0
    except Exception as exc:
        result = {"status": "failed", "datasetId": manifest.get("datasetId"), "jobId": manifest.get("jobId"), "error": str(exc), "durationMs": int((time.time() - started) * 1000)}
        try:
            callback(manifest, result, require_continue=False)
        except Exception as callback_exc:
            print(
                f"ASKLAKE_RAG_INDEX_FAILURE_CALLBACK_ERROR={canonical_json({'jobId': manifest.get('jobId'), 'error': str(callback_exc)})}",
                file=sys.stderr,
            )
        print(f"ASKLAKE_RAG_INDEX_RESULT={canonical_json(result)}", file=sys.stderr)
        return 1
    finally:
        spark.stop()


if __name__ == "__main__":
    raise SystemExit(main())
