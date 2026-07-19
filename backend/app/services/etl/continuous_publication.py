"""Kafka continuous publication operations behind the ETL facade."""

from __future__ import annotations

RUNTIME_NAMES = {
    'ApiError',
    'ContinuousBatchPublicationHooks',
    'ContinuousPublicationHooks',
    'DashboardLiveRepository',
    'Exception',
    'IcebergWriterTarget',
    'OSError',
    'Path',
    'PublicationCatalogEvidence',
    'PublicationInputEvidence',
    'PublicationOutputEvidence',
    'STREAM_COMMIT_KIND',
    'UTC',
    'ValueError',
    '_list_continuous_stream_partition_cursors',
    '_prepare_continuous_publication',
    '_publish_continuous_dashboard_revision',
    '_register_continuous_publication_catalog',
    '_update_continuous_publication_stats',
    '_verify_continuous_publication_manifest',
    '_verify_continuous_publication_output',
    'all',
    'any',
    'backfill_catalog_revision',
    'callable',
    'canonical_storage_path',
    'clickhouse_kafka_ingest_v2_enabled',
    'compact_storage_text',
    'continuous_runtime_report_path',
    'continuous_stream_publication_metadata',
    'dataset_from_spark_result',
    'datetime',
    'dict',
    'etl_repository',
    'execute_continuous_publication',
    'format_rows',
    'getattr',
    'int',
    'isinstance',
    'iso_now',
    'json',
    'list',
    'list_continuous_stream_manifest_batch_ids',
    'make_dataset_id',
    'materialize_continuous_publication',
    'max',
    'merge_stream_partition_cursor_metrics',
    'next',
    'nonnegative_int',
    'normalize_kafka_source_ranges',
    'object_manifest_port',
    'optional_int',
    'optional_string',
    'os',
    'parse_kafka_target_path',
    're',
    'read_continuous_stream_manifest',
    'recommended_dashboard_poll_ms',
    'reconcile_continuous_publications',
    'run_kafka_continuous_worker',
    'settings',
    'set',
    'sorted',
    'str',
    'timedelta',
    'urlparse',
    'verify_continuous_publication_storage',
    'verify_spark_iceberg_result',
    'write_runtime_json_atomic',
}


def continuous_worker_status(job: ETLJobModel, runtime: KafkaContinuousRuntimeModel) -> dict[str, Any]:
    try:
        return run_kafka_continuous_worker(job, runtime, "status")
    except ApiError as exc:
        if clickhouse_kafka_ingest_v2_enabled(job, settings):
            return {
                "containerState": "failed",
                "error": exc.message,
                "worker": "kafka_connect_clickhouse_v2",
            }
        return {"containerState": "unknown", "error": exc.message}


def continuous_heartbeat_is_stale(heartbeat_at: str | None, job: ETLJobModel) -> bool:
    if not heartbeat_at:
        return False
    try:
        heartbeat = datetime.fromisoformat(heartbeat_at.replace("Z", "+00:00"))
    except ValueError:
        return True
    trigger_seconds = int((job.continuous_config or {}).get("triggerIntervalSeconds") or 30)
    timeout_seconds = int(os.environ.get("ASKLAKE_CONTINUOUS_HEARTBEAT_TIMEOUT_SECONDS") or max(90, trigger_seconds * 3))
    return datetime.now(UTC) - heartbeat > timedelta(seconds=timeout_seconds)


def continuous_failure_identity(
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    worker_status: dict[str, Any],
    reason: str,
) -> str:
    worker_attempt = (
        optional_string(worker_status.get("workerAttemptId"))
        or optional_string(worker_status.get("containerId"))
        or optional_string((runtime.metrics or {}).get("currentWorkerAttemptId"))
        or optional_string(worker_status.get("containerName"))
        or job.id
    )
    return f"{worker_attempt}:{reason}"


def stop_stale_continuous_worker(job: ETLJobModel, runtime: KafkaContinuousRuntimeModel) -> None:
    try:
        run_kafka_continuous_worker(job, runtime, "terminate")
    except ApiError:
        # The runtime is already failed; cleanup must not hide the liveness cause.
        pass


