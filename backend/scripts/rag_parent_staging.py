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


def parent_stage_context(manifest: dict) -> dict[str, Any]:
    dataset_id = str(manifest.get("datasetId") or "").strip()
    job_id = str(manifest.get("jobId") or "").strip()
    source_path = str(manifest.get("sourcePath") or "").strip()
    source_format = str(manifest.get("sourceFormat") or "").strip().lower()
    base_path = str(manifest.get("stagingBasePath") or "").strip()
    source_fingerprint = str(manifest.get("sourceFingerprint") or "").strip()
    if not all(
        (
            dataset_id,
            job_id,
            source_path,
            source_format,
            base_path,
            source_fingerprint,
        )
    ):
        raise ValueError("RAG_PARENT_MANIFEST_REQUIRED_FIELDS_MISSING")
    source_snapshot_id = str(manifest.get("sourceSnapshotId") or "").strip()
    if source_format == "iceberg" and not source_snapshot_id:
        raise ValueError("RAG_PARENT_ICEBERG_SNAPSHOT_REQUIRED")
    target = manifest.get("icebergTarget")
    if not isinstance(target, dict):
        raise ValueError("RAG_PARENT_ICEBERG_TARGET_REQUIRED")
    schema = manifest.get("schema") or []
    source_columns = [
        {
            "sourceName": str(item.get("name")),
            "dataType": str(
                item.get("dataType") or item.get("data_type") or "string"
            ),
        }
        for item in schema
        if isinstance(item, dict) and item.get("name")
    ]
    catalog = str(target.get("catalog") or "asklake")
    namespace = str(target.get("namespace") or "rag")
    table = str(target.get("table") or f"parents_{dataset_id}")
    return {
        "datasetId": dataset_id,
        "jobId": job_id,
        "sourcePath": source_path,
        "sourceFormat": source_format,
        "sourceFingerprint": source_fingerprint,
        "sourceSnapshotId": source_snapshot_id or None,
        "paths": build_staging_paths(
            base_path=base_path,
            dataset_id=dataset_id,
            job_id=job_id,
        ),
        "failedRateThreshold": float(
            manifest.get("failedRowRateThreshold")
            if manifest.get("failedRowRateThreshold") is not None
            else 0.05
        ),
        "sourceColumns": source_columns,
        "catalog": catalog,
        "namespace": namespace,
        "table": table,
        "tableId": ".".join(
            f"`{value.replace('`', '``')}`"
            for value in (catalog, namespace, table)
        ),
    }


def begin_parent_stage(
    manifest: dict,
    *,
    dataset_id: str,
    job_id: str,
) -> int | None:
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
        print(
            f"ASKLAKE_RAG_PARENT_SKIPPED={canonical_json({'jobId': job_id, 'reason': str(exc)})}"
        )
        return 0
    except RagStageRejectedError as exc:
        print(
            f"ASKLAKE_RAG_PARENT_REJECTED={canonical_json({'jobId': job_id, 'reason': str(exc)})}",
            file=sys.stderr,
        )
        return 1
    except Exception as exc:
        print(
            f"ASKLAKE_RAG_PARENT_CALLBACK_ERROR={canonical_json({'jobId': job_id, 'error': str(exc)})}",
            file=sys.stderr,
        )
        return 1
    return None


