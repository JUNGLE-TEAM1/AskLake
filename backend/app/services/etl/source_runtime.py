"""Incremental source and runtime document operations behind the ETL facade."""

from __future__ import annotations

RUNTIME_NAMES = {
    'ACTIVE_RUN_STATUSES',
    'ApiError',
    'BACKEND_DIR',
    'Boto3ObjectManifestAdapter',
    'Boto3RuntimeDocumentStore',
    'DashboardLiveRepository',
    'Exception',
    'IcebergWriterTarget',
    'JsonFileRuntimeDocumentStore',
    'Path',
    'RuntimeError',
    'SCRIPTS_DIR',
    'SPARK_REST_BRIDGE_GRACE_SECONDS',
    'SubprocessNodeBridge',
    'TypeError',
    'ValueError',
    'active_materialization_runs',
    'any',
    'apply_job_state_from_latest_run',
    'bool',
    'bounded_environment_integer',
    'build_airflow_client',
    'build_catalog_s3_client',
    'callable',
    'compact_storage_text',
    'continuous_maintenance_result_file',
    'continuous_maintenance_state_file',
    'continuous_replay_result_is_durable',
    'dict',
    'etl_repository',
    'getattr',
    'has_bounded_source_window',
    'incremental_source_object_inventory',
    'int',
    'isinstance',
    'iso_now',
    'json',
    'len',
    'list',
    'list_incremental_s3_object_inventory',
    'make_dataset_id',
    'materialization_source_window',
    'max',
    'next',
    'nonnegative_int',
    'normalize_kafka_source_ranges',
    'object_manifest_port',
    'optional_int',
    'optional_string',
    'os',
    'parse_kafka_target_path',
    'prior_incremental_source_object_keys',
    're',
    'read_continuous_maintenance_result_candidate',
    'read_continuous_replay_manifest',
    'read_runtime_json',
    'runtime_document_store_for_path',
    'repair_incomplete_airflow_successes',
    'reversed',
    'run_node_bridge',
    's3_object_is_confirmed_missing',
    'set',
    'settings',
    'sorted',
    'source_incremental_since',
    'source_uses_incremental_folder_window',
    'stats_from_runs',
    'status',
    'str',
    'sync_airflow_run',
}


def source_incremental_since(db: Session, job: ETLJobModel, current_run_id: str) -> str | None:
    if not source_uses_incremental_folder_window(job):
        return None
    successful_runs = [
        run
        for run in etl_repository.list_run_models_for_job(db, job.id)
        if run.run_id != current_run_id
        and run.status == "success"
        and str(run.started_at or "").strip() not in {"", "-"}
    ]
    if not successful_runs:
        return None
    latest_successful_run = max(successful_runs, key=lambda run: str(run.started_at))
    dataset_id = str(getattr(job, "dataset_id", "") or "").strip()
    dataset = etl_repository.get_dataset_by_id(db, dataset_id) if dataset_id else None
    payload = dataset.payload if dataset is not None and isinstance(dataset.payload, dict) else {}
    materialization_runs = payload.get("materializationRuns")
    matching_run = next((
        run
        for run in materialization_runs
        if isinstance(run, dict) and str(run.get("runId") or "") == str(latest_successful_run.run_id)
    ), None) if isinstance(materialization_runs, list) else None
    if matching_run is None or not has_bounded_source_window(matching_run):
        return None
    window = materialization_source_window(matching_run) or {}
    object_keys = window.get("objectKeys") if "objectKeys" in window else window.get("object_keys")
    if not isinstance(object_keys, list):
        return None
    return str(window.get("upperBound") or window.get("upper_bound") or "").strip() or None


def source_incremental_window(
    db: Session,
    job: ETLJobModel,
    current_run_id: str,
) -> tuple[str | None, str | None]:
    if not source_uses_incremental_folder_window(job):
        return None, None
    lower_bound = source_incremental_since(db, job, current_run_id)
    current_run = etl_repository.get_run_model(db, current_run_id)
    upper_bound = (
        str(current_run.started_at)
        if current_run and str(current_run.started_at or "").strip() not in {"", "-"}
        else None
    )
    return lower_bound, upper_bound