def materialize_continuous_batch(
    db: Session,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    report: dict[str, Any],
    *,
    recover_completed_manifests: bool = False,
) -> int | None:
    return reconcile_continuous_publications(
        db,
        job,
        runtime,
        report,
        recover_completed_manifests=recover_completed_manifests,
        hooks=ContinuousBatchPublicationHooks(
            list_manifest_batch_ids=list_continuous_stream_manifest_batch_ids,
            read_manifest=read_continuous_stream_manifest,
            publish_one=materialize_continuous_publication,
            dataset_id=lambda current_job: current_job.dataset_id or make_dataset_id(current_job.target),
            list_partition_cursors=_list_continuous_stream_partition_cursors,
            merge_partition_cursors=merge_stream_partition_cursor_metrics,
        ),
    )


def _list_continuous_stream_partition_cursors(
    db: Session,
    dataset_id: str,
    topic: str,
) -> list[dict[str, Any]] | None:
    repository = DashboardLiveRepository(db, ensure_schema=False)
    list_cursors = getattr(repository, "list_stream_partition_cursors", None)
    if not callable(list_cursors):
        return None
    return list_cursors(dataset_id, topic=topic)


def write_continuous_catalog_ack(
    job_id: str,
    batch_id: int,
    *,
    document_store: RuntimeDocumentStore | None = None,
) -> None:
    report_path = continuous_runtime_report_path(job_id)
    ack_path = (
        f"{report_path.rsplit('.', 1)[0]}.catalog-ack.json"
        if isinstance(report_path, str)
        else report_path.with_suffix(".catalog-ack.json")
    )
    try:
        write_runtime_json_atomic(
            ack_path,
            {"batchId": batch_id, "acknowledgedAt": iso_now()},
            document_store=document_store,
        )
    except OSError:
        # Catalog remains the authority; a missed ack only makes the next
        # report include already-idempotent publications again.
        pass


def verify_continuous_publication_storage(
    data_path: str | None,
    manifest_path_value: str,
    *,
    require_data_marker: bool = True,
    manifest_port: ObjectManifestPort | None = None,
) -> None:
    paths = [("manifest", manifest_path_value)]
    if require_data_marker and data_path:
        paths.insert(0, ("data", data_path))
    object_store: ObjectManifestPort | None = manifest_port
    if any(re.match(r"^s3a?://", path, re.IGNORECASE) for _label, path in paths):
        object_store = object_store or object_manifest_port()
    for label, path in paths:
        try:
            if re.match(r"^s3a?://", path, re.IGNORECASE):
                parsed = urlparse(re.sub(r"^s3a://", "s3://", path, flags=re.IGNORECASE))
                bucket = parsed.netloc.strip()
                key = parsed.path.lstrip("/").rstrip("/")
                if not bucket or not key or object_store is None:
                    raise ValueError(f"Kafka publication {label} path is invalid")
                object_store.ensure_exists(bucket, f"{key}/_SUCCESS")
            elif not (Path(path) / "_SUCCESS").is_file():
                raise ValueError(f"Kafka publication {label} completion marker is missing")
        except ValueError:
            raise
        except Exception as exc:
            raise ValueError(
                f"Kafka publication {label} completion marker could not be verified: "
                f"{compact_storage_text(str(exc), limit=300)}"
            ) from exc


def list_continuous_stream_manifest_batch_ids(
    job: ETLJobModel,
    *,
    after_batch_id: int,
    through_batch_id: int | None,
    manifest_port: ObjectManifestPort | None = None,
) -> list[int] | None:
    """List completed stream manifests after the cursor, optionally through an upper bound."""
    target = parse_kafka_target_path(job.storage_path or job.target_path, job.target, job.target_layer)
    bucket = target["bucket"]
    target_prefix = target["prefix"].strip("/")
    manifest_prefix = f"{target_prefix}/_batch-manifests/"
    try:
        store = manifest_port or object_manifest_port()
        batch_ids: set[int] = set()
        for item in store.list_entries(bucket, manifest_prefix):
            match = re.search(
                r"(?:^|/)_batch-manifests/batch_id=(\d+)/_SUCCESS$",
                item.key,
            )
            if not match:
                continue
            batch_id = int(match.group(1))
            if after_batch_id < batch_id and (
                through_batch_id is None
                or batch_id <= through_batch_id
            ):
                batch_ids.add(batch_id)
        return sorted(batch_ids)
    except Exception:
        return None