def convert_parent_row(
    row: Any,
    ordinal: int,
    context: dict[str, Any],
) -> dict[str, Any]:
    values = row.asDict(recursive=True)
    try:
        document = build_parent_document(
            dataset_id=context["datasetId"],
            source_fingerprint=context["sourceFingerprint"],
            row=values,
            schema_columns=context["schemaNames"],
            body_columns=context["bodyColumns"],
            title_columns=context["titleColumns"],
            metadata_columns=context["metadataColumns"],
            identifier_columns=context["identifierColumns"],
            included_columns=context["schemaNames"],
            semantic_bindings=context["semanticBindings"],
            ordinal=int(ordinal),
            job_id=context["jobId"],
            policy_fingerprint=context["policyFingerprint"],
            body_fields=context["bodyFields"],
            title_fields=context["titleFields"],
            metadata_fields=context["metadataFields"],
            identifier_fields=context["identifierFields"],
            logical_to_physical=context["physicalColumnMapping"],
        )
        validate_parent_document(document)
        document["row_status"] = "valid"
        document["error_reason"] = None
    except Exception as exc:
        selected = normalized_row(values, context["schemaNames"])
        source_id = f"invalid-row:{sha256_hex(selected)[:32]}"
        content_hash = sha256_hex({"row": selected, "error": str(exc)})
        return {
            "schema_version": RAG_PARENT_SCHEMA_VERSION,
            "dataset_id": context["datasetId"],
            "source_fingerprint": context["sourceFingerprint"],
            "source_row_id": source_id,
            "row_ordinal": int(ordinal),
            "parent_document_id": parent_document_id(
                context["datasetId"],
                source_id,
                content_hash,
            ),
            "title": None,
            "title_blocks_json": "[]",
            "body_blocks_json": "[]",
            "body": "",
            "metadata_json": "{}",
            "metadata_display_json": "{}",
            "normalized_row_json": json.dumps(
                selected,
                ensure_ascii=False,
                sort_keys=True,
                default=str,
            ),
            "source_columns": sorted(set(context["schemaNames"])),
            "source_fields_json": "[]",
            "content_hash": content_hash,
            "embedding_input_version": "title_body_fields_v2",
            "field_rendering_version": FIELD_RENDERING_VERSION,
            "policy_fingerprint": context["policyFingerprint"],
            "job_id": context["jobId"],
            "semantic_bindings_json": json.dumps(
                context["semanticBindings"],
                ensure_ascii=False,
                sort_keys=True,
                default=str,
            ),
            "staged_at": datetime.now(timezone.utc).isoformat(),
            "row_status": "failed",
            "error_reason": f"{exc.__class__.__name__}: {str(exc)[:900]}",
        }
    return serialize_parent_document(document)


def serialize_parent_document(document: dict[str, Any]) -> dict[str, Any]:
    document["metadata_json"] = json.dumps(
        document.pop("metadata"),
        ensure_ascii=False,
        sort_keys=True,
        default=str,
    )
    document["metadata_display_json"] = json.dumps(
        document.pop("metadata_display"),
        ensure_ascii=False,
        sort_keys=True,
        default=str,
    )
    document["normalized_row_json"] = json.dumps(
        document.pop("normalized_row"),
        ensure_ascii=False,
        sort_keys=True,
        default=str,
    )
    for source, target in (
        ("title_blocks", "title_blocks_json"),
        ("body_blocks", "body_blocks_json"),
        ("source_fields", "source_fields_json"),
        ("semantic_bindings", "semantic_bindings_json"),
    ):
        document[target] = json.dumps(
            document.pop(source),
            ensure_ascii=False,
            sort_keys=True,
            default=str,
        )
    return document


def inspect_existing_parent_stage(
    spark: Any,
    stage: dict[str, Any],
    *,
    started: float,
) -> dict[str, Any] | None:
    catalog = stage["catalog"]
    namespace = stage["namespace"]
    table = stage["table"]
    if not spark.catalog.tableExists(f"{catalog}.{namespace}.{table}"):
        return None
    existing = spark.table(stage["tableId"])
    if "schema_version" not in existing.columns:
        raise RuntimeError("RAG_PARENT_SCHEMA_VERSION_MISMATCH")
    versions = {
        str(row[0])
        for row in existing.select("schema_version").distinct().collect()
    }
    if versions and versions != {RAG_PARENT_SCHEMA_VERSION}:
        raise RuntimeError("RAG_PARENT_SCHEMA_VERSION_MISMATCH")
    valid = existing.filter("row_status = 'valid'")
    duplicate_source_ids = (
        valid.groupBy("source_row_id").count().filter("count > 1").limit(1).count()
    )
    duplicate_parent_ids = (
        valid.groupBy("parent_document_id").count().filter("count > 1").limit(1).count()
    )
    if duplicate_source_ids or duplicate_parent_ids:
        raise RuntimeError(
            "RAG parent identifier integrity check failed: "
            "duplicate source_row_id or parent_document_id"
        )
    count = valid.count() if "row_status" in existing.columns else existing.count()
    failed_count = (
        existing.filter("row_status = 'failed'").count()
        if "row_status" in existing.columns
        else 0
    )
    row_count = count + failed_count
    failed_rate = failed_count / row_count if row_count else 0.0
    report = failed_row_report(
        row_count=row_count,
        failed_count=failed_count,
        threshold=stage["failedRateThreshold"],
        quarantined_table=f"{catalog}.{namespace}.{table}",
    )
    return {
        "count": count,
        "failedCount": failed_count,
        "rowCount": row_count,
        "failedRate": failed_rate,
        "report": report,
        "result": {
            "status": "success",
            "schemaVersion": RAG_PARENT_SCHEMA_VERSION,
            "datasetId": stage["datasetId"],
            "jobId": stage["jobId"],
            "sourceFingerprint": stage["sourceFingerprint"],
            "parentCount": count,
            "rowCount": row_count,
            "failedCount": failed_count,
            "failedRate": failed_rate,
            "failedRowReport": report,
            "table": f"{catalog}.{namespace}.{table}",
            "checkpointPath": stage["paths"]["checkpoint"],
            "resumed": True,
            "durationMs": int((time.time() - started) * 1000),
        },
    }