def incremental_source_object_inventory(
    db: Session,
    job: ETLJobModel,
    *,
    incremental_since: str | None,
    incremental_before: str | None,
    s3_client: Any | None = None,
) -> list[dict[str, Any]] | None:
    if not source_uses_incremental_folder_window(job):
        return None
    inventory = list_incremental_s3_object_inventory(
        job,
        incremental_since=incremental_since,
        incremental_before=incremental_before,
        s3_client=s3_client,
    )
    current_keys = [str(item["key"]) for item in inventory]
    if incremental_since:
        previous_keys = prior_incremental_source_object_keys(db, job)
        duplicate_keys = sorted(set(current_keys).intersection(previous_keys))
        if duplicate_keys:
            raise ApiError(
                "SOURCE_OBJECT_KEY_REPLACED",
                "Incremental folder collection accepts new object keys only; replace the dataset with a full run after modifying an existing key.",
                status.HTTP_409_CONFLICT,
                {
                    "duplicateObjectKeys": duplicate_keys[:20],
                    "duplicateObjectCount": len(duplicate_keys),
                    "jobId": job.id,
                },
            )
    return inventory


def incremental_source_object_keys(
    db: Session,
    job: ETLJobModel,
    *,
    incremental_since: str | None,
    incremental_before: str | None,
    s3_client: Any | None = None,
) -> list[str] | None:
    inventory = incremental_source_object_inventory(
        db,
        job,
        incremental_since=incremental_since,
        incremental_before=incremental_before,
        s3_client=s3_client,
    )
    return [str(item["key"]) for item in inventory] if inventory is not None else None


def list_incremental_s3_object_keys(
    job: ETLJobModel,
    *,
    incremental_since: str | None,
    incremental_before: str | None,
    s3_client: Any | None = None,
) -> list[str]:
    return [
        str(item["key"])
        for item in list_incremental_s3_object_inventory(
            job,
            incremental_since=incremental_since,
            incremental_before=incremental_before,
            s3_client=s3_client,
        )
    ]


def prior_incremental_source_object_keys(db: Session, job: ETLJobModel) -> set[str]:
    dataset_id = str(getattr(job, "dataset_id", "") or "").strip()
    dataset = etl_repository.get_dataset_by_id(db, dataset_id) if dataset_id else None
    payload = dataset.payload if dataset is not None and isinstance(dataset.payload, dict) else {}
    runs = payload.get("materializationRuns")
    active_runs = active_materialization_runs(
        run for run in runs if isinstance(run, dict)
    ) if isinstance(runs, list) else []
    return {
        str(key)
        for run in active_runs
        for window in [materialization_source_window(run) or {}]
        for key in (window.get("objectKeys") or window.get("object_keys") or [])
        if str(key).strip()
    }


def allows_unconfigured_s3_source() -> bool:
    return str(getattr(settings, "app_env", "local") or "local").strip().casefold() in {
        "dev",
        "development",
        "local",
        "test",
    }


