"""Kafka snapshot ingestion operations behind the ETL facade."""

from __future__ import annotations

RUNTIME_NAMES = {
    'ApiError',
    'ErrorCode',
    'Exception',
    'IcebergWriterTarget',
    'KafkaReviewIngestResponse',
    'KafkaSnapshotModel',
    'all',
    'catalog_reconciliation_error',
    'compact_storage_text',
    'dataset_from_spark_result',
    'dataset_storage_key',
    'dict',
    'etl_repository',
    'int',
    'isinstance',
    'iso_now',
    'kafka_ingest_request_from_job',
    'kafka_materialization_for_snapshot',
    'kafka_post_ingest_failure_details',
    'kafka_request_with_durable_snapshot',
    'kafka_snapshot_source_boundary',
    'len',
    'list',
    'make_dataset_id',
    'max',
    'next',
    'os',
    'parse_count_value',
    'publish_kafka_snapshot_iceberg_result',
    're',
    'run_kafka_ingest_request',
    'run_node_bridge',
    'status',
    'str',
    'verify_spark_iceberg_result',
}


def ingest_kafka_reviews(db: Session, request: KafkaReviewIngestRequest) -> KafkaReviewIngestResponse:
    result = run_kafka_ingest_request(db, request.model_dump(by_alias=True, exclude_none=True), "ingest", None)
    return KafkaReviewIngestResponse.model_validate(result)


def run_kafka_ingest_job(db: Session, job: ETLJobModel, command: str, run_id: str) -> dict[str, Any]:
    request = kafka_ingest_request_from_job(job, run_id)
    return run_kafka_ingest_request(db, request, command, job.id)


def run_kafka_ingest_request(db: Session, request: dict[str, Any], command: str, job_id: str | None) -> dict[str, Any]:
    snapshot_record, request_with_snapshot = kafka_request_with_durable_snapshot(db, request, job_id)
    result: dict[str, Any] | None = None
    ingest_timeout_seconds = max(
        30,
        int(request["timeoutMs"] / 1000) + 30,
        900 if request_with_snapshot.get("icebergTarget") else 0,
    )
    try:
        result = run_node_bridge(
            "ingest-kafka-reviews.mjs",
            "ASKLAKE_KAFKA_REVIEW_INGEST_RESULT",
            request_with_snapshot,
            error_marker="ASKLAKE_KAFKA_REVIEW_INGEST_ERROR",
            timeout_seconds=ingest_timeout_seconds,
        )
        if job_id:
            job = etl_repository.get_job(db, job_id)
            if job is None:
                raise ApiError(ErrorCode.NOT_FOUND, f"Job not found during Kafka ingest: {job_id}", status.HTTP_404_NOT_FOUND)
            if parse_count_value(result.get("storedCount")) > 0:
                result = publish_kafka_snapshot_iceberg_result(db, job, result)
            if (
                os.environ.get("ASKLAKE_ENABLE_KAFKA_TEST_HOOKS") == "true"
                and os.environ.get("ASKLAKE_KAFKA_SNAPSHOT_FAIL_BEFORE_OFFSET_COMMIT") == "true"
            ):
                raise ApiError(
                    "KAFKA_OFFSET_COMMIT_TEST_FAILURE",
                    "Test-only failure before Kafka Snapshot offset commit.",
                    status.HTTP_502_BAD_GATEWAY,
                )
            offset_result = run_node_bridge(
                "ingest-kafka-reviews.mjs",
                "ASKLAKE_KAFKA_REVIEW_INGEST_RESULT",
                {
                    "broker": request_with_snapshot.get("broker"),
                    "commitOnly": True,
                    "consumerGroupId": request_with_snapshot.get("consumerGroupId"),
                    "landingEndpoint": request_with_snapshot.get("landingEndpoint"),
                    "metadata": result,
                    "runId": result.get("runId"),
                    "snapshot": result.get("snapshot"),
                    "storageMode": request_with_snapshot.get("storageMode"),
                    "targetBucket": request_with_snapshot.get("targetBucket"),
                    "targetFormat": request_with_snapshot.get("targetFormat"),
                    "targetLayer": request_with_snapshot.get("targetLayer"),
                    "targetPrefix": request_with_snapshot.get("targetPrefix"),
                    "topic": request_with_snapshot.get("topic"),
                },
                error_marker="ASKLAKE_KAFKA_REVIEW_INGEST_ERROR",
                timeout_seconds=max(30, int(request["timeoutMs"] / 1000) + 30),
            )
            result["offsetCommit"] = offset_result.get("offsetCommit")
            result["metadataUpdate"] = offset_result.get("metadataUpdate")
    except ApiError as exc:
        etl_repository.update_kafka_snapshot(db, snapshot_record, "failed", exc.message)
        if result is not None:
            exc.details = {
                **(exc.details or {}),
                "bridge": kafka_post_ingest_failure_details(result, exc.message),
            }
        raise
    except Exception as exc:
        message = compact_storage_text(exc, limit=1000)
        etl_repository.update_kafka_snapshot(
            db,
            snapshot_record,
            "failed",
            message,
        )
        raise ApiError(
            ErrorCode.INTERNAL_ERROR,
            "Kafka Snapshot finalization failed unexpectedly",
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            {
                **(
                    {"bridge": kafka_post_ingest_failure_details(result, message)}
                    if result is not None
                    else {}
                ),
                "reason": message,
            },
        ) from exc
    etl_repository.update_kafka_snapshot(db, snapshot_record, "success")
    result["command"] = command
    return result