def write_parent_stage(
    spark: Any,
    manifest: dict,
    stage: dict[str, Any],
    *,
    started: float,
) -> dict[str, Any]:
    source_df = read_source(
        spark,
        stage["sourceFormat"],
        stage["sourcePath"],
        stage["sourceColumns"],
        source_collection=manifest.get("sourceCollection") or {},
        source_snapshot_id=stage.get("sourceSnapshotId"),
    )
    normalized_df = normalize_columns(source_df, stage["sourceColumns"])
    role_body, role_title, role_metadata, role_identifiers = role_columns(manifest)
    body_fields = role_field_specs(manifest, "body")
    title_fields = role_field_specs(manifest, "title")
    metadata_fields = role_field_specs(manifest, "metadata")
    identifier_fields = role_field_specs(manifest, "identifier")
    schema_names = sorted(
        set(role_body + role_title + role_metadata + role_identifiers)
    )
    conversion_context = {
        "datasetId": stage["datasetId"],
        "sourceFingerprint": stage["sourceFingerprint"],
        "schemaNames": schema_names,
        "bodyColumns": role_body,
        "titleColumns": role_title,
        "metadataColumns": role_metadata,
        "identifierColumns": role_identifiers,
        "semanticBindings": manifest.get("semanticBindings") or {},
        "jobId": stage["jobId"],
        "policyFingerprint": str(manifest.get("policyFingerprint")),
        "bodyFields": body_fields,
        "titleFields": title_fields,
        "metadataFields": metadata_fields,
        "identifierFields": identifier_fields,
        "physicalColumnMapping": manifest.get("physicalColumnMapping") or {},
    }
    spark.sparkContext.setCheckpointDir(stage["paths"]["checkpoint"])
    indexed = normalized_df.rdd.zipWithIndex().map(
        lambda pair: convert_parent_row(pair[0], pair[1], conversion_context)
    )
    indexed.checkpoint()
    indexed.count()
    parent_df = spark.createDataFrame(indexed, schema=parent_schema())
    valid_df = parent_df.filter("row_status = 'valid'")
    duplicate_source_ids = (
        valid_df.groupBy("source_row_id").count().filter("count > 1").limit(1).count()
    )
    duplicate_parent_ids = (
        valid_df.groupBy("parent_document_id").count().filter("count > 1").limit(1).count()
    )
    if duplicate_source_ids or duplicate_parent_ids:
        raise RuntimeError(
            "RAG parent identifier integrity check failed: "
            "duplicate source_row_id or parent_document_id"
        )
    spark.sql(
        f"CREATE NAMESPACE IF NOT EXISTS `{stage['catalog']}`.`{stage['namespace']}`"
    )
    (
        parent_df.writeTo(stage["tableId"])
        .using("iceberg")
        .tableProperty("format-version", "2")
        .createOrReplace()
    )
    count = valid_df.count()
    failed_count = parent_df.filter("row_status = 'failed'").count()
    row_count = count + failed_count
    failed_rate = failed_count / row_count if row_count else 0.0
    table_name = f"{stage['catalog']}.{stage['namespace']}.{stage['table']}"
    report = failed_row_report(
        row_count=row_count,
        failed_count=failed_count,
        threshold=stage["failedRateThreshold"],
        quarantined_table=table_name,
    )
    return {
        "status": "failed" if failed_rate > stage["failedRateThreshold"] else "success",
        "schemaVersion": RAG_PARENT_SCHEMA_VERSION,
        "datasetId": stage["datasetId"],
        "jobId": stage["jobId"],
        "sourceFingerprint": stage["sourceFingerprint"],
        "parentCount": count,
        "rowCount": row_count,
        "failedCount": failed_count,
        "failedRate": failed_rate,
        "failedRowReport": report,
        "table": table_name,
        "checkpointPath": stage["paths"]["checkpoint"],
        "durationMs": int((time.time() - started) * 1000),
    }