def sync_airflow_runs_for_job(db: Session, job: ETLJobModel) -> None:
    runs = etl_repository.list_run_models_for_job(db, job.id)
    dataset_id = job.dataset_id or make_dataset_id(job.target)
    dataset = etl_repository.get_dataset_by_id(db, dataset_id)
    repaired_success = repair_incomplete_airflow_successes(runs, dataset)
    active_runs = [
        run
        for run in runs
        if run.status in ACTIVE_RUN_STATUSES and run.airflow_dag_run_id
    ]
    if not active_runs:
        if repaired_success and runs:
            apply_job_state_from_latest_run(job, runs[0])
            job.stats = stats_from_runs(job, [etl_repository.run_to_schema(run) for run in runs])
            etl_repository.save_job(db, job)
        return

    try:
        airflow_client = build_airflow_client()
    except ApiError as exc:
        sync_error = exc.message
        synced_at = iso_now()
        locked_job = etl_repository.get_job_for_update(db, job.id)
        if locked_job is None:
            db.rollback()
            return
        for active_run in sorted(active_runs, key=lambda item: item.run_id):
            locked_run = etl_repository.get_run_model(db, active_run.run_id)
            if locked_run is None:
                continue
            etl_repository.refresh_run_for_update(db, locked_run)
            locked_run.sync_error = sync_error
            locked_run.last_synced_at = synced_at
        job = locked_job
        job.last_state = f"Airflow 상태 동기화 실패 · {sync_error}"
        etl_repository.save_job(db, job)
        return

    for run in active_runs:
        sync_airflow_run(db, job, run, airflow_client, dataset)

    job = etl_repository.get_job_for_update(db, job.id)
    if job is None:
        db.rollback()
        return
    runs = etl_repository.list_run_models_for_job(db, job.id)
    latest_run = runs[0]
    apply_job_state_from_latest_run(job, latest_run)
    job.stats = stats_from_runs(job, [etl_repository.run_to_schema(run) for run in runs])
    etl_repository.save_job(db, job)


def run_node_bridge(
    script_name: str,
    success_marker: str,
    payload: dict[str, Any],
    *,
    error_marker: str,
    timeout_seconds: int,
    timeout_recovery: Callable[[], dict[str, Any]] | None = None,
    bridge: NodeBridgePort | None = None,
) -> dict[str, Any]:
    runtime_bridge = bridge or SubprocessNodeBridge(
        backend_dir=BACKEND_DIR,
        scripts_dir=SCRIPTS_DIR,
    )
    return runtime_bridge.execute(
        script_name,
        success_marker,
        payload,
        error_marker=error_marker,
        timeout_seconds=timeout_seconds,
        timeout_recovery=timeout_recovery,
    )


def recover_spark_rest_submission(
    state_file: Path,
    *,
    bridge: NodeBridgePort | None = None,
) -> dict[str, Any]:
    try:
        return run_node_bridge(
            "spark-rest-client.mjs",
            "ASKLAKE_SPARK_REST_RECOVERY",
            {
                "operation": "kill-state",
                "restUrl": os.environ.get("ASKLAKE_SPARK_REST_URL") or "http://spark-master:6066",
                "stateFile": str(state_file),
            },
            error_marker="ASKLAKE_SPARK_REST_ERROR",
            timeout_seconds=10,
            bridge=bridge,
        )
    except ApiError as exc:
        raise RuntimeError(exc.message) from exc


def spark_rest_mode_enabled() -> bool:
    return str(os.environ.get("ASKLAKE_SPARK_RUNNER") or "").strip().lower() == "rest"


def spark_rest_poll_timeout_ms() -> int:
    timeout_seconds = bounded_environment_integer(
        "ASKLAKE_SPARK_RUN_TIMEOUT_SECONDS",
        default=7200,
        minimum=1,
        maximum=24 * 60 * 60,
    )
    return timeout_seconds * 1000


def spark_python_bridge_timeout_seconds(poll_timeout_ms: int) -> int:
    poll_timeout_seconds = (max(1000, int(poll_timeout_ms)) + 999) // 1000
    return poll_timeout_seconds + (2 * SPARK_REST_BRIDGE_GRACE_SECONDS)


def continuous_maintenance_poll_timeout_ms() -> int:
    return bounded_environment_integer(
        "ASKLAKE_CONTINUOUS_MAINTENANCE_TIMEOUT_MS",
        default=540_000,
        minimum=1000,
        maximum=24 * 60 * 60 * 1000,
    )


def continuous_maintenance_bridge_timeout_seconds(poll_timeout_ms: int) -> int:
    poll_timeout_seconds = (max(1000, int(poll_timeout_ms)) + 999) // 1000
    return poll_timeout_seconds + SPARK_REST_BRIDGE_GRACE_SECONDS