def read_continuous_stream_manifest(
    job: ETLJobModel,
    batch_id: str,
    *,
    manifest_port: ObjectManifestPort | None = None,
) -> dict[str, Any] | None:
    """Recover a committed publication when the local worker report is incomplete."""
    target = parse_kafka_target_path(job.storage_path or job.target_path, job.target, job.target_layer)
    bucket = target["bucket"]
    target_prefix = target["prefix"].strip("/")
    manifest_key = f"{target_prefix}/_batch-manifests/batch_id={batch_id}"
    try:
        store = manifest_port or object_manifest_port()
        store.ensure_exists(bucket, f"{manifest_key}/_SUCCESS")
        candidate_keys = sorted(
            (
                item.key,
                item.size,
            )
            for item in store.list_entries(bucket, f"{manifest_key}/")
            if item.key.rsplit("/", 1)[-1].startswith("part-")
        )
        if not candidate_keys:
            return None
        for candidate_key, candidate_size in candidate_keys:
            # Spark JSON output can contain zero-byte task files before the
            # single part that owns the manifest row. Reading only the first
            # lexicographic part strands a durable batch outside Catalog.
            if candidate_size == 0:
                continue
            text_content = store.read_text(bucket, candidate_key)
            manifest_line = next((line for line in text_content.splitlines() if line.strip()), "")
            if not manifest_line:
                continue
            manifest = json.loads(manifest_line)
            if not isinstance(manifest, dict) or optional_string(manifest.get("batchId")) != batch_id:
                return None
            manifest["manifestPath"] = f"s3a://{bucket}/{manifest_key}"
            if nonnegative_int(manifest.get("storedCount"), 0) > 0:
                manifest.setdefault(
                    "dataPath",
                    f"s3a://{bucket}/{target_prefix}/_batches/batch_id={batch_id}",
                )
            return manifest
        return None
    except Exception:
        return None


def continuous_stream_publication_evidence(
    job: ETLJobModel,
    batch_id: str,
    publication: dict[str, Any],
    *,
    require_data: bool = True,
) -> tuple[str | None, str, list[dict[str, Any]], str]:
    evidence = continuous_stream_publication_metadata(
        job,
        batch_id,
        publication,
        require_data=require_data,
    )
    data_path, manifest_path_value, _source_ranges, _target_root = evidence
    # Iceberg data files do not expose a Spark `_SUCCESS` directory at the
    # table URI. The manifest marker is verified here; the exact snapshot is
    # verified through Trino by verify_spark_iceberg_result.
    verify_continuous_publication_storage(
        data_path,
        manifest_path_value,
        require_data_marker=False,
    )
    return evidence


def continuous_stream_publication_metadata(
    job: ETLJobModel,
    batch_id: str,
    publication: dict[str, Any],
    *,
    require_data: bool = True,
) -> tuple[str | None, str, list[dict[str, Any]], str]:
    target = parse_kafka_target_path(job.storage_path or job.target_path, job.target, job.target_layer)
    target_root = f"s3a://{target['bucket']}/{target['prefix'].strip('/')}"
    iceberg_target = IcebergWriterTarget.model_validate(job.iceberg_target)
    expected_data_path = iceberg_target.table_uri
    expected_manifest_path = f"{target_root}/_batch-manifests/batch_id={batch_id}"
    data_path = optional_string(publication.get("dataPath"))
    manifest_path_value = optional_string(publication.get("manifestPath"))
    source_ranges = normalize_kafka_source_ranges(
        publication.get("sourceRanges") if isinstance(publication.get("sourceRanges"), list) else None,
        required=True,
    )
    if require_data and data_path is None:
        raise ValueError("Kafka publication is missing its durable data path")
    if manifest_path_value is None:
        raise ValueError("Kafka publication is missing its committed manifest path")
    if data_path is not None and canonical_storage_path(data_path) != canonical_storage_path(expected_data_path):
        raise ValueError("Kafka publication data path does not match its batch identity")
    if canonical_storage_path(manifest_path_value) != canonical_storage_path(expected_manifest_path):
        raise ValueError("Kafka publication manifest path does not match its batch identity")
    return data_path, manifest_path_value, source_ranges, target_root


