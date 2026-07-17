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
from datetime import datetime, timezone
from typing import Any

from pyspark.sql import functions as F
from pyspark.sql import types as T

from rag_parent_contract import (
    FIELD_RENDERING_VERSION,
    RAG_PARENT_SCHEMA_VERSION,
    RagJobAlreadyComplete,
    RagStageRejectedError,
    build_parent_document,
    build_staging_paths,
    canonical_json,
    ensure_rag_callback_allows_work,
    failed_row_report,
    normalized_row,
    parent_document_id,
    post_rag_callback,
    sha256_hex,
    source_row_id,
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
    expected_stage = str(payload.get("stage") or {"parent_staged": "staging"}.get(str(payload.get("status") or "")) or "")
    return ensure_rag_callback_allows_work(response, expected_stage=expected_stage) if require_continue else response


def role_columns(manifest: dict) -> tuple[list[str], list[str], list[str], list[str]]:
    roles = manifest.get("roles") or {}
    mapping = manifest.get("physicalColumnMapping") if isinstance(manifest.get("physicalColumnMapping"), dict) else {}
    body = [str(mapping.get(str(item)) or normalize_column(item)) for item in roles.get("body") or []]
    title = [str(mapping.get(str(item)) or normalize_column(item)) for item in roles.get("title") or []]
    metadata = [str(mapping.get(str(item)) or normalize_column(item)) for item in roles.get("metadata") or []]
    identifiers = [str(mapping.get(str(item)) or normalize_column(item)) for item in roles.get("identifier") or []]
    if not body:
        raise ValueError("RAG_PARENT_BODY_COLUMNS_REQUIRED")
    return body, title, metadata, identifiers


def role_field_specs(manifest: dict, role: str) -> list[dict[str, str]]:
    roles = manifest.get("roles") or {}
    mapping = manifest.get("physicalColumnMapping") if isinstance(manifest.get("physicalColumnMapping"), dict) else {}
    schema_types = {str(item.get("name")): str(item.get("dataType") or item.get("data_type") or "") for item in manifest.get("schema") or [] if isinstance(item, dict) and item.get("name")}
    return [{"logicalField": str(logical), "physicalField": str(mapping.get(str(logical)) or normalize_column(logical)), "dataType": schema_types.get(str(logical), "")} for logical in roles.get(role) or []]


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
        T.StructField("title_blocks_json", T.StringType(), False),
        T.StructField("body_blocks_json", T.StringType(), False),
        T.StructField("body", T.StringType(), False),
        T.StructField("metadata_json", T.StringType(), False),
        T.StructField("metadata_display_json", T.StringType(), False),
        T.StructField("normalized_row_json", T.StringType(), False),
        T.StructField("source_columns", T.ArrayType(T.StringType(), False), False),
        T.StructField("source_fields_json", T.StringType(), False),
        T.StructField("content_hash", T.StringType(), False),
        T.StructField("embedding_input_version", T.StringType(), False),
        T.StructField("field_rendering_version", T.StringType(), False),
        T.StructField("policy_fingerprint", T.StringType(), False),
        T.StructField("job_id", T.StringType(), False),
        T.StructField("semantic_bindings_json", T.StringType(), False),
        T.StructField("staged_at", T.StringType(), False),
        T.StructField("row_status", T.StringType(), False),
        T.StructField("error_reason", T.StringType(), True),
    ])


