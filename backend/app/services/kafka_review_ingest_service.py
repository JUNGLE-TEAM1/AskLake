from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import resource
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, TypeVar

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError
from confluent_kafka import Consumer, KafkaError, TopicPartition
from sqlalchemy.orm import Session

from app.repositories.catalog_repository import CatalogRepository


T = TypeVar("T")
REQUIRED_FIELDS = ("event_id", "offset", "review", "created_at")
BACKEND_DIR = Path(__file__).resolve().parents[2]


class KafkaIngestFailure(Exception):
    def __init__(self, message: str, *, failed_stage: str = "Kafka ingest", bridge: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.failed_stage = failed_stage
        self.bridge = bridge or {}


def capture_kafka_snapshot(request: dict[str, Any]) -> dict[str, Any]:
    topic = str(request.get("topic") or "reviews.raw")
    group_id = str(request.get("consumerGroupId") or f"asklake-review-{int(time.time() * 1000)}")
    broker = str(request.get("broker") or "127.0.0.1:19092")
    policy = str(request.get("offsetPolicy") or "earliest").lower()
    maximum = int(request.get("maxMessages") or 100)
    timeout_seconds = max(1.0, int(request.get("timeoutMs") or 10000) / 1000)
    detail: dict[str, Any] = {
        "engine": "python-confluent-kafka",
        "fastapiReceivedAt": request.get("fastapiReceivedAt"),
        "runtimeStartedAt": iso_now(),
    }
    started = time.perf_counter()
    consumer = Consumer(consumer_config(broker, group_id, policy))
    try:
        metadata = measure(detail, "fetchTopicMetadata", lambda: consumer.list_topics(topic, timeout=timeout_seconds))
        topic_metadata = metadata.topics.get(topic)
        if topic_metadata is None or topic_metadata.error is not None:
            raise KafkaIngestFailure(f"Kafka topic metadata unavailable: {topic}", failed_stage="snapshot")
        partition_ids = sorted(topic_metadata.partitions)
        topic_partitions = [TopicPartition(topic, partition) for partition in partition_ids]
        watermarks: dict[int, tuple[int, int]] = {}
        watermark_started = time.perf_counter()
        for item in topic_partitions:
            watermarks[item.partition] = consumer.get_watermark_offsets(item, timeout=timeout_seconds, cached=False)
        detail["fetchTopicOffsetsMs"] = elapsed_ms(watermark_started)
        committed = measure(detail, "fetchGroupOffsets", lambda: consumer.committed(topic_partitions, timeout=timeout_seconds))
        committed_by_partition = {item.partition: int(item.offset) for item in committed}
        compute_started = time.perf_counter()
        partitions: list[dict[str, Any]] = []
        for partition in partition_ids:
            low, high = watermarks[partition]
            committed_offset = committed_by_partition.get(partition, -1001)
            initial = high if committed_offset < 0 and policy == "latest" else low if committed_offset < 0 else committed_offset
            start = min(max(initial, low), high)
            end = min(high, start + maximum)
            partitions.append({
                "partition": partition,
                "startOffset": str(start),
                "highWatermark": str(high),
                "endOffset": str(end),
            })
        identity = json.dumps({"consumerGroupId": group_id, "partitions": partitions, "topic": topic}, separators=(",", ":"), sort_keys=True)
        detail["snapshotComputeMs"] = elapsed_ms(compute_started)
        snapshot = {
            "captureTiming": detail,
            "capturedAt": iso_now(),
            "consumerGroupId": group_id,
            "offsetPolicy": policy,
            "partitions": partitions,
            "snapshotId": f"kafka_snapshot_{hashlib.sha256(identity.encode()).hexdigest()[:16]}",
            "topic": topic,
        }
        return snapshot
    except KafkaIngestFailure:
        raise
    except Exception as exc:
        raise KafkaIngestFailure(str(exc), failed_stage="snapshot") from exc
    finally:
        measure(detail, "consumerClose", consumer.close)
        detail["captureProcessTotalMs"] = elapsed_ms(started)


def ingest_kafka_reviews_python(db: Session, request: dict[str, Any]) -> dict[str, Any]:
    started_at = iso_now()
    process_cpu_started = time.process_time()
    snapshot = request.get("snapshot")
    if not isinstance(snapshot, dict):
        raise KafkaIngestFailure("Kafka snapshot is required.", failed_stage="snapshot")
    topic = str(request.get("topic") or snapshot.get("topic") or "reviews.raw")
    group_id = str(request.get("consumerGroupId") or snapshot.get("consumerGroupId") or "asklake-review")
    broker = str(request.get("broker") or "127.0.0.1:19092")
    timeout_ms = int(request.get("timeoutMs") or 10000)
    allow_empty = bool(request.get("allowEmpty", False))
    target_layer = str(request.get("targetLayer") or "BRONZE").upper()
    target_format = str(request.get("targetFormat") or "jsonl").lower()
    if target_layer not in {"RAW", "BRONZE", "SILVER"}:
        raise KafkaIngestFailure(f"Kafka direct target layer is invalid: {target_layer}")
    if target_format != "jsonl":
        raise KafkaIngestFailure(f"Kafka direct target currently supports jsonl only: {target_format}")

    run_id = str(request.get("runId") or make_run_id())
    dataset_name = str(request.get("datasetName") or "reviews_raw")
    dataset_id = str(request.get("datasetId") or f"ds_{safe_segment(dataset_name)}")
    register_catalog = bool(request.get("registerCatalog", True))
    transform_steps = list(request.get("transformSteps") or [])
    quality_rules = list(request.get("qualityRules") or [])
    timing_detail: dict[str, Any] = {
        "capture": snapshot.get("captureTiming"),
        "commit": {},
        "consume": {},
        "engine": "python-confluent-kafka",
        "readerPreparation": {},
        "runtime": {"pythonStartedAt": started_at},
    }
    timing = {
        "producerAckAt": request.get("producerAckAt"),
        "snapshotCapturedAt": snapshot.get("capturedAt"),
        "consumeEndedAt": None,
        "transformEndedAt": None,
        "minioWriteEndedAt": None,
        "catalogPublishedAt": None,
        "offsetCommittedAt": None,
    }
    consumer = Consumer(consumer_config(broker, group_id, str(request.get("offsetPolicy") or "earliest")))
    metadata: dict[str, Any] | None = None
    current_stage = "consume"
    try:
        records, invalid_records = consume_snapshot(consumer, snapshot, timeout_ms, timing_detail)
        timing["consumeEndedAt"] = iso_now()
        if not records and not allow_empty:
            raise KafkaIngestFailure(f"No valid review messages consumed from {topic} at {broker}.", failed_stage="consume")

        current_stage = "transform"
        processed, quarantined, transform, quality = apply_pipeline_rules(records, transform_steps, quality_rules)
        quarantined = [{**item, "stage": "parse"} for item in invalid_records] + quarantined
        data_body = "".join(f"{json.dumps(record, ensure_ascii=False, separators=(',', ':'))}\n" for record in processed)
        timing["transformEndedAt"] = iso_now()
        schema_columns = target_schema(processed, transform_steps)
        schema = [[item["targetName"], item["type"]] for item in schema_columns]
        target = target_paths(request, dataset_name, target_layer, target_format, snapshot["snapshotId"])
        write_local_target(target, data_body)
        metadata = {
            "broker": broker,
            "catalogDataset": None,
            "consumedCount": len(records),
            "consumerGroupId": group_id,
            "dataPath": str(target["dataPath"]),
            "datasetId": dataset_id if register_catalog else None,
            "datasetName": dataset_name if register_catalog else None,
            "endedAt": timing["transformEndedAt"],
            "engine": "python-confluent-kafka",
            "failedCount": len(invalid_records) + int(transform["errorCount"]),
            "invalidRecords": invalid_records[:10],
            "maxMessages": int(request.get("maxMessages") or 100),
            "metadataPath": str(target["metadataPath"]),
            "offsetPolicy": str(request.get("offsetPolicy") or "earliest"),
            "runId": run_id,
            "snapshot": snapshot,
            "inferredSchema": schema,
            "sampleRows": [review_sample_row(record, schema_columns) for record in processed[:10]],
            "schema": schema,
            "schemaFingerprint": hashlib.sha256(json.dumps(schema, separators=(",", ":")).encode()).hexdigest(),
            "startedAt": started_at,
            "status": "success",
            "storageFormat": "jsonl",
            "storageLocation": str(target["dataPath"]),
            "storageSizeBytes": len(data_body.encode()),
            "storedCount": len(processed),
            "targetBucket": target["bucket"],
            "targetFormat": target_format,
            "targetLayer": target_layer,
            "targetPrefix": target["prefix"].rstrip("/"),
            "timing": timing,
            "timingDetail": timing_detail,
            "timeoutMs": timeout_ms,
            "topic": topic,
            "transform": transform,
            "quality": quality,
        }
        current_stage = "target"
        if target["mode"] == "s3":
            s3 = s3_client(request)
            ensure_bucket(s3, target["bucket"])
            if data_body:
                s3.put_object(Bucket=target["bucket"], Key=target["dataKey"], Body=data_body.encode(), ContentType="application/x-ndjson")
            metadata["storageLocation"] = f"s3://{target['bucket']}/{target['dataKey']}"
            metadata["metadataLocation"] = f"s3://{target['bucket']}/{target['metadataKey']}"
            metadata["storageMode"] = "s3"
            if quarantined:
                body = "".join(f"{json.dumps(item, ensure_ascii=False)}\n" for item in quarantined)
                s3.put_object(Bucket=target["bucket"], Key=target["quarantineKey"], Body=body.encode(), ContentType="application/x-ndjson")
                quality["quarantineLocation"] = f"s3://{target['bucket']}/{target['quarantineKey']}"
            put_s3_json(s3, target["bucket"], target["metadataKey"], metadata)
        else:
            metadata["metadataLocation"] = str(target["metadataPath"])
            metadata["storageMode"] = "local"
            if quarantined:
                target["quarantinePath"].write_text("".join(f"{json.dumps(item, ensure_ascii=False)}\n" for item in quarantined))
                quality["quarantineLocation"] = str(target["quarantinePath"])
        timing["minioWriteEndedAt"] = iso_now()

        if os.getenv("ASKLAKE_ENABLE_KAFKA_TEST_HOOKS") == "true" and bool(request.get("testFailAfterTargetWrite")):
            raise KafkaIngestFailure("Test-only failure after Kafka target write.", failed_stage="catalog")
        current_stage = "catalog"
        if register_catalog:
            dataset = register_catalog_dataset(db, metadata, request)
            metadata["catalogDataset"] = {
                "id": dataset["id"],
                "layer": dataset["layer"],
                "materializationRuns": len(dataset.get("materializationRuns") or []),
                "name": dataset["name"],
                "rows": dataset["rows"],
                "storageLocation": dataset.get("storageLocation"),
            }
        timing["catalogPublishedAt"] = iso_now()
        metadata["endedAt"] = timing["catalogPublishedAt"]

        if os.getenv("ASKLAKE_ENABLE_KAFKA_TEST_HOOKS") == "true" and bool(request.get("testFailAfterCatalogPublish")):
            raise KafkaIngestFailure("Test-only failure after Kafka Catalog publish.", failed_stage="commit")
        current_stage = "commit"
        commit_snapshot(consumer, snapshot, timing_detail["commit"])
        timing["offsetCommittedAt"] = iso_now()
        metadata["endedAt"] = timing["offsetCommittedAt"]
        metadata["offsetCommit"] = {"committedAt": timing["offsetCommittedAt"], "status": "success"}
        usage = resource.getrusage(resource.RUSAGE_SELF)
        timing_detail["resource"] = {
            "processCpuMs": round((time.process_time() - process_cpu_started) * 1000, 2),
            "processMaxRssBytes": int(usage.ru_maxrss if sys.platform == "darwin" else usage.ru_maxrss * 1024),
        }
        write_metadata(target, metadata, request)
        return metadata
    except KafkaIngestFailure as exc:
        exc.bridge = {
            "code": "KAFKA_REVIEW_INGEST_FAILED",
            "broker": broker,
            "consumerGroupId": group_id,
            "endedAt": iso_now(),
            "failedStage": exc.failed_stage,
            "message": str(exc),
            "runId": run_id,
            "snapshot": snapshot,
            "startedAt": started_at,
            "timingDetail": timing_detail,
            "topic": topic,
        }
        raise
    except Exception as exc:
        failed_stage = current_stage
        failure = KafkaIngestFailure(str(exc), failed_stage=failed_stage)
        failure.bridge = {
            "code": "KAFKA_REVIEW_INGEST_FAILED",
            "broker": broker,
            "consumerGroupId": group_id,
            "endedAt": iso_now(),
            "failedStage": failed_stage,
            "message": str(exc),
            "runId": run_id,
            "snapshot": snapshot,
            "startedAt": started_at,
            "timingDetail": timing_detail,
            "topic": topic,
        }
        raise failure from exc
    finally:
        measure(timing_detail["runtime"], "consumerClose", consumer.close)


def consume_snapshot(consumer: Consumer, snapshot: dict[str, Any], timeout_ms: int, detail: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    partitions = snapshot.get("partitions") or []
    ranges = {int(item["partition"]): (int(item["startOffset"]), int(item["endOffset"])) for item in partitions}
    assignments = [TopicPartition(snapshot["topic"], partition, start) for partition, (start, end) in ranges.items() if start < end]
    if not assignments:
        return [], []
    measure(detail["readerPreparation"], "consumerAssign", lambda: consumer.assign(assignments))
    pending = {partition for partition, (start, end) in ranges.items() if start < end}
    records: list[dict[str, Any]] = []
    invalid: list[dict[str, Any]] = []
    deadline = time.monotonic() + timeout_ms / 1000
    started = time.perf_counter()
    detail["consume"]["firstPollAt"] = iso_now()
    while pending and time.monotonic() < deadline:
        messages = consumer.consume(num_messages=10000, timeout=min(0.1, max(0.001, deadline - time.monotonic())))
        for message in messages:
            if message.error():
                if message.error().code() == KafkaError._PARTITION_EOF:
                    continue
                raise KafkaIngestFailure(str(message.error()), failed_stage="consume")
            partition = message.partition()
            start, end = ranges[partition]
            offset = message.offset()
            if offset < start:
                continue
            if offset >= end:
                pending.discard(partition)
                continue
            detail["consume"]["firstMessageReadAt"] = detail["consume"].get("firstMessageReadAt") or iso_now()
            detail["consume"]["lastMessageReadAt"] = iso_now()
            detail["consume"]["messageCount"] = int(detail["consume"].get("messageCount") or 0) + 1
            parsed, error = parse_review_message(message.value().decode("utf-8") if message.value() else "", {
                "key": message.key().decode("utf-8") if message.key() else "",
                "offset": str(offset),
                "partition": partition,
                "topic": message.topic(),
            })
            if parsed is not None:
                records.append(parsed)
            elif error is not None:
                invalid.append(error)
            if offset + 1 >= end:
                pending.discard(partition)
    detail["consume"]["consumeSnapshotMs"] = elapsed_ms(started)
    if pending:
        raise KafkaIngestFailure(f"Kafka snapshot {snapshot['snapshotId']} timed out before all partition ranges were consumed.", failed_stage="consume")
    return records, invalid


def commit_snapshot(consumer: Consumer, snapshot: dict[str, Any], detail: dict[str, Any]) -> None:
    offsets = [TopicPartition(snapshot["topic"], int(item["partition"]), int(item["endOffset"])) for item in snapshot.get("partitions") or [] if int(item["startOffset"]) < int(item["endOffset"])]
    if offsets:
        measure(detail, "consumerCommit", lambda: consumer.commit(offsets=offsets, asynchronous=False))


def parse_review_message(value: str, context: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    try:
        source = json.loads(value)
        for field in REQUIRED_FIELDS:
            if source.get(field) in (None, ""):
                return None, {**context, "field": field, "rawPayload": value, "reason": "missing_required_field"}
        if source.get("schema_version") not in (None, "1.0"):
            return None, {**context, "rawPayload": value, "reason": "unsupported_schema_version", "schemaVersion": source.get("schema_version")}
        if "raw" in source and not isinstance(source["raw"], dict):
            return None, {**context, "rawPayload": value, "reason": "invalid_raw_payload"}
        numeric_offset = float(source["offset"])
        if numeric_offset.is_integer():
            numeric_offset = int(numeric_offset)
        return {
            "schema_version": source.get("schema_version") or "1.0",
            "event_id": str(source["event_id"]),
            "source": source.get("source") or "review-dataset",
            "offset": numeric_offset,
            "review": str(source["review"]),
            "created_at": str(source["created_at"]),
            "raw": source.get("raw") or copy.deepcopy(source),
        }, None
    except Exception as exc:
        return None, {**context, "message": str(exc), "rawPayload": value, "reason": "invalid_json"}


def apply_pipeline_rules(records: list[dict[str, Any]], steps: list[dict[str, Any]], rules: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any], dict[str, Any]]:
    transform = {"appliedStepCount": 0, "configuredStepCount": sum(step.get("enabled") is not False for step in steps), "errorCount": 0}
    transformed: list[dict[str, Any]] = []
    quarantined: list[dict[str, Any]] = []
    for source_record in records:
        record = copy.deepcopy(source_record)
        discard = False
        for step in steps:
            if step.get("enabled") is False or not step.get("output"):
                continue
            try:
                set_value(record, str(step["output"]), apply_transform(record, step))
                transform["appliedStepCount"] += 1
            except Exception as exc:
                transform["errorCount"] += 1
                action = failure_action(step.get("onError"))
                if action == "Fail Run":
                    raise KafkaIngestFailure(f"Transform rule {step.get('id') or step.get('output')} failed: {exc}", failed_stage="transform") from exc
                if action == "Drop Row":
                    discard = True
                    break
                if action == "Quarantine":
                    quarantined.append(quarantine_entry(record, "transform", step, str(exc)))
                    discard = True
                    break
                set_value(record, str(step["output"]), None if action == "Set Null" else get_value(record, str(step.get("input") or "")))
        if not discard:
            transformed.append(record)

    quality = {"configuredRuleCount": sum(rule.get("enabled") is not False for rule in rules), "droppedCount": 0, "invalidRowCount": 0, "quarantinedCount": 0, "setNullCount": 0, "status": "pass", "summary": "품질 규칙 없음", "warnCount": 0}
    output: list[dict[str, Any]] = []
    unique: dict[str, set[str]] = {}
    for record in transformed:
        failures: list[tuple[dict[str, Any], str]] = []
        for rule in rules:
            if rule.get("enabled") is False:
                continue
            reason = quality_failure(get_value(record, str(rule.get("targetColumn") or "")), rule, unique)
            if reason:
                failures.append((rule, reason))
        if not failures:
            output.append(record)
            continue
        quality["invalidRowCount"] += 1
        discard = False
        for rule, reason in failures:
            action = failure_action(rule.get("failureAction"))
            if action == "Fail Run":
                raise KafkaIngestFailure(f"Quality rule {rule.get('id') or rule.get('targetColumn')} failed: {reason}", failed_stage="quality")
            if action == "Drop Row":
                quality["droppedCount"] += 1
                discard = True
                break
            if action == "Quarantine":
                quarantined.append(quarantine_entry(record, "quality", rule, reason))
                quality["quarantinedCount"] += 1
                discard = True
                break
            if action == "Set Null":
                set_value(record, str(rule.get("targetColumn") or ""), None)
                quality["setNullCount"] += 1
            else:
                quality["warnCount"] += 1
        if not discard:
            output.append(record)
    invalid_total = quality["invalidRowCount"]
    pass_rate = round(((len(records) - invalid_total) / len(records)) * 100, 1) if records else 100
    quality["status"] = "warn" if invalid_total else "pass"
    if quality["configuredRuleCount"]:
        quality["summary"] = f"Quality score {pass_rate}% - invalid rows {invalid_total} - dropped {quality['droppedCount']} - quarantined {quality['quarantinedCount']}"
    return output, quarantined, transform, quality


def apply_transform(record: dict[str, Any], step: dict[str, Any]) -> Any:
    input_value = get_value(record, str(step.get("input") or ""))
    value = "" if input_value is None else str(input_value)
    operation = f"{step.get('kind') or ''} {step.get('operation') or ''}".lower()
    if "default" in operation:
        return input_value if value.strip() else step.get("params", "")
    if "null guard" in operation or "not null" in operation:
        if not value.strip():
            raise ValueError("Missing required value")
        return input_value
    if "json" in operation:
        source = json.loads(input_value) if isinstance(input_value, str) else input_value
        path = str(step.get("params") or "$.").removeprefix("$").lstrip(".")
        current = source
        for part in [item for item in path.split(".") if item]:
            current = current.get(part) if isinstance(current, dict) else None
        return current
    if "lower" in operation or "trim" in operation:
        return value.strip().lower()
    if "decimal" in operation or "cast" in operation:
        return f"{float(value):.2f}"
    if "timestamp" in operation or "date" in operation:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if "mask" in operation:
        return re.sub(r"(\d{3})-?\d{4}-?(\d{4})", r"\1-****-\2", value)
    return input_value


def quality_failure(value: Any, rule: dict[str, Any], unique: dict[str, set[str]]) -> str:
    text = "" if value is None else str(value)
    validation = str(rule.get("validationType") or rule.get("kind") or "").lower()
    params = rule_params(rule)
    if "not null" in validation or "notnull" in validation:
        return "" if text.strip() else "Missing required value"
    if "range" in validation:
        try:
            numeric, minimum = float(text), float(params.get("min", 0))
            maximum = float(params["max"]) if params.get("max") not in (None, "") else float("inf")
            valid = minimum <= numeric <= maximum if params.get("inclusive", True) is not False else minimum < numeric < maximum
            return "" if valid else "Numeric range check failed"
        except (TypeError, ValueError):
            return "Numeric range check failed"
    if "regex" in validation:
        try:
            return "" if re.search(str(params.get("pattern") or r"^[^\s@]+@[^\s@]+\.[^\s@]+$"), text) else "Regex match failed"
        except re.error:
            return "Invalid regex pattern"
    if "accepted" in validation:
        values = [str(item) for item in params.get("values", ["KOR", "JPN", "USA", "KR", "US"])]
        return "" if text in values else "Value is outside accepted set"
    if "unique" in validation and text:
        key = str(rule.get("id") or rule.get("targetColumn") or "unique")
        seen = unique.setdefault(key, set())
        duplicate = text in seen
        seen.add(text)
        return "Duplicate value" if duplicate else ""
    return ""


def register_catalog_dataset(db: Session, metadata: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    repository = CatalogRepository(db)
    previous = repository.get_dataset_payload(str(metadata["datasetId"])) or {}
    run = {"createdAt": metadata["endedAt"], "jobId": "kafka-review-ingest", "kafkaSnapshot": metadata["snapshot"], "rowCount": metadata["storedCount"], "runId": metadata["runId"], "sourceKind": "kafka", "sourceLabel": metadata["topic"], "status": metadata["status"], "storageLocation": metadata["storageLocation"], "storageSizeBytes": metadata["storageSizeBytes"]}
    prior_runs = [item for item in previous.get("materializationRuns", []) if isinstance(item, dict)]
    summary = kafka_materialization_summary(previous, prior_runs)
    if snapshot_advances_summary(summary, metadata["snapshot"]):
        summary["rowCount"] += max(0, int(metadata["storedCount"]))
        summary["storageSizeBytes"] += max(0, int(metadata["storageSizeBytes"]))
        summary["successfulSnapshotCount"] += 1
        if int(metadata["storedCount"]) > 0 and metadata.get("storageLocation"):
            summary["lastNonEmptyStorageLocation"] = metadata["storageLocation"]
    advance_summary_watermarks(summary, metadata["snapshot"])
    snapshot_id = metadata["snapshot"].get("snapshotId")
    runs = [run] + [item for item in prior_runs if item.get("runId") != run["runId"] and (not snapshot_id or (item.get("kafkaSnapshot") or {}).get("snapshotId") != snapshot_id)]
    runs = runs[:50]
    successful = [item for item in runs if item.get("status") == "success"]
    latest = successful[0] if successful else runs[0]
    row_count = int(summary["rowCount"])
    size_bytes = int(summary["storageSizeBytes"])
    preserve_samples = metadata["storedCount"] == 0 and previous.get("schema") == metadata["schema"] and isinstance(previous.get("sampleRows"), list)
    payload = {
        "description": request.get("targetDescription") or "Kafka snapshot direct target dataset",
        "downstream": ["SQL 분석", "리뷰 분석"],
        "freshness": "latest",
        "id": metadata["datasetId"],
        "layer": metadata["targetLayer"],
        "lastUpdated": latest.get("createdAt") or metadata["endedAt"],
        "lineageGraph": lineage_graph(metadata["datasetId"], metadata["datasetName"], metadata["targetLayer"], metadata["targetFormat"], metadata["schema"], metadata["topic"]),
        "materializationRuns": runs,
        "materializationSummary": summary,
        "name": metadata["datasetName"],
        "nextRefresh": "-",
        "owner": os.getenv("ASKLAKE_REVIEW_DATASET_OWNER", "AskLake"),
        "quality": metadata["quality"].get("summary") or "Kafka snapshot 적재 완료",
        "rag": False,
        "rows": str(row_count),
        "sampleRows": previous.get("sampleRows") if preserve_samples else metadata["sampleRows"],
        "schema": metadata["schema"],
        "size": format_bytes(size_bytes),
        "source": f"Kafka {metadata['topic']}",
        "sourceRunId": latest.get("runId") or metadata["runId"],
        "status": "available",
        "storageFormat": metadata["targetFormat"],
        "storageLocation": summary.get("lastNonEmptyStorageLocation") or metadata["storageLocation"],
        "storageSizeBytes": size_bytes,
        "tags": ["#kafka", "#reviews", f"#{metadata['targetLayer'].lower()}"],
        "upstream": [f"Kafka topic: {metadata['topic']}"],
    }
    return repository.save_dataset_payload(payload)


def kafka_materialization_summary(previous: dict[str, Any], prior_runs: list[dict[str, Any]]) -> dict[str, Any]:
    stored = previous.get("materializationSummary")
    if isinstance(stored, dict) and int(stored.get("version") or 0) == 1:
        return {
            "lastNonEmptyStorageLocation": str(stored.get("lastNonEmptyStorageLocation") or previous.get("storageLocation") or ""),
            "offsetWatermarks": {
                str(key): max(-1, parse_non_negative_integer(value, default=-1))
                for key, value in (stored.get("offsetWatermarks") or {}).items()
            } if isinstance(stored.get("offsetWatermarks"), dict) else {},
            "rowCount": parse_non_negative_integer(stored.get("rowCount")),
            "storageSizeBytes": parse_non_negative_integer(stored.get("storageSizeBytes")),
            "successfulSnapshotCount": parse_non_negative_integer(stored.get("successfulSnapshotCount")),
            "version": 1,
        }

    summary = {
        "lastNonEmptyStorageLocation": str(previous.get("storageLocation") or "") if parse_non_negative_integer(previous.get("rows")) > 0 else "",
        "offsetWatermarks": {},
        "rowCount": parse_non_negative_integer(previous.get("rows")),
        "storageSizeBytes": parse_non_negative_integer(previous.get("storageSizeBytes")),
        "successfulSnapshotCount": sum(1 for run in prior_runs if run.get("status") == "success"),
        "version": 1,
    }
    for run in prior_runs:
        if run.get("status") == "success" and isinstance(run.get("kafkaSnapshot"), dict):
            advance_summary_watermarks(summary, run["kafkaSnapshot"])
    return summary


def snapshot_advances_summary(summary: dict[str, Any], snapshot: dict[str, Any]) -> bool:
    watermarks = summary.get("offsetWatermarks") if isinstance(summary.get("offsetWatermarks"), dict) else {}
    partitions = snapshot.get("partitions") if isinstance(snapshot.get("partitions"), list) else []
    if not partitions:
        return False
    return any(
        parse_non_negative_integer(partition.get("endOffset")) > int(watermarks.get(snapshot_watermark_key(snapshot, partition), -1))
        for partition in partitions
        if isinstance(partition, dict)
    )


def advance_summary_watermarks(summary: dict[str, Any], snapshot: dict[str, Any]) -> None:
    watermarks = summary.setdefault("offsetWatermarks", {})
    partitions = snapshot.get("partitions") if isinstance(snapshot.get("partitions"), list) else []
    for partition in partitions:
        if not isinstance(partition, dict):
            continue
        key = snapshot_watermark_key(snapshot, partition)
        watermarks[key] = max(int(watermarks.get(key, -1)), parse_non_negative_integer(partition.get("endOffset")))


def snapshot_watermark_key(snapshot: dict[str, Any], partition: dict[str, Any]) -> str:
    return "|".join([
        str(snapshot.get("topic") or ""),
        str(snapshot.get("consumerGroupId") or ""),
        str(parse_non_negative_integer(partition.get("partition"))),
    ])


def parse_non_negative_integer(value: Any, *, default: int = 0) -> int:
    if isinstance(value, bool) or value is None:
        return default
    if isinstance(value, (int, float)):
        return max(default, int(value))
    digits = re.sub(r"[^0-9]", "", str(value))
    return max(default, int(digits)) if digits else default


def target_paths(request: dict[str, Any], dataset_name: str, layer: str, target_format: str, snapshot_id: str) -> dict[str, Any]:
    mode = str(request.get("storageMode") or "local").lower()
    bucket = str(request.get("targetBucket") or request.get("landingBucket") or "asklake-output")
    prefix = normalize_prefix(str(request.get("targetPrefix") or request.get("landingPrefix") or f"{safe_segment(dataset_name)}/{layer.lower()}"))
    data_key = f"{prefix}snapshots/{safe_segment(snapshot_id)}/data.{target_format}"
    metadata_key = f"{prefix}snapshots/{safe_segment(snapshot_id)}/metadata.json"
    root = Path(str(request.get("localLandingDir") or BACKEND_DIR / "tmp" / "kafka-target")).resolve()
    directory = root / safe_segment(dataset_name) / layer.lower() / "snapshots" / safe_segment(snapshot_id)
    return {"mode": mode, "bucket": bucket, "prefix": prefix, "dataKey": data_key, "metadataKey": metadata_key, "quarantineKey": f"{prefix}snapshots/{safe_segment(snapshot_id)}/quarantine.jsonl", "dataPath": directory / f"data.{target_format}", "metadataPath": directory / "metadata.json", "quarantinePath": directory / "quarantine.jsonl"}


def write_local_target(target: dict[str, Any], data_body: str) -> None:
    target["metadataPath"].parent.mkdir(parents=True, exist_ok=True)
    if data_body:
        target["dataPath"].write_text(data_body)


def write_metadata(target: dict[str, Any], metadata: dict[str, Any], request: dict[str, Any]) -> None:
    target["metadataPath"].write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    if target["mode"] == "s3":
        put_s3_json(s3_client(request), target["bucket"], target["metadataKey"], metadata)


def s3_client(request: dict[str, Any]):
    return boto3.client("s3", endpoint_url=str(request.get("landingEndpoint") or os.getenv("MINIO_ENDPOINT") or "http://127.0.0.1:19000"), aws_access_key_id=os.getenv("ASKLAKE_REVIEW_LANDING_ACCESS_KEY") or os.getenv("MINIO_ACCESS_KEY") or "m3admin", aws_secret_access_key=os.getenv("ASKLAKE_REVIEW_LANDING_SECRET_KEY") or os.getenv("MINIO_SECRET_KEY") or "wishuponastar", region_name=os.getenv("MINIO_REGION", "us-east-1"), config=Config(s3={"addressing_style": "path"}))


def ensure_bucket(client: Any, bucket: str) -> None:
    try:
        client.head_bucket(Bucket=bucket)
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code") or "")
        if code in {"404", "NoSuchBucket", "NotFound"}:
            client.create_bucket(Bucket=bucket)
        else:
            raise


def put_s3_json(client: Any, bucket: str, key: str, value: dict[str, Any]) -> None:
    client.put_object(Bucket=bucket, Key=key, Body=(json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode(), ContentType="application/json")


def target_schema(records: list[dict[str, Any]], steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    base = standard_schema()
    known = {item["targetName"] for item in base}
    for step in steps:
        output = step.get("output")
        if step.get("enabled") is not False and output and output not in known:
            base.append({"nullable": True, "sourceName": output, "targetName": output, "type": "String"})
            known.add(output)
    for record in records:
        for name, value in record.items():
            if name not in known:
                base.append({"nullable": value is None, "sourceName": name, "targetName": name, "type": infer_type(value)})
                known.add(name)
    return base


def standard_schema() -> list[dict[str, Any]]:
    return [{"nullable": False, "sourceName": "schema_version", "targetName": "schema_version", "type": "String"}, {"nullable": False, "role": "Identifier", "sourceName": "event_id", "targetName": "event_id", "type": "String"}, {"nullable": False, "sourceName": "source", "targetName": "source", "type": "String"}, {"nullable": False, "sourceName": "offset", "targetName": "offset", "type": "Integer"}, {"nullable": False, "sourceName": "review", "targetName": "review", "type": "String"}, {"nullable": False, "role": "Event Time", "sourceName": "created_at", "targetName": "created_at", "type": "Timestamp"}, {"nullable": False, "sourceName": "raw", "targetName": "raw", "type": "Object"}]


def lineage_graph(dataset_id: str, name: str, layer: str, target_format: str, schema: list[list[str]], topic: str) -> dict[str, Any]:
    source_id = "source_reviews_raw_topic"
    return {"datasetId": dataset_id, "datasets": [{"columns": [{"id": f"source_{column}", "name": column, "type": kind} for column, kind in schema], "engine": "KAFKA", "id": source_id, "layer": "SOURCE", "name": f"Kafka {topic}"}, {"columns": [{"id": f"dataset_{column}", "name": column, "type": kind} for column, kind in schema], "engine": target_format.upper(), "id": dataset_id, "layer": layer, "name": name}], "edges": [{"fromColumnId": f"source_{column}", "fromDatasetId": source_id, "toColumnId": f"dataset_{column}", "toDatasetId": dataset_id} for column, _ in schema]}


def consumer_config(broker: str, group_id: str, policy: str) -> dict[str, Any]:
    return {"bootstrap.servers": broker, "group.id": group_id, "enable.auto.commit": False, "auto.offset.reset": policy, "enable.partition.eof": True, "client.id": "asklake-python-kafka-ingest"}


def get_value(record: dict[str, Any], field: str) -> Any:
    if field in record:
        return record[field]
    current: Any = record
    for part in [item for item in field.split(".") if item]:
        if not isinstance(current, dict):
            current = None
            break
        current = current.get(part)
    if current is not None:
        return current
    raw = record.get("raw")
    if isinstance(raw, dict):
        raw_field = re.sub(r"^raw[_.]", "", field)
        return raw.get(raw_field, raw.get(field))
    return None


def set_value(record: dict[str, Any], field: str, value: Any) -> None:
    parts = [item for item in field.split(".") if item]
    if not parts:
        return
    current = record
    for part in parts[:-1]:
        if not isinstance(current.get(part), dict):
            current[part] = {}
        current = current[part]
    current[parts[-1]] = value


def rule_params(rule: dict[str, Any]) -> dict[str, Any]:
    params = rule.get("params")
    if isinstance(params, dict):
        return params
    if isinstance(params, str) and params.strip():
        try:
            parsed = json.loads(params)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def failure_action(value: Any) -> str:
    text = str(value or "Warn").strip().lower()
    if "fail" in text:
        return "Fail Run"
    if "drop" in text:
        return "Drop Row"
    if "quarantine" in text:
        return "Quarantine"
    if "null" in text:
        return "Set Null"
    return "Warn"


def quarantine_entry(record: dict[str, Any], stage: str, rule: dict[str, Any], reason: str) -> dict[str, Any]:
    return {"reason": reason, "record": record, "ruleId": rule.get("id") or "", "stage": stage, "targetColumn": rule.get("targetColumn") or rule.get("output") or ""}


def review_sample_row(record: dict[str, Any], schema: list[dict[str, Any]]) -> list[str]:
    result = []
    for column in schema:
        value = get_value(record, column["targetName"])
        result.append(json.dumps(value, ensure_ascii=False, separators=(",", ":")) if isinstance(value, (dict, list)) else "" if value is None else str(value).lower() if isinstance(value, bool) else str(value))
    return result


def infer_type(value: Any) -> str:
    if isinstance(value, bool):
        return "Boolean"
    if isinstance(value, int):
        return "Integer"
    if isinstance(value, float):
        return "Float"
    if isinstance(value, (dict, list)):
        return "Object"
    return "String"


def format_bytes(value: int) -> str:
    if value < 1024:
        return f"{value} B"
    if value < 1024**2:
        return f"{value / 1024:.1f} KB"
    if value < 1024**3:
        return f"{value / 1024**2:.1f} MB"
    return f"{value / 1024**3:.1f} GB"


def normalize_prefix(value: str) -> str:
    normalized = re.sub(r"/{2,}", "/", value.strip().replace("\\", "/").lstrip("/"))
    return f"{normalized}/" if normalized and not normalized.endswith("/") else normalized


def safe_segment(value: Any) -> str:
    return re.sub(r"^_+|_+$", "", re.sub(r"[^0-9A-Za-z._-]+", "_", str(value or "topic").strip())) or "topic"


def make_run_id() -> str:
    return f"run_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}_{os.urandom(3).hex()}"


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def elapsed_ms(started: float) -> float:
    return round((time.perf_counter() - started) * 1000, 2)


def measure(target: dict[str, Any], key: str, action: Callable[[], T]) -> T:
    started = time.perf_counter()
    target[f"{key}StartedAt"] = iso_now()
    try:
        return action()
    finally:
        target[f"{key}EndedAt"] = iso_now()
        target[f"{key}Ms"] = elapsed_ms(started)
