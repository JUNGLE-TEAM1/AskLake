"""Distributed RAG chunk staging job.

Spark reads the already-normalized parent Iceberg table and sends bounded
batches to the Chunker HTTP stage.  Spark never calls an LLM or an embedding
provider directly.  Returned child chunks are committed to a job-scoped
Iceberg table only after the partition transformation succeeds.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.request

from pyspark.sql import types as T

from rag_parent_contract import canonical_json
from spark_job_run import make_spark, required_env, quote_spark_identifier


def load_manifest() -> dict:
    raw = required_env("ASKLAKE_RAG_CHUNK_MANIFEST_JSON")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("RAG_CHUNK_MANIFEST_INVALID")
    return value


def callback(manifest: dict, payload: dict) -> None:
    url = str(manifest.get("callbackUrl") or "").strip()
    token = str(manifest.get("callbackToken") or "").strip()
    if not url or not token:
        return
    request = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), method="POST", headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=30):
        return


def chunk_schema() -> T.StructType:
    return T.StructType([
        T.StructField("schema_version", T.StringType(), False),
        T.StructField("chunk_document_id", T.StringType(), False),
        T.StructField("parent_document_id", T.StringType(), False),
        T.StructField("dataset_id", T.StringType(), False),
        T.StructField("source_fingerprint", T.StringType(), False),
        T.StructField("source_row_id", T.StringType(), False),
        T.StructField("chunk_index", T.IntegerType(), False),
        T.StructField("start_sentence", T.IntegerType(), False),
        T.StructField("end_sentence", T.IntegerType(), False),
        T.StructField("text", T.StringType(), False),
        T.StructField("embedding_text", T.StringType(), False),
        T.StructField("metadata_json", T.StringType(), False),
        T.StructField("source_columns", T.ArrayType(T.StringType(), False), False),
        T.StructField("content_hash", T.StringType(), False),
        T.StructField("chunking_strategy", T.StringType(), False),
        T.StructField("chunking_version", T.StringType(), False),
        T.StructField("token_count", T.IntegerType(), False),
        T.StructField("embedding_status", T.StringType(), False),
    ])


def post_chunks(endpoint: str, token: str, parents: list[dict], target: dict) -> list[dict]:
    request = urllib.request.Request(endpoint, data=json.dumps({"parents": parents, "target_tokens": target.get("targetTokens", 800), "overlap_tokens": target.get("overlapTokens", 400), "max_tokens": target.get("maxTokens", 1200), "embedding_model": target.get("embeddingModel")}).encode("utf-8"), method="POST", headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=int(os.environ.get("ASKLAKE_RAG_CHUNK_HTTP_TIMEOUT_SECONDS", "300"))) as response:
        payload = json.loads(response.read().decode("utf-8") or "{}")
    chunks = payload.get("chunks") if isinstance(payload, dict) else None
    if not isinstance(chunks, list):
        raise RuntimeError("RAG Chunker returned an invalid chunk list")
    return chunks


def serialize_chunks(chunks: list[dict]):
    """Convert the HTTP contract into the physical Iceberg staging schema."""
    for chunk in chunks:
        if not isinstance(chunk, dict):
            raise RuntimeError("RAG Chunker returned a non-object chunk")
        metadata = chunk.pop("metadata", {})
        if not isinstance(metadata, dict):
            raise RuntimeError("RAG Chunker returned invalid metadata")
        chunk["metadata_json"] = json.dumps(metadata, ensure_ascii=False, sort_keys=True, default=str)
        yield chunk


def main() -> int:
    started = time.time()
    manifest = load_manifest()
    source_table = str(manifest.get("parentTable") or "")
    target_table = str(manifest.get("chunkTable") or "")
    if len(source_table.split(".")) != 3 or len(target_table.split(".")) != 3:
        raise ValueError("RAG_CHUNK_TABLE_IDENTIFIERS_REQUIRED")
    spark = make_spark(manifest.get("sourceCollection") or {}, {"catalog": target_table.split(".")[0], "namespace": target_table.split(".")[1], "table": target_table.split(".")[2], "writeMode": "replace", "tableUri": f"iceberg://{target_table}"})
    try:
        parents = spark.table(".".join(quote_spark_identifier(item) for item in source_table.split(".")))
        endpoint = f"{str(manifest.get('chunkerUrl') or '').rstrip('/')}/v1/chunk"
        token = str(manifest.get("chunkerToken") or "")
        target = {"targetTokens": int(manifest.get("chunkTargetTokens") or 800), "overlapTokens": int(manifest.get("chunkOverlapTokens") or 400), "maxTokens": int(manifest.get("chunkMaxTokens") or 1200), "embeddingModel": manifest.get("embeddingModel")}

        def partition_chunks(iterator):
            batch = []
            for row in iterator:
                parent = row.asDict(recursive=True)
                parent["metadata"] = json.loads(parent.pop("metadata_json") or "{}")
                parent.pop("normalized_row_json", None)
                batch.append(parent)
                if len(batch) >= 64:
                    yield from serialize_chunks(post_chunks(endpoint, token, batch, target))
                    batch = []
            if batch:
                yield from serialize_chunks(post_chunks(endpoint, token, batch, target))

        chunks = parents.rdd.mapPartitions(partition_chunks)
        chunk_df = spark.createDataFrame(chunks, schema=chunk_schema()).persist()
        count = chunk_df.count()
        chunk_df.writeTo(".".join(quote_spark_identifier(item) for item in target_table.split("."))).using("iceberg").tableProperty("format-version", "2").createOrReplace()
        result = {"status": "chunked", "datasetId": manifest.get("datasetId"), "jobId": manifest.get("jobId"), "parentCount": parents.count(), "chunkCount": count, "chunkTable": target_table, "chunkingVersion": "rag-chunk-v2", "checkpointPath": manifest.get("checkpointPath"), "durationMs": int((time.time() - started) * 1000)}
        chunk_df.unpersist()
        print(f"ASKLAKE_RAG_CHUNK_RESULT={canonical_json(result)}")
        callback(manifest, result)
        return 0
    except Exception as exc:
        result = {"status": "failed", "datasetId": manifest.get("datasetId"), "jobId": manifest.get("jobId"), "error": str(exc), "durationMs": int((time.time() - started) * 1000)}
        try:
            callback(manifest, result)
        except Exception:
            pass
        print(f"ASKLAKE_RAG_CHUNK_RESULT={canonical_json(result)}", file=sys.stderr)
        return 1
    finally:
        spark.stop()


if __name__ == "__main__":
    raise SystemExit(main())