def parent_rows_from_local_rows(rows: list[dict], manifest: dict) -> list[dict]:
    body, title, metadata, identifiers = role_columns(manifest)
    body_fields, title_fields = role_field_specs(manifest, "body"), role_field_specs(manifest, "title")
    metadata_fields, identifier_fields = role_field_specs(manifest, "metadata"), role_field_specs(manifest, "identifier")
    schema_columns = sorted(set(body + title + metadata + identifiers))
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
            included_columns=schema_columns,
            semantic_bindings=manifest.get("semanticBindings") or {},
            ordinal=ordinal,
            job_id=str(manifest["jobId"]),
            policy_fingerprint=str(manifest["policyFingerprint"]),
            staged_at=str(manifest.get("stagedAt") or ""),
            body_fields=body_fields,
            title_fields=title_fields,
            metadata_fields=metadata_fields,
            identifier_fields=identifier_fields,
            logical_to_physical=manifest.get("physicalColumnMapping") or {},
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
    failed_rate_threshold = float(manifest.get("failedRowRateThreshold") if manifest.get("failedRowRateThreshold") is not None else 0.05)
    failure_report: dict[str, Any] = {}
    failure_row_count = 0
    failure_count = 0
    manifest["checkpointPath"] = paths["checkpoint"]
    schema = manifest.get("schema") or []
    source_columns = [{"sourceName": str(item.get("name")), "dataType": str(item.get("dataType") or item.get("data_type") or "string")} for item in schema if isinstance(item, dict) and item.get("name")]
    target = manifest.get("icebergTarget")
    if not isinstance(target, dict):
        raise ValueError("RAG_PARENT_ICEBERG_TARGET_REQUIRED")
    catalog = str(target.get("catalog") or "asklake")
    namespace = str(target.get("namespace") or "rag")
    table = str(target.get("table") or f"parents_{dataset_id}")
    table_id = ".".join(f"`{value.replace('`', '``')}`" for value in (catalog, namespace, table))
    try:
        callback(
            manifest,
            {
                "status": "parent_staged",
                "event": "stage_started",
                "stage": "staging",
                "datasetId": dataset_id,
                "jobId": job_id,
                "observedAt": datetime.now(timezone.utc).isoformat(),
            },
        )
    except RagJobAlreadyComplete as exc:
        print(f"ASKLAKE_RAG_PARENT_SKIPPED={canonical_json({'jobId': job_id, 'reason': str(exc)})}")
        return 0
    except RagStageRejectedError as exc:
        print(f"ASKLAKE_RAG_PARENT_REJECTED={canonical_json({'jobId': job_id, 'reason': str(exc)})}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"ASKLAKE_RAG_PARENT_CALLBACK_ERROR={canonical_json({'jobId': job_id, 'error': str(exc)})}", file=sys.stderr)
        return 1

    spark = make_spark(manifest.get("sourceCollection") or {}, manifest.get("icebergTarget"), disable_speculation=True)
    try:
        # Iceberg table replacement is atomic. Reuse a committed stage when
        # the driver died after the write and before the callback.
        if spark.catalog.tableExists(f"{catalog}.{namespace}.{table}"):
            existing = spark.table(table_id)
            if "schema_version" not in existing.columns:
                raise RuntimeError("RAG_PARENT_SCHEMA_VERSION_MISMATCH")
            versions = {str(row[0]) for row in existing.select("schema_version").distinct().collect()}
            if versions and versions != {RAG_PARENT_SCHEMA_VERSION}:
                raise RuntimeError("RAG_PARENT_SCHEMA_VERSION_MISMATCH")
            if existing.filter("row_status = 'valid'").groupBy("source_row_id").count().filter("count > 1").limit(1).count() or existing.filter("row_status = 'valid'").groupBy("parent_document_id").count().filter("count > 1").limit(1).count():
                raise RuntimeError("RAG parent identifier integrity check failed: duplicate source_row_id or parent_document_id")
            count = existing.filter("row_status = 'valid'").count() if "row_status" in existing.columns else existing.count()
            failed_count = existing.filter("row_status = 'failed'").count() if "row_status" in existing.columns else 0
            row_count = count + failed_count
            failed_rate = failed_count / row_count if row_count else 0.0
            report = failed_row_report(row_count=row_count, failed_count=failed_count, threshold=failed_rate_threshold, quarantined_table=f"{catalog}.{namespace}.{table}")
            failure_report, failure_row_count, failure_count = report, row_count, failed_count
            if failed_rate > failed_rate_threshold:
                raise RuntimeError(f"RAG parent failed-row rate {failed_rate:.4f} exceeds threshold {failed_rate_threshold:.4f}")
            result = {"status": "success", "schemaVersion": RAG_PARENT_SCHEMA_VERSION, "datasetId": dataset_id, "jobId": job_id, "sourceFingerprint": source_fingerprint, "parentCount": count, "rowCount": row_count, "failedCount": failed_count, "failedRate": failed_rate, "failedRowReport": report, "table": f"{catalog}.{namespace}.{table}", "checkpointPath": paths["checkpoint"], "resumed": True, "durationMs": int((time.time() - started) * 1000)}
            print(f"ASKLAKE_RAG_PARENT_RESULT={canonical_json(result)}")
            callback(manifest, {"status": "parent_staged", "parentCount": count, "rowCount": row_count, "failedCount": failed_count, "failedRate": failed_rate, "failedRowReport": report, "parentTable": result["table"], "checkpointPath": paths["checkpoint"], "resumed": True})
            return 0
        source_df = read_source(spark, source_format, source_path, source_columns, source_collection=manifest.get("sourceCollection") or {})
        normalized_df = normalize_columns(source_df, source_columns)
        role_body, role_title, role_metadata, role_identifiers = role_columns(manifest)
        body_fields, title_fields = role_field_specs(manifest, "body"), role_field_specs(manifest, "title")
        metadata_fields, identifier_fields = role_field_specs(manifest, "metadata"), role_field_specs(manifest, "identifier")
        schema_names = sorted(set(role_body + role_title + role_metadata + role_identifiers))
        semantic_bindings = manifest.get("semanticBindings") or {}
        policy_fingerprint = str(manifest.get("policyFingerprint"))

        def convert(row, ordinal):
            values = row.asDict(recursive=True)
            try:
                document = build_parent_document(
                    dataset_id=dataset_id,
                    source_fingerprint=source_fingerprint,
                    row=values,
                    schema_columns=schema_names,
                    body_columns=role_body,
                    title_columns=role_title,
                    metadata_columns=role_metadata,
                    identifier_columns=role_identifiers,
                    included_columns=schema_names,
                    semantic_bindings=semantic_bindings,
                    ordinal=int(ordinal),
                    job_id=job_id,
                    policy_fingerprint=policy_fingerprint,
                    body_fields=body_fields,
                    title_fields=title_fields,
                    metadata_fields=metadata_fields,
                    identifier_fields=identifier_fields,
                    logical_to_physical=manifest.get("physicalColumnMapping") or {},
                )
                validate_parent_document(document)
                document["row_status"] = "valid"
                document["error_reason"] = None
            except Exception as exc:
                selected = normalized_row(values, schema_names)
                source_id = f"invalid-row:{sha256_hex(selected)[:32]}"
                content_hash = sha256_hex({"row": selected, "error": str(exc)})
                return {
                    "schema_version": RAG_PARENT_SCHEMA_VERSION,
                    "dataset_id": dataset_id,
                    "source_fingerprint": source_fingerprint,
                    "source_row_id": source_id,
                    "row_ordinal": int(ordinal),
                    "parent_document_id": parent_document_id(dataset_id, source_id, content_hash),
                    "title": None,
                    "title_blocks_json": "[]",
                    "body_blocks_json": "[]",
                    "body": "",
                    "metadata_json": "{}",
                    "metadata_display_json": "{}",
                    "normalized_row_json": json.dumps(selected, ensure_ascii=False, sort_keys=True, default=str),
                    "source_columns": sorted(set(schema_names)),
                    "source_fields_json": "[]",
                    "content_hash": content_hash,
                    "embedding_input_version": "title_body_fields_v2",
                    "field_rendering_version": FIELD_RENDERING_VERSION,
                    "policy_fingerprint": policy_fingerprint,
                    "job_id": job_id,
                    "semantic_bindings_json": json.dumps(semantic_bindings, ensure_ascii=False, sort_keys=True, default=str),
                    "staged_at": datetime.now(timezone.utc).isoformat(),
                    "row_status": "failed",
                    "error_reason": f"{exc.__class__.__name__}: {str(exc)[:900]}",
                }
            document["metadata_json"] = json.dumps(document.pop("metadata"), ensure_ascii=False, sort_keys=True, default=str)
            document["metadata_display_json"] = json.dumps(document.pop("metadata_display"), ensure_ascii=False, sort_keys=True, default=str)
            document["normalized_row_json"] = json.dumps(document.pop("normalized_row"), ensure_ascii=False, sort_keys=True, default=str)
            document["title_blocks_json"] = json.dumps(document.pop("title_blocks"), ensure_ascii=False, sort_keys=True, default=str)
            document["body_blocks_json"] = json.dumps(document.pop("body_blocks"), ensure_ascii=False, sort_keys=True, default=str)
            document["source_fields_json"] = json.dumps(document.pop("source_fields"), ensure_ascii=False, sort_keys=True, default=str)
            document["semantic_bindings_json"] = json.dumps(document.pop("semantic_bindings"), ensure_ascii=False, sort_keys=True, default=str)
            return document

        spark.sparkContext.setCheckpointDir(paths["checkpoint"])
        indexed = normalized_df.rdd.zipWithIndex().map(lambda pair: convert(pair[0], pair[1]))
        indexed.checkpoint()
        indexed.count()
        parent_df = spark.createDataFrame(indexed, schema=parent_schema())
        duplicate_source_ids = parent_df.filter("row_status = 'valid'").groupBy("source_row_id").count().filter("count > 1").limit(1).count()
        duplicate_parent_ids = parent_df.filter("row_status = 'valid'").groupBy("parent_document_id").count().filter("count > 1").limit(1).count()
        if duplicate_source_ids or duplicate_parent_ids:
            raise RuntimeError("RAG parent identifier integrity check failed: duplicate source_row_id or parent_document_id")
        spark.sql(f"CREATE NAMESPACE IF NOT EXISTS `{catalog}`.`{namespace}`")
        (parent_df.writeTo(table_id).using("iceberg").tableProperty("format-version", "2").createOrReplace())
        count = parent_df.filter("row_status = 'valid'").count()
        failed_count = parent_df.filter("row_status = 'failed'").count()
        row_count = count + failed_count
        failed_rate = failed_count / row_count if row_count else 0.0
        report = failed_row_report(row_count=row_count, failed_count=failed_count, threshold=failed_rate_threshold, quarantined_table=f"{catalog}.{namespace}.{table}")
        failure_report, failure_row_count, failure_count = report, row_count, failed_count
        result_status = "failed" if failed_rate > failed_rate_threshold else "success"
        result = {"status": result_status, "schemaVersion": RAG_PARENT_SCHEMA_VERSION, "datasetId": dataset_id, "jobId": job_id, "sourceFingerprint": source_fingerprint, "parentCount": count, "rowCount": row_count, "failedCount": failed_count, "failedRate": failed_rate, "failedRowReport": report, "table": f"{catalog}.{namespace}.{table}", "checkpointPath": paths["checkpoint"], "durationMs": int((time.time() - started) * 1000)}
        if result_status == "failed":
            raise RuntimeError(f"RAG parent failed-row rate {failed_rate:.4f} exceeds threshold {failed_rate_threshold:.4f}")
        report_path = str(manifest.get("reportPath") or "").strip()
        if report_path:
            with open(report_path, "w", encoding="utf-8") as handle:
                json.dump(result, handle, ensure_ascii=False, indent=2)
        print(f"ASKLAKE_RAG_PARENT_RESULT={canonical_json(result)}")
        callback(manifest, {"status": "parent_staged", "parentCount": count, "rowCount": row_count, "failedCount": failed_count, "failedRate": failed_rate, "failedRowReport": report, "parentTable": result["table"], "checkpointPath": paths["checkpoint"]})
        return 0
    except RagJobAlreadyComplete as exc:
        print(f"ASKLAKE_RAG_PARENT_SKIPPED={canonical_json({'jobId': job_id, 'reason': str(exc)})}")
        return 0
    except Exception as exc:
        result = {"status": "failed", "datasetId": dataset_id, "jobId": job_id, "error": str(exc), "rowCount": failure_row_count, "failedCount": failure_count, "failedRate": float(failure_report.get("failedRate") or 0.0), "failedRowReport": failure_report, "durationMs": int((time.time() - started) * 1000)}
        try:
            callback(manifest, result, require_continue=False)
        except Exception as callback_exc:
            print(
                f"ASKLAKE_RAG_PARENT_FAILURE_CALLBACK_ERROR={canonical_json({'jobId': job_id, 'error': str(callback_exc)})}",
                file=sys.stderr,
            )
        print(f"ASKLAKE_RAG_PARENT_RESULT={canonical_json(result)}", file=sys.stderr)
        return 1
    finally:
        spark.stop()


if __name__ == "__main__":
    raise SystemExit(main())