def spark_rest_submission_state_file(run_id: str) -> Path:
    report_dir = Path(os.environ.get("ASKLAKE_SPARK_REPORT_DIR") or BACKEND_DIR / "tmp" / "spark-runs")
    if not report_dir.is_absolute():
        report_dir = BACKEND_DIR / report_dir
    safe_run_id = re.sub(r"[^a-zA-Z0-9_.-]+", "-", str(run_id)).strip("-") or "run"
    return (report_dir.resolve() / f"{safe_run_id.lower()}.spark-rest-state.json")


def continuous_maintenance_state_file(run_id: str) -> Path:
    report_dir = Path(os.environ.get("ASKLAKE_SPARK_REPORT_DIR") or BACKEND_DIR / "tmp" / "spark-runs")
    if not report_dir.is_absolute():
        report_dir = BACKEND_DIR / report_dir
    safe_run_id = re.sub(r"[^a-zA-Z0-9_.-]+", "-", str(run_id)).strip("-") or "run"
    return (report_dir.resolve() / f"kafka-continuous-maintenance-{safe_run_id.lower()}.state.json")


def continuous_maintenance_result_file(run_id: str) -> Path:
    state_path = continuous_maintenance_state_file(run_id)
    return state_path.with_name(state_path.name.replace(".state.json", ".result.json"))


def read_continuous_maintenance_result(run_id: str) -> dict[str, Any] | None:
    result = read_continuous_maintenance_result_candidate(run_id)
    if result is None:
        return None
    result_run_id = optional_string(result.get("runId"))
    if result_run_id is not None and result_run_id != run_id:
        return None
    return result


def read_continuous_maintenance_result_candidate(run_id: str) -> dict[str, Any] | None:
    result_path = continuous_maintenance_result_file(run_id)
    document = read_runtime_json(result_path)
    return dict(document.value) if document.found and document.value is not None else None


def continuous_replay_result_is_durable(result: dict[str, Any]) -> bool:
    return bool(
        nonnegative_int(result.get("storedCount"), 0) > 0
        and optional_string(result.get("outputPath"))
        and optional_string(result.get("manifestPath"))
    )


def s3_object_is_confirmed_missing(exc: Exception) -> bool:
    response = getattr(exc, "response", None)
    if not isinstance(response, dict):
        return False
    error = response.get("Error") if isinstance(response.get("Error"), dict) else {}
    metadata = (
        response.get("ResponseMetadata")
        if isinstance(response.get("ResponseMetadata"), dict)
        else {}
    )
    code = str(error.get("Code") or "").strip().casefold()
    http_status = optional_int(metadata.get("HTTPStatusCode"))
    return http_status == 404 or code in {"404", "nosuchkey", "notfound"}


