"""Spark RAG parent-document staging job.

The job reads the Catalog-issued source, applies only the approved Catalog
schema/role contract, and writes deterministic parent rows to Iceberg.  It
does not call the AI Gateway and it does not create embeddings.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone
from typing import Any

from pyspark.sql import functions as F
from pyspark.sql import types as T

from rag_parent_contract import (
    RAG_PARENT_SCHEMA_VERSION,
    build_parent_document,
    build_staging_paths,
    canonical_json,
    validate_parent_document,
)
from spark_job_run import (
    make_spark,
    normalize_columns,
    read_source,
    required_env,
    source_contract_paths,
)


def load_manifest() -> dict:
    path = os.environ.get("ASKLAKE_RAG_PARENT_MANIFEST_FILE")
    raw = os.environ.get("ASKLAKE_RAG_PARENT_MANIFEST_JSON")
    if raw:
        value = json.loads(raw)
    elif path:
        with open(path, "r", encoding="utf-8") as handle:
            value = json.load(handle)
    else:
        raise ValueError("RAG_PARENT_MANIFEST_REQUIRED")
    if not isinstance(value, dict):
        raise ValueError("RAG_PARENT_MANIFEST_INVALID")
    return value


def callback(manifest: dict, payload: dict) -> None:
    url = str(manifest.get("callbackUrl") or "").strip()
    token = str(manifest.get("callbackToken") or "").strip()
    if not url or not token:
        return
    request = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), method="POST", headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=30):
        return


def role_columns(manifest: dict) -> tuple[list[str], list[str], list[str], list[str]]:
    roles = manifest.get("roles") or {}
    body = [normalize_column(item) for item in roles.get("body") or []]
    title = [normalize_column(item) for item in roles.get("title") or []]
    metadata = [normalize_column(item) for item in roles.get("metadata") or []]
    identifiers = [normalize_column(item) for item in roles.get("identifier") or []]
    if not body:
        raise ValueError("RAG_PARENT_BODY_COLUMNS_REQUIRED")
    return body, title, metadata, identifiers


def normalize_column(value: Any) -> str:
    text = re.sub(r"[^0-9A-Za-z_]+", "_", str(value or "").strip().lower())
    return re.sub(r"_+", "_", text).strip("_")


def parent_schema() -> T.StructType:
    return T.StructType([
        T.StructField("schema_version", T.StringType(), False),
        T.StructField("dataset_id", T.StringType(), False),
        T.StructField("source_fingerprint", T.StringType(), False),
        T.StructField("source_row_id", T.StringType(), False),
        T.StructField("row_ordinal", T.LongType(), False),
        T.StructField("parent_document_id", T.StringType(), False),
        T.StructField("title", T.StringType(), True),
        T.StructField("body", T.StringType(), False),
        T.StructField("metadata_json", T.StringType(), False),
        T.StructField("normalized_row_json", T.StringType(), False),
        T.StructField("source_columns", T.ArrayType(T.StringType(), False), False),
        T.StructField("content_hash", T.StringType(), False),
        T.StructField("embedding_input_version", T.StringType(), False),
        T.StructField("policy_fingerprint", T.StringType(), False),
        T.StructField("job_id", T.StringType(), False),
        T.StructField("staged_at", T.StringType(), False),
    ])


def parent_rows_from_local_rows(rows: list[dict], manifest: dict) -> list[dict]:
    body, title, metadata, identifiers = role_columns(manifest)
    schema_columns = [normalize_column(item.get("name") or item.get("sourceName") or item.get("targetName")) for item in manifest.get("schema") or [] if isinstance(item, dict)]
    output = []
    for ordinal, row in enumerate(rows):
        document = build_parent_document(
            dataset_id=str(manifest["datasetId"]),
            source_fingerprint=str(manifest["sourceFingerprint"]),
            row=row,
            schema_columns=schema_columns,
            body_columns=body,
            title_columns=title,
            metadata_columns=metadata,
            identifier_columns=identifiers,
            ordinal=ordinal,
            job_id=str(manifest["jobId"]),
            policy_fingerprint=str(manifest["policyFingerprint"]),
            staged_at=str(manifest.get("stagedAt") or ""),
        )
        validate_parent_document(document)
        output.append(document)
    return output


def main() -> int:
    started = time.time()
    manifest = load_manifest()
    dataset_id = str(manifest.get("datasetId") or "").strip()
    job_id = str(manifest.get("jobId") or "").strip()
    source_path = str(manifest.get("sourcePath") or "").strip()
    source_format = str(manifest.get("sourceFormat") or "").strip().lower()
    base_path = str(manifest.get("stagingBasePath") or "").strip()
    source_fingerprint = str(manifest.get("sourceFingerprint") or "").strip()
    if not all((dataset_id, job_id, source_path, source_format, base_path, source_fingerprint)):
        raise ValueError("RAG_PARENT_MANIFEST_REQUIRED_FIELDS_MISSING")
    paths = build_staging_paths(base_path=base_path, dataset_id=dataset_id, job_id=job_id)
    manifest["checkpointPath"] = paths["checkpoint"]
    schema = manifest.get("schema") or []
    source_columns = [{"sourceName": str(item.get("name"))} for item in schema if isinstance(item, dict) and item.get("name")]
    spark = make_spark(manifest.get("sourceCollection") or {}, manifest.get("icebergTarget"))
    try:
        source_df = read_source(spark, source_format, source_path, source_columns, source_collection=manifest.get("sourceCollection") or {})
        normalized_df = normalize_columns(source_df, source_columns)
        role_body, role_title, role_metadata, role_identifiers = role_columns(manifest)
        schema_names = [normalize_column(item.get("name")) for item in schema if isinstance(item, dict) and item.get("name")]
        policy_fingerprint = str(manifest.get("policyFingerprint"))

        def convert(row, ordinal):
            values = row.asDict(recursive=True)
            document = build_parent_document(
                dataset_id=dataset_id,
                source_fingerprint=source_fingerprint,
                row=values,
                schema_columns=schema_names,
                body_columns=role_body,
                title_columns=role_title,
                metadata_columns=role_metadata,
                identifier_columns=role_identifiers,
                ordinal=int(ordinal),
                job_id=job_id,
                policy_fingerprint=policy_fingerprint,
            )
            validate_parent_document(document)
            document["metadata_json"] = json.dumps(document.pop("metadata"), ensure_ascii=False, sort_keys=True, default=str)
            document["normalized_row_json"] = json.dumps(document.pop("normalized_row"), ensure_ascii=False, sort_keys=True, default=str)
            return document

        spark.sparkContext.setCheckpointDir(paths["checkpoint"])
        indexed = normalized_df.rdd.zipWithIndex().map(lambda pair: convert(pair[0], pair[1]))
        indexed.checkpoint()
        indexed.count()
        parent_df = spark.createDataFrame(indexed, schema=parent_schema())
        target = manifest.get("icebergTarget")
        if not isinstance(target, dict):
            raise ValueError("RAG_PARENT_ICEBERG_TARGET_REQUIRED")
        catalog = str(target.get("catalog") or "asklake")
        namespace = str(target.get("namespace") or "rag")
        table = str(target.get("table") or f"parents_{dataset_id}")
        table_id = ".".join(f"`{value.replace('`', '``')}`" for value in (catalog, namespace, table))
        spark.sql(f"CREATE NAMESPACE IF NOT EXISTS `{catalog}`.`{namespace}`")
        (parent_df.writeTo(table_id).using("iceberg").tableProperty("format-version", "2").createOrReplace())
        count = parent_df.count()
        result = {"status": "success", "schemaVersion": RAG_PARENT_SCHEMA_VERSION, "datasetId": dataset_id, "jobId": job_id, "sourceFingerprint": source_fingerprint, "parentCount": count, "table": f"{catalog}.{namespace}.{table}", "checkpointPath": paths["checkpoint"], "durationMs": int((time.time() - started) * 1000)}
        report_path = str(manifest.get("reportPath") or "").strip()
        if report_path:
            with open(report_path, "w", encoding="utf-8") as handle:
                json.dump(result, handle, ensure_ascii=False, indent=2)
        print(f"ASKLAKE_RAG_PARENT_RESULT={canonical_json(result)}")
        callback(manifest, {"status": "parent_staged", "parentCount": count, "parentTable": result["table"], "checkpointPath": paths["checkpoint"]})
        return 0
    except Exception as exc:
        result = {"status": "failed", "datasetId": dataset_id, "jobId": job_id, "error": str(exc), "durationMs": int((time.time() - started) * 1000)}
        try:
            callback(manifest, result)
        except Exception:
            pass
        print(f"ASKLAKE_RAG_PARENT_RESULT={canonical_json(result)}", file=sys.stderr)
        return 1
    finally:
        spark.stop()


if __name__ == "__main__":
    raise SystemExit(main())