def trusted_legacy_replay_run_ids(
    db: Session,
    job: ETLJobModel,
) -> list[str]:
    dataset_id = job.dataset_id or make_dataset_id(job.target)
    dataset = etl_repository.get_dataset_by_id(db, dataset_id)
    runs = ((dataset.payload or {}).get("materializationRuns") or []) if dataset is not None else []
    trusted: set[str] = set()
    for run in runs:
        if not isinstance(run, dict) or str(run.get("status") or "").strip().lower() != "success":
            continue
        if optional_string(run.get("publicationManifest")):
            continue
        storage_location = optional_string(run.get("storageLocation"))
        if storage_location is None:
            continue
        match = re.search(r"/batch_id=replay_([^/]+)$", canonical_storage_path(storage_location))
        if match:
            trusted.add(match.group(1))
    return sorted(trusted)


def materialize_continuous_publication(
    db: Session,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    publication: dict[str, Any],
) -> bool:
    return execute_continuous_publication(
        db,
        job,
        runtime,
        publication,
        hooks=ContinuousPublicationHooks(
            prepare=_prepare_continuous_publication,
            verify_output=_verify_continuous_publication_output,
            verify_manifest=_verify_continuous_publication_manifest,
            register_catalog=_register_continuous_publication_catalog,
            publish_dashboard=_publish_continuous_dashboard_revision,
            update_job_stats=_update_continuous_publication_stats,
            compact_error=lambda value: compact_storage_text(str(value), limit=500),
        ),
    )


def _prepare_continuous_publication(
    job: ETLJobModel,
    _runtime: KafkaContinuousRuntimeModel,
    publication: dict[str, Any],
    identity: PublicationIdentity,
) -> PublicationInputEvidence:
    data_path, manifest_path_value, source_ranges, _target_root = continuous_stream_publication_metadata(
        job,
        str(identity.batch_id),
        publication,
        require_data=nonnegative_int(publication.get("storedCount"), 0) > 0,
    )
    return PublicationInputEvidence(
        data_path=data_path,
        manifest_path=manifest_path_value,
        source_ranges=source_ranges,
    )


def _verify_continuous_publication_output(
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    publication: dict[str, Any],
    identity: PublicationIdentity,
    inputs: PublicationInputEvidence,
) -> PublicationOutputEvidence:
    if inputs.data_path is None:
        raise ValueError("Kafka publication is missing its durable data path")
    target = IcebergWriterTarget.model_validate(job.iceberg_target)
    commit = publication.get("icebergCommit") if isinstance(publication.get("icebergCommit"), dict) else None
    source_boundary = publication.get("sourceBoundary") if isinstance(publication.get("sourceBoundary"), dict) else None
    committed_boundary = (
        commit.get("sourceBoundary")
        if isinstance(commit, dict) and isinstance(commit.get("sourceBoundary"), dict)
        else None
    )
    if not commit or not source_boundary or committed_boundary != source_boundary:
        raise ValueError("Continuous publication does not include matching Iceberg source-boundary evidence.")
    if any((
        source_boundary.get("kind") != "kafka_continuous_batch",
        str(source_boundary.get("jobId") or "") != job.id,
        optional_int(source_boundary.get("batchId")) != identity.batch_id,
        str(source_boundary.get("runId") or "") != identity.run_id,
        str(source_boundary.get("checkpointPath") or "").rstrip("/") != str(runtime.checkpoint_path or "").rstrip("/"),
        str(source_boundary.get("consumerGroupId") or "") != runtime.consumer_group_id,
        str(source_boundary.get("topic") or "") != runtime.topic,
        normalize_kafka_source_ranges(source_boundary.get("sourceRanges"), required=True) != inputs.source_ranges,
        not str(source_boundary.get("boundaryId") or "").strip(),
    )):
        raise ValueError("Continuous publication source boundary does not match the persisted runtime.")
    stored_count = nonnegative_int(publication.get("storedCount"), 0)
    result = {
        "endedAt": optional_string(publication.get("publishedAt")) or runtime.last_flush_at or runtime.heartbeat_at or iso_now(),
        "icebergCommit": commit,
        "materializationRows": stored_count,
        "outputPath": target.table_uri,
        "outputRows": runtime.stored_count,
        "publicationManifest": inputs.manifest_path,
        "quality": publication.get("quality") if isinstance(publication.get("quality"), dict) else {},
        "ruleContractVersion": optional_string(publication.get("ruleContractVersion")),
        "ruleFingerprint": optional_string(publication.get("ruleFingerprint")),
        "runId": identity.run_id,
        "runtimeFingerprint": optional_string(publication.get("runtimeFingerprint")),
        "schemaFingerprint": optional_string(publication.get("schemaFingerprint")),
        "sourceBoundary": source_boundary,
        "sourceKind": "kafka",
        "sourceRanges": inputs.source_ranges,
        "status": "success",
        "transform": publication.get("transform") if isinstance(publication.get("transform"), dict) else {},
    }
    verified = verify_spark_iceberg_result(
        job,
        identity.run_id,
        result,
        expected_run_row_count=stored_count,
    )
    return PublicationOutputEvidence(
        target_uri=target.table_uri,
        verified_result={**verified, "sourceBoundary": source_boundary},
    )