def read_continuous_replay_manifest(
    job: ETLJobModel,
    run_id: str,
    *,
    manifest_port: ObjectManifestPort | None = None,
) -> tuple[str, dict[str, Any] | None, str | None]:
    """Read exact replay evidence from S3.

    ``missing`` is returned only when S3 confirms that ``_SUCCESS`` does not
    exist. Access, parsing, and identity failures are ``unavailable`` so a
    stream restart cannot overtake a replay whose Iceberg commit may exist.
    """
    target = parse_kafka_target_path(
        job.storage_path or job.target_path,
        job.target,
        job.target_layer,
    )
    bucket = target["bucket"]
    target_prefix = target["prefix"].strip("/")
    manifest_key = f"{target_prefix}/_replay-manifests/run_id={run_id}"
    manifest_path = f"s3a://{bucket}/{manifest_key}"
    try:
        iceberg_target = IcebergWriterTarget.model_validate(job.iceberg_target)
        store = manifest_port or object_manifest_port()
        try:
            store.ensure_exists(bucket, f"{manifest_key}/_SUCCESS")
        except Exception as exc:
            if s3_object_is_confirmed_missing(exc):
                return "missing", None, None
            raise
        candidate_keys = sorted(
            item.key
            for item in store.list_entries(bucket, f"{manifest_key}/")
            if item.key.rsplit("/", 1)[-1].startswith("part-")
        )
        if not candidate_keys:
            raise ValueError("Replay manifest completion marker has no payload.")
        manifest_line = ""
        for candidate_key in candidate_keys:
            text_content = store.read_text(bucket, candidate_key)
            manifest_line = next((line for line in text_content.splitlines() if line.strip()), "")
            if manifest_line:
                break
        if not manifest_line:
            raise ValueError("Replay manifest payload is empty.")
        manifest = json.loads(manifest_line)
        if not isinstance(manifest, dict):
            raise ValueError("Replay manifest payload is not an object.")
        source_ranges = normalize_kafka_source_ranges(
            manifest.get("sourceRanges") if isinstance(manifest.get("sourceRanges"), list) else None,
            required=True,
        )
        source_boundary = (
            manifest.get("sourceBoundary")
            if isinstance(manifest.get("sourceBoundary"), dict)
            else None
        )
        iceberg_commit = (
            manifest.get("icebergCommit")
            if isinstance(manifest.get("icebergCommit"), dict)
            else None
        )
        committed_boundary = (
            iceberg_commit.get("sourceBoundary")
            if isinstance(iceberg_commit, dict)
            and isinstance(iceberg_commit.get("sourceBoundary"), dict)
            else None
        )
        data_path = optional_string(manifest.get("dataPath"))
        if any((
            optional_string(manifest.get("publicationId")) != f"replay:{run_id}",
            optional_string(manifest.get("publicationType")) != "replay",
            optional_string(manifest.get("runId")) != run_id,
            nonnegative_int(manifest.get("storedCount"), 0) <= 0,
            data_path is None,
            data_path != iceberg_target.table_uri,
            source_boundary is None,
            source_boundary.get("kind") != "kafka_continuous_replay" if source_boundary else True,
            str(source_boundary.get("jobId") or "") != job.id if source_boundary else True,
            str(source_boundary.get("runId") or "") != run_id if source_boundary else True,
            normalize_kafka_source_ranges(
                source_boundary.get("sourceRanges") if source_boundary else None,
                required=True,
            ) != source_ranges,
            iceberg_commit is None,
            committed_boundary != source_boundary,
        )):
            raise ValueError("Replay manifest identity does not match the requested run.")
        return "found", {
            **manifest,
            "manifestPath": manifest_path,
            "outputPath": data_path,
            "runId": run_id,
            "sourceRanges": source_ranges,
        }, None
    except Exception as exc:
        return "unavailable", None, compact_storage_text(str(exc), limit=500)


def recover_continuous_replay_result(
    job: ETLJobModel | None,
    run_id: str,
    current_result: Any = None,
) -> tuple[str, dict[str, Any], str | None]:
    current = dict(current_result or {}) if isinstance(current_result, dict) else {}
    current_run_id = optional_string(current.get("runId"))
    if current_run_id is not None and current_run_id != run_id:
        return "unavailable", current, "Stored replay result has a different run identity."
    current["runId"] = run_id
    if continuous_replay_result_is_durable(current):
        return "found", current, None

    local_result = read_continuous_maintenance_result_candidate(run_id)
    if isinstance(local_result, dict):
        local_run_id = optional_string(local_result.get("runId"))
        if local_run_id is not None and local_run_id != run_id:
            return "unavailable", current, "Local replay result has a different run identity."
        recovered = {**local_result, "runId": run_id}
        if continuous_replay_result_is_durable(recovered):
            for key in ("catalogApplied", "countersApplied"):
                if key in current:
                    recovered[key] = current[key]
            return "found", recovered, None

    if job is None:
        return "unavailable", current, "Replay Job metadata is unavailable."
    state, manifest_result, reason = read_continuous_replay_manifest(job, run_id)
    if state != "found" or manifest_result is None:
        return state, current, reason
    for key in ("catalogApplied", "countersApplied"):
        if key in current:
            manifest_result[key] = current[key]
    return "found", manifest_result, None


def bounded_environment_integer(name: str, *, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name) or default)
    except (TypeError, ValueError):
        return default
    return value if minimum <= value <= maximum else default


def read_runtime_json(
    path: Path | str,
    *,
    document_store: RuntimeDocumentStore | None = None,
) -> JsonDocument:
    store = document_store or runtime_document_store_for_path(path)
    return store.read_json(path)