def kafka_post_ingest_failure_details(result: dict[str, Any], message: str) -> dict[str, Any]:
    return {
        "catalogDataset": result.get("catalogDataset"),
        "consumedCount": parse_count_value(result.get("consumedCount")),
        "endedAt": result.get("endedAt") or iso_now(),
        "failedCount": parse_count_value(result.get("failedCount")),
        "failedStage": "offset commit" if result.get("queryEngineVerified") is True else "catalog",
        "icebergCommit": result.get("icebergCommit"),
        "message": message,
        "offsetCommit": result.get("offsetCommit") or {"status": "pending"},
        "quality": result.get("quality"),
        "queryEngineTable": result.get("queryEngineTable"),
        "queryEngineVerified": result.get("queryEngineVerified") is True,
        "runId": result.get("runId"),
        "snapshot": result.get("snapshot"),
        "startedAt": result.get("startedAt") or iso_now(),
        "storageFormat": result.get("storageFormat"),
        "storageLocation": result.get("storageLocation") or result.get("warehouseLocation"),
        "storedCount": parse_count_value(result.get("storedCount")),
        "topic": result.get("topic"),
        "transform": result.get("transform"),
    }


def kafka_request_with_durable_snapshot(
    db: Session,
    request: dict[str, Any],
    job_id: str | None,
) -> tuple[KafkaSnapshotModel, dict[str, Any]]:
    topic = str(request.get("topic") or "reviews.raw")
    consumer_group_id = str(request.get("consumerGroupId") or "")
    broker = str(request.get("broker") or "")
    continuous_conflict = etl_repository.find_conflicting_kafka_continuous_runtime(
        db,
        broker=broker,
        topic=topic,
        consumer_group_id=consumer_group_id,
        excluded_job_id=job_id or "",
    )
    if continuous_conflict is not None:
        raise ApiError(
            ErrorCode.CONFLICT,
            f"Continuous Kafka worker is already active on Job: {continuous_conflict.job_id}",
            status.HTTP_409_CONFLICT,
            {"activeJobId": continuous_conflict.job_id, "runtimeStatus": continuous_conflict.status},
        )
    existing = etl_repository.get_active_kafka_snapshot(db, topic, consumer_group_id, job_id)
    if existing is None:
        capture_request = {**request, "snapshotOnly": True}
        captured = run_node_bridge(
            "ingest-kafka-reviews.mjs",
            "ASKLAKE_KAFKA_REVIEW_INGEST_RESULT",
            capture_request,
            error_marker="ASKLAKE_KAFKA_REVIEW_INGEST_ERROR",
            timeout_seconds=max(30, int(request["timeoutMs"] / 1000) + 30),
        )
        snapshot = captured.get("snapshot")
        if not isinstance(snapshot, dict):
            raise ApiError("KAFKA_SNAPSHOT_BAD_RESPONSE", "Kafka snapshot capture did not return a snapshot.", status.HTTP_502_BAD_GATEWAY)
        snapshot["broker"] = broker
        existing = KafkaSnapshotModel(
            snapshot_id=str(snapshot["snapshotId"]),
            job_id=job_id,
            topic=topic,
            consumer_group_id=consumer_group_id,
            status="running",
            snapshot=snapshot,
        )
        existing = etl_repository.save_kafka_snapshot(db, existing)
    return existing, {**request, "snapshot": existing.snapshot}