def main() -> int:
    started = time.time()
    manifest = load_manifest()
    stage = parent_stage_context(manifest)
    dataset_id = stage["datasetId"]
    job_id = stage["jobId"]
    source_path = stage["sourcePath"]
    source_format = stage["sourceFormat"]
    source_fingerprint = stage["sourceFingerprint"]
    paths = stage["paths"]
    failed_rate_threshold = stage["failedRateThreshold"]
    failure_report: dict[str, Any] = {}
    failure_row_count = 0
    failure_count = 0
    manifest["checkpointPath"] = paths["checkpoint"]
    source_columns = stage["sourceColumns"]
    catalog = stage["catalog"]
    namespace = stage["namespace"]
    table = stage["table"]
    table_id = stage["tableId"]
    early_exit = begin_parent_stage(
        manifest,
        dataset_id=dataset_id,
        job_id=job_id,
    )
    if early_exit is not None:
        return early_exit

    spark = make_spark(manifest.get("sourceCollection") or {}, manifest.get("icebergTarget"), disable_speculation=True)
    try:
        # Iceberg table replacement is atomic. Reuse a committed stage when
        # the driver died after the write and before the callback.
        resumed = inspect_existing_parent_stage(spark, stage, started=started)
        if resumed is not None:
            failure_report = resumed["report"]
            failure_row_count = resumed["rowCount"]
            failure_count = resumed["failedCount"]
            failed_rate = resumed["failedRate"]
            if failed_rate > failed_rate_threshold:
                raise RuntimeError(f"RAG parent failed-row rate {failed_rate:.4f} exceeds threshold {failed_rate_threshold:.4f}")
            result = resumed["result"]
            print(f"ASKLAKE_RAG_PARENT_RESULT={canonical_json(result)}")
            callback(manifest, {"status": "parent_staged", "parentCount": resumed["count"], "rowCount": resumed["rowCount"], "failedCount": resumed["failedCount"], "failedRate": failed_rate, "failedRowReport": resumed["report"], "parentTable": result["table"], "checkpointPath": paths["checkpoint"], "resumed": True})
            return 0
        result = write_parent_stage(spark, manifest, stage, started=started)
        failure_report = result["failedRowReport"]
        failure_row_count = result["rowCount"]
        failure_count = result["failedCount"]
        if result["status"] == "failed":
            failed_rate = result["failedRate"]
            raise RuntimeError(f"RAG parent failed-row rate {failed_rate:.4f} exceeds threshold {failed_rate_threshold:.4f}")
        report_path = str(manifest.get("reportPath") or "").strip()
        if report_path:
            with open(report_path, "w", encoding="utf-8") as handle:
                json.dump(result, handle, ensure_ascii=False, indent=2)
        print(f"ASKLAKE_RAG_PARENT_RESULT={canonical_json(result)}")
        callback(manifest, {"status": "parent_staged", "parentCount": result["parentCount"], "rowCount": result["rowCount"], "failedCount": result["failedCount"], "failedRate": result["failedRate"], "failedRowReport": result["failedRowReport"], "parentTable": result["table"], "checkpointPath": paths["checkpoint"]})
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