def _verify_continuous_publication_manifest(
    _job: ETLJobModel,
    _publication: dict[str, Any],
    inputs: PublicationInputEvidence,
) -> None:
    verify_continuous_publication_storage(
        inputs.data_path,
        inputs.manifest_path,
        require_data_marker=False,
    )


def _register_continuous_publication_catalog(
    db: Session,
    job: ETLJobModel,
    _runtime: KafkaContinuousRuntimeModel,
    publication: dict[str, Any],
    identity: PublicationIdentity,
    _inputs: PublicationInputEvidence,
    output: PublicationOutputEvidence | None,
) -> PublicationCatalogEvidence:
    dataset_id = job.dataset_id or make_dataset_id(job.target)
    if output is None:
        return PublicationCatalogEvidence(
            dataset_id=dataset_id,
            materialization_mode="delta",
            catalog_created=False,
            catalog_skipped=True,
        )
    live_repository = DashboardLiveRepository(db, ensure_schema=False)
    live_repository.lock_dataset_publication_identity(dataset_id)
    existing = etl_repository.get_dataset_by_id_for_update(db, dataset_id)
    existing_runs = (
        ((existing.payload or {}).get("materializationRuns") or [])
        if existing and existing.payload
        else []
    )
    existing_run = next(
        (
            item
            for item in existing_runs
            if isinstance(item, dict) and str(item.get("runId") or "") == identity.run_id
        ),
        None,
    )
    target = IcebergWriterTarget.model_validate(job.iceberg_target)
    existing_mapping = (existing.payload or {}).get("queryEngineTable") if existing and existing.payload else None
    same_mapping = isinstance(existing_mapping, dict) and all(
        str(existing_mapping.get(key) or "") == expected
        for key, expected in (
            ("catalog", target.catalog),
            ("schema", target.namespace),
            ("table", target.table),
            ("format", "iceberg"),
        )
    )
    computed_mode = "delta" if same_mapping else "snapshot"
    existing_mode = str((existing_run or {}).get("materializationMode") or "").strip().lower()
    materialization_mode = existing_mode if existing_mode in {"delta", "snapshot"} else computed_mode
    verified = {
        **output.verified_result,
        "materializationMode": materialization_mode,
    }
    catalog_created = existing_run is None
    if catalog_created:
        etl_repository.save_dataset(
            db,
            dataset_from_spark_result(job, verified, existing),
        )
    else:
        # Release the publication identity lock before Dashboard publication.
        db.commit()
    return PublicationCatalogEvidence(
        dataset_id=dataset_id,
        materialization_mode=materialization_mode,
        catalog_created=catalog_created,
    )