def kafka_failure_result(request: dict[str, Any], run_id: str, error: ApiError, bridge_error: dict[str, Any]) -> dict[str, Any]:
    return {
        "broker": bridge_error.get("broker") or request.get("broker"),
        "catalogDataset": bridge_error.get("catalogDataset"),
        "consumedCount": int(bridge_error.get("consumedCount") or 0),
        "endedAt": bridge_error.get("endedAt") or iso_now(),
        "error": bridge_error.get("message") or error.message,
        "failedCount": int(bridge_error.get("failedCount") or 0),
        "failedStage": bridge_error.get("failedStage") or "Kafka ingest",
        "icebergCommit": bridge_error.get("icebergCommit"),
        "offsetCommit": bridge_error.get("offsetCommit"),
        "queryEngineTable": bridge_error.get("queryEngineTable"),
        "queryEngineVerified": bridge_error.get("queryEngineVerified") is True,
        "runId": bridge_error.get("runId") or run_id,
        "snapshot": bridge_error.get("snapshot"),
        "startedAt": bridge_error.get("startedAt") or iso_now(),
        "status": "failed",
        "storageFormat": bridge_error.get("storageFormat"),
        "storageLocation": bridge_error.get("storageLocation"),
        "storedCount": int(bridge_error.get("storedCount") or 0),
        "targetLayer": request.get("targetLayer") or "BRONZE",
        "topic": bridge_error.get("topic") or request.get("topic"),
        "transform": bridge_error.get("transform"),
        "quality": bridge_error.get("quality"),
    }


def publish_kafka_snapshot_iceberg_result(
    db: Session,
    job: ETLJobModel,
    result: dict[str, Any],
) -> dict[str, Any]:
    run_id = str(result.get("runId") or "").strip()
    snapshot = result.get("snapshot")
    if not run_id or not isinstance(snapshot, dict):
        raise catalog_reconciliation_error(
            "Kafka Snapshot Iceberg result identity is incomplete.",
            {"jobId": job.id, "runId": run_id},
        )
    expected_boundary = kafka_snapshot_source_boundary(snapshot)
    commit = result.get("icebergCommit")
    committed_boundary = commit.get("sourceBoundary") if isinstance(commit, dict) else None
    if committed_boundary != expected_boundary:
        raise catalog_reconciliation_error(
            "Kafka Snapshot Iceberg source boundary does not match the persisted snapshot.",
            {"jobId": job.id, "runId": run_id, "snapshotId": snapshot.get("snapshotId")},
        )
    verified = verify_spark_iceberg_result(job, run_id, result)
    dataset_id = str(job.dataset_id or make_dataset_id(job.target))
    existing = etl_repository.get_dataset_by_id_for_update(db, dataset_id)
    previous_payload = existing.payload if existing and isinstance(existing.payload, dict) else {}
    previous_run = kafka_materialization_for_snapshot(
        previous_payload.get("materializationRuns"),
        str(snapshot.get("snapshotId") or ""),
    )
    existing_mapping = previous_payload.get("queryEngineTable")
    target = IcebergWriterTarget.model_validate(job.iceberg_target)
    same_mapping = isinstance(existing_mapping, dict) and all(
        str(existing_mapping.get(key) or "") == expected
        for key, expected in (
            ("catalog", target.catalog),
            ("schema", target.namespace),
            ("table", target.table),
            ("format", "iceberg"),
        )
    )
    materialization_mode = (
        str(previous_run.get("materializationMode") or "delta")
        if previous_run
        else "delta" if same_mapping else "snapshot"
    )
    verified = {
        **verified,
        "kafkaSnapshot": snapshot,
        "materializationMode": materialization_mode,
        "materializationRows": parse_count_value(result.get("storedCount")),
        "sourceBoundary": expected_boundary,
        "sourceKind": "kafka",
        "sourceRanges": expected_boundary["partitions"],
        "storageLocation": verified.get("warehouseLocation"),
        "storedCount": parse_count_value(result.get("storedCount")),
    }
    dataset = dataset_from_spark_result(job, verified, existing)
    saved_dataset = etl_repository.save_dataset(db, dataset)
    return {
        **verified,
        "catalogDataset": {
            "id": saved_dataset.id,
            "layer": saved_dataset.layer,
            "materializationRuns": len(saved_dataset.materialization_runs),
            "name": saved_dataset.name,
            "rows": saved_dataset.rows,
            "storageLocation": saved_dataset.storage_location,
        },
    }