def write_runtime_json_atomic(
    path: Path | str,
    payload: dict[str, Any],
    *,
    document_store: RuntimeDocumentStore | None = None,
) -> None:
    store = document_store or runtime_document_store_for_path(path)
    store.write_json_atomic(path, payload)


def runtime_document_store_for_path(path: Path | str) -> RuntimeDocumentStore:
    if isinstance(path, str) and re.match(r"^s3a?://", path, re.IGNORECASE):
        return Boto3RuntimeDocumentStore(build_catalog_s3_client())
    return JsonFileRuntimeDocumentStore()


def object_manifest_port(client: Any | None = None) -> ObjectManifestPort:
    return Boto3ObjectManifestAdapter(client or build_catalog_s3_client())


def marker_payload(output: str, marker: str) -> dict[str, Any] | None:
    prefix = f"{marker}="
    for line in reversed(str(output or "").splitlines()):
        if line.startswith(prefix):
            return json.loads(line[len(prefix):])
    return None


def persisted_stream_partition_cursors(
    db: Session | None,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
) -> list[dict[str, Any]]:
    if db is None or not callable(getattr(db, "scalars", None)):
        cursors = (runtime.metrics or {}).get("streamPartitionCursors")
        return [dict(item) for item in cursors if isinstance(item, dict)] if isinstance(cursors, list) else []
    dataset_id = job.dataset_id or make_dataset_id(job.target)
    return DashboardLiveRepository(
        db,
        ensure_schema=False,
    ).list_stream_partition_cursors(dataset_id, topic=runtime.topic)


def merge_stream_partition_cursor_metrics(
    current: Any,
    source_ranges: Any,
) -> list[dict[str, Any]]:
    merged: dict[tuple[str, int], int] = {}
    candidates: list[tuple[dict[str, Any], str]] = []
    if isinstance(current, list):
        candidates.extend((item, "nextOffset") for item in current if isinstance(item, dict))
    if isinstance(source_ranges, list):
        candidates.extend((item, "endOffset") for item in source_ranges if isinstance(item, dict))
    for item, offset_key in candidates:
        topic = str(item.get("topic") or "").strip()
        try:
            partition = int(item.get("partition"))
            next_offset = int(item.get(offset_key))
        except (TypeError, ValueError):
            continue
        if not topic or partition < 0 or next_offset < 0:
            continue
        key = (topic, partition)
        merged[key] = max(merged.get(key, 0), next_offset)
    return [
        {"topic": topic, "partition": partition, "nextOffset": next_offset}
        for (topic, partition), next_offset in sorted(merged.items())
    ]


EXPORTED_FUNCTIONS = (
    'source_incremental_since',
    'source_incremental_window',
    'incremental_source_object_inventory',
    'incremental_source_object_keys',
    'list_incremental_s3_object_keys',
    'prior_incremental_source_object_keys',
    'allows_unconfigured_s3_source',
    'sync_airflow_runs_for_job',
    'run_node_bridge',
    'recover_spark_rest_submission',
    'spark_rest_mode_enabled',
    'spark_rest_poll_timeout_ms',
    'spark_python_bridge_timeout_seconds',
    'continuous_maintenance_poll_timeout_ms',
    'continuous_maintenance_bridge_timeout_seconds',
    'spark_rest_submission_state_file',
    'continuous_maintenance_state_file',
    'continuous_maintenance_result_file',
    'read_continuous_maintenance_result',
    'read_continuous_maintenance_result_candidate',
    'continuous_replay_result_is_durable',
    's3_object_is_confirmed_missing',
    'read_continuous_replay_manifest',
    'recover_continuous_replay_result',
    'bounded_environment_integer',
    'read_runtime_json',
    'write_runtime_json_atomic',
    'runtime_document_store_for_path',
    'object_manifest_port',
    'marker_payload',
    'persisted_stream_partition_cursors',
    'merge_stream_partition_cursor_metrics',
)

IMPLEMENTATIONS = {name: globals()[name] for name in EXPORTED_FUNCTIONS}