def _publish_continuous_dashboard_revision(
    db: Session,
    job: ETLJobModel,
    _runtime: KafkaContinuousRuntimeModel,
    publication: dict[str, Any],
    identity: PublicationIdentity,
    inputs: PublicationInputEvidence,
    output: PublicationOutputEvidence | None,
    catalog: PublicationCatalogEvidence,
) -> None:
    live_repository = DashboardLiveRepository(db, ensure_schema=False)
    live_repository.lock_dataset_publication_identity(catalog.dataset_id)
    if output is None:
        live_repository.record_stream_progress(catalog.dataset_id, inputs.source_ranges)
        db.commit()
        return
    dataset = etl_repository.get_dataset_by_id_for_update(db, catalog.dataset_id)
    if dataset is None:
        raise ValueError("Catalog dataset is missing after Continuous materialization.")
    existing_runs = ((dataset.payload or {}).get("materializationRuns") or []) if dataset.payload else []
    existing_run = next(
        (
            item
            for item in existing_runs
            if isinstance(item, dict) and str(item.get("runId") or "") == identity.run_id
        ),
        None,
    )
    if existing_run is None:
        raise ValueError("Catalog materialization run is missing before Dashboard publication.")
    next_check_after_ms = recommended_dashboard_poll_ms(
        (job.continuous_config or {}).get("triggerIntervalSeconds")
    )
    existing_commit = live_repository.commit_by_run_id(identity.run_id)
    if existing_commit is None and not catalog.catalog_created:
        # A Catalog run that predates the staged workflow becomes a safe full
        # Dashboard baseline before later stream deltas are applied.
        backfill_catalog_revision(
            db,
            dataset_id=dataset.id,
            run_id=identity.run_id,
            storage_location=str(output.verified_result["materializationOutputPath"]),
            storage_format="iceberg",
            materialization_mode="snapshot",
            row_count=nonnegative_int(existing_run.get("rowCount"), nonnegative_int(publication.get("storedCount"), 0)),
            next_check_after_ms=next_check_after_ms,
            source_ranges=inputs.source_ranges,
            manifest_location=inputs.manifest_path,
        )
        return
    existing_commit_kind = str(
        existing_commit.get("commit_kind")
        if isinstance(existing_commit, dict)
        else getattr(existing_commit, "commit_kind", "")
    )
    if existing_commit is None or existing_commit_kind == STREAM_COMMIT_KIND:
        live_repository.record_dataset_commit(
            dataset_id=dataset.id,
            run_id=identity.run_id,
            storage_location=str(output.verified_result["materializationOutputPath"]),
            storage_format="iceberg",
            materialization_mode=catalog.materialization_mode,
            row_count=nonnegative_int(publication.get("storedCount"), 0),
            next_check_after_ms=next_check_after_ms,
            source_ranges=inputs.source_ranges,
            commit_kind=STREAM_COMMIT_KIND,
            manifest_location=inputs.manifest_path,
        )
    db.commit()


def _update_continuous_publication_stats(
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    output: PublicationOutputEvidence | None,
) -> None:
    if output is None:
        return
    job.stats = {
        **(job.stats or {}),
        "inputRows": format_rows(runtime.consumed_count),
        "lastSuccess": runtime.last_flush_at or runtime.heartbeat_at or "-",
        "outputPath": output.target_uri,
        "outputRows": format_rows(runtime.stored_count),
        "icebergSnapshotId": str(output.verified_result.get("icebergCommit", {}).get("snapshotId") or ""),
        "sampleScope": f"{runtime.topic} continuous micro-batch",
        "sourceUnits": "Kafka topic",
        "successRate": "100%" if runtime.failed_count == 0 else "확인 필요",
    }


def normalize_continuous_source_ranges(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return sorted(
        [
            {
                "endOffset": int(item.get("endOffset") or 0),
                "partition": int(item.get("partition") or 0),
                "startOffset": int(item.get("startOffset") or 0),
                "topic": str(item.get("topic") or ""),
            }
            for item in value
            if isinstance(item, dict)
        ],
        key=lambda item: (item["topic"], item["partition"]),
    )


EXPORTED_FUNCTIONS = (
    'continuous_worker_status',
    'continuous_heartbeat_is_stale',
    'continuous_failure_identity',
    'stop_stale_continuous_worker',
    'materialize_continuous_batch',
    '_list_continuous_stream_partition_cursors',
    'write_continuous_catalog_ack',
    'verify_continuous_publication_storage',
    'list_continuous_stream_manifest_batch_ids',
    'read_continuous_stream_manifest',
    'continuous_stream_publication_evidence',
    'continuous_stream_publication_metadata',
    'trusted_legacy_replay_run_ids',
    'materialize_continuous_publication',
    '_prepare_continuous_publication',
    '_verify_continuous_publication_output',
    '_verify_continuous_publication_manifest',
    '_register_continuous_publication_catalog',
    '_publish_continuous_dashboard_revision',
    '_update_continuous_publication_stats',
    'normalize_continuous_source_ranges',
)

IMPLEMENTATIONS = {name: globals()[name] for name in EXPORTED_FUNCTIONS}