def kafka_snapshot_source_boundary(snapshot: dict[str, Any]) -> dict[str, Any]:
    partitions = snapshot.get("partitions") if isinstance(snapshot.get("partitions"), list) else []
    return {
        "capturedAt": str(snapshot.get("capturedAt") or ""),
        "consumerGroupId": str(snapshot.get("consumerGroupId") or ""),
        "kind": "kafka_snapshot",
        "partitions": [
            {
                "endOffset": str(partition.get("endOffset") or ""),
                "partition": int(partition.get("partition") or 0),
                "startOffset": str(partition.get("startOffset") or ""),
            }
            for partition in partitions
            if isinstance(partition, dict)
        ],
        "snapshotId": str(snapshot.get("snapshotId") or ""),
        "topic": str(snapshot.get("topic") or ""),
    }


def kafka_materialization_for_snapshot(previous_runs: Any, snapshot_id: str) -> dict[str, Any] | None:
    if not snapshot_id or not isinstance(previous_runs, list):
        return None
    return next(
        (
            run
            for run in previous_runs
            if isinstance(run, dict)
            and str((run.get("kafkaSnapshot") or {}).get("snapshotId") or "") == snapshot_id
        ),
        None,
    )


def kafka_offset_policy(value: str) -> str:
    normalized = str(value or "").strip().lower()
    if "latest" in normalized or "new" in normalized:
        return "latest"
    return "earliest"


def parse_kafka_target_path(storage_path: str | None, target_dataset: str, target_layer: str | None) -> dict[str, str]:
    default_prefix = f"{dataset_storage_key(target_dataset or 'reviews_raw')}/{str(target_layer or 'BRONZE').lower()}"
    default_bucket = os.environ.get("ASKLAKE_SPARK_OUTPUT_BUCKET") or "asklake-output"
    if storage_path:
        match = re.match(r"^s3a?://([^/]+)(?:/(.*))?$", storage_path.strip())
        if match:
            prefix = (match.group(2) or default_prefix).strip("/") or default_prefix
            if prefix == "kafka-landing" or prefix.startswith("kafka-landing/"):
                return {"bucket": default_bucket, "prefix": default_prefix, "storageMode": "s3"}
            return {
                "bucket": match.group(1),
                "prefix": prefix,
                "storageMode": "s3",
            }
    return {"bucket": default_bucket, "prefix": default_prefix, "storageMode": "s3"}


EXPORTED_FUNCTIONS = (
    'ingest_kafka_reviews',
    'run_kafka_ingest_job',
    'run_kafka_ingest_request',
    'kafka_post_ingest_failure_details',
    'kafka_request_with_durable_snapshot',
    'kafka_failure_result',
    'publish_kafka_snapshot_iceberg_result',
    'kafka_snapshot_source_boundary',
    'kafka_materialization_for_snapshot',
    'kafka_offset_policy',
    'parse_kafka_target_path',
)

IMPLEMENTATIONS = {name: globals()[name] for name in EXPORTED_FUNCTIONS}
