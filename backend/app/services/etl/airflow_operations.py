"""Spark and Airflow execution operations behind the ETL facade."""

from __future__ import annotations

RUNTIME_NAMES = {
    'AirflowCatalogReconciliationHooks',
    'AirflowDagRun',
    'AirflowRunExecutionResponse',
    'AirflowSparkExecutionHooks',
    'ApiError',
    'DEFAULT_SPARK_EXECUTION_LEASE_SECONDS',
    'ErrorCode',
    'Exception',
    'IcebergWriterTarget',
    'ImportError',
    'Path',
    'SOURCE_WINDOW_CONTRACT_VERSION',
    'UTC',
    'ValueError',
    'airflow_catalog_reconciliation_hooks',
    'airflow_dag_run_conf',
    'airflow_execution_response',
    'airflow_execution_response_from_persisted',
    'airflow_run_has_materialization',
    'airflow_spark_execution_hooks',
    'apply_spark_result_to_airflow_run',
    'build_airflow_client',
    'build_catalog_s3_client',
    'build_iceberg_writer_target',
    'canonical_rule_fingerprint',
    'canonical_storage_path',
    'catalog_reconciliation_error',
    'compact_storage_text',
    'compile_job_rules',
    'dataset_from_spark_result',
    'datetime',
    'dict',
    'ensure_batch_iceberg_target',
    'etl_repository',
    'execute_airflow_catalog_commit',
    'execute_airflow_catalog_reconciliation',
    'execute_airflow_spark_command',
    'finalize_airflow_spark_attempt',
    'finalize_job_from_spark_result',
    'format_duration_ms',
    'format_rows',
    'incremental_source_object_inventory',
    'inspect_s3_spark_output',
    'inspect_spark_output',
    'int',
    'is_internal_data_lake_source',
    'is_kafka_job',
    'isinstance',
    'iso_now',
    'job_payload_for_spark',
    'len',
    'list',
    'make_dataset_id',
    'max',
    'normalize_spark_output_storage_path',
    'normalize_string_list',
    'object_storage_runtime',
    'optional_string',
    'os',
    'parse_count_value',
    'parse_incremental_timestamp',
    'parse_optional_integer',
    're',
    'record_airflow_catalog_failure',
    'recover_spark_rest_submission',
    'require_airflow_internal_token',
    'require_compiled_rules',
    'resolve_airflow_catalog_identity',
    'resolve_internal_data_lake_source',
    'run_from_airflow_submit',
    'run_from_spark_result',
    'run_node_bridge',
    'run_spark_job',
    'secrets',
    'settings',
    'source_incremental_window',
    'source_uses_incremental_folder_window',
    'spark_error_summary',
    'spark_execution_lease_is_active',
    'spark_execution_lease_seconds',
    'spark_failed_stage',
    'spark_python_bridge_timeout_seconds',
    'spark_rest_mode_enabled',
    'spark_rest_poll_timeout_ms',
    'spark_rest_submission_state_file',
    'spark_result_manifest',
    'stable_id',
    'stats_from_runs',
    'status',
    'str',
    'submit_airflow_job_run',
    'sum',
    'timedelta',
    'urlparse',
    'validate_catalog_output_identity',
    'verify_spark_iceberg_result',
    'writer_mode_for_pipeline',
}


def run_spark_job(db: Session, job: ETLJobModel, command: str, run_id: str) -> dict[str, Any]:
    ensure_batch_iceberg_target(db, job)
    rest_mode = spark_rest_mode_enabled()
    poll_timeout_ms = spark_rest_poll_timeout_ms()
    state_file = spark_rest_submission_state_file(run_id)
    incremental_since, incremental_before = source_incremental_window(db, job, run_id)
    source_window_rebaseline = source_uses_incremental_folder_window(job) and incremental_since is None
    source_object_inventory = incremental_source_object_inventory(
        db,
        job,
        incremental_since=incremental_since,
        incremental_before=incremental_before,
    )
    source_object_keys = (
        [str(item["key"]) for item in source_object_inventory]
        if source_object_inventory is not None
        else None
    )
    source_iceberg_table = (
        resolve_internal_data_lake_source(db, job.source_config)
        if is_internal_data_lake_source(job.source_type)
        else None
    )
    result = run_node_bridge(
        "run-spark-job-once.mjs",
        "ASKLAKE_SPARK_RUN_RESULT",
        {
            "command": command,
            "job": job_payload_for_spark(
                job,
                incremental_since,
                incremental_before,
                source_object_keys,
                source_object_inventory,
                source_window_rebaseline=source_window_rebaseline,
                source_iceberg_table=source_iceberg_table,
            ),
            "runId": run_id,
        },
        error_marker="ASKLAKE_SPARK_RUN_ERROR",
        timeout_seconds=spark_python_bridge_timeout_seconds(poll_timeout_ms) if rest_mode else 900,
        timeout_recovery=(lambda: recover_spark_rest_submission(state_file)) if rest_mode else None,
    )
    if source_object_inventory is not None:
        source_collection = result.get("sourceCollection")
        result["sourceCollection"] = {
            **(source_collection if isinstance(source_collection, dict) else {}),
            "objectKeys": source_object_keys,
            "objectInventory": source_object_inventory,
        }
    return result


def ensure_batch_iceberg_target(db: Session, job: ETLJobModel) -> None:
    if is_kafka_job(job):
        return
    expected_write_mode = writer_mode_for_pipeline(job.source_type, job.source_config)
    if job.iceberg_target:
        existing_target = IcebergWriterTarget.model_validate(job.iceberg_target)
        if existing_target.write_mode == expected_write_mode:
            return
    dataset_id = str(job.dataset_id or make_dataset_id(job.target))
    job.dataset_id = dataset_id
    job.iceberg_target = build_iceberg_writer_target(
        job.target,
        dataset_id,
        write_mode=expected_write_mode,
        partition_columns=normalize_string_list(job.partition_columns),
    ).model_dump(mode="json", by_alias=True)
    db.add(job)
    db.commit()


def execute_airflow_spark_run(
    db: Session,
    *,
    job_id: str,
    run_id: str,
    command: str,
) -> dict[str, Any]:
    return execute_airflow_spark_command(
        db,
        job_id=job_id,
        run_id=run_id,
        command=command,
        hooks=airflow_spark_execution_hooks(),
    )


def airflow_spark_execution_hooks() -> AirflowSparkExecutionHooks:
    return AirflowSparkExecutionHooks(
        compact_storage_text=compact_storage_text,
        format_duration_ms=format_duration_ms,
        format_rows=format_rows,
        iso_now=iso_now,
        make_attempt_id=lambda run_id: stable_id(
            "spark-attempt",
            f"{run_id}:{iso_now()}:{secrets.token_hex(8)}",
        ),
        run_spark_job=run_spark_job,
        spark_error_summary=spark_error_summary,
        spark_execution_lease_is_active=spark_execution_lease_is_active,
        spark_failed_stage=spark_failed_stage,
        spark_result_manifest=spark_result_manifest,
    )


def spark_execution_lease_is_active(value: Any) -> bool:
    if not isinstance(value, dict) or value.get("status") != "running":
        return False
    try:
        started_at = parse_incremental_timestamp(str(value.get("startedAt") or ""), "sparkExecution.startedAt")
    except ApiError:
        return False
    if started_at is None:
        return False
    return datetime.now(UTC) < started_at + timedelta(seconds=spark_execution_lease_seconds())


def spark_execution_lease_seconds() -> int:
    try:
        run_timeout = max(1, int(os.environ.get("ASKLAKE_SPARK_RUN_TIMEOUT_SECONDS") or "900"))
    except ValueError:
        run_timeout = 900
    try:
        configured = int(
            os.environ.get("ASKLAKE_SPARK_EXECUTION_LEASE_SECONDS")
            or DEFAULT_SPARK_EXECUTION_LEASE_SECONDS
        )
    except ValueError:
        configured = DEFAULT_SPARK_EXECUTION_LEASE_SECONDS
    return max(run_timeout + 60, configured)


def finalize_spark_execution_attempt(
    db: Session,
    *,
    job_id: str,
    run_id: str,
    attempt_id: str,
    error: str,
) -> None:
    finalize_airflow_spark_attempt(
        db,
        job_id=job_id,
        run_id=run_id,
        attempt_id=attempt_id,
        error=error,
        hooks=airflow_spark_execution_hooks(),
    )


def reconcile_airflow_catalog(
    db: Session,
    *,
    job_id: str,
    run_id: str,
) -> AirflowCatalogReconciliationResponse:
    return execute_airflow_catalog_reconciliation(
        db,
        job_id=job_id,
        run_id=run_id,
        hooks=airflow_catalog_reconciliation_hooks(),
    )


def airflow_catalog_reconciliation_hooks() -> AirflowCatalogReconciliationHooks:
    return AirflowCatalogReconciliationHooks(
        catalog_reconciliation_error=catalog_reconciliation_error,
        compact_storage_text=compact_storage_text,
        dataset_from_spark_result=dataset_from_spark_result,
        inspect_spark_output=inspect_spark_output,
        is_kafka_job=is_kafka_job,
        iso_now=iso_now,
        optional_string=optional_string,
        parse_count_value=parse_count_value,
        validate_catalog_output_identity=validate_catalog_output_identity,
        verify_spark_iceberg_result=verify_spark_iceberg_result,
    )


def airflow_catalog_identity(db: Session, job_id: str, run_id: str) -> tuple[ETLJobModel, ETLRunModel]:
    return resolve_airflow_catalog_identity(db, job_id, run_id)


def commit_airflow_catalog_reconciliation(
    db: Session,
    *,
    job_id: str,
    run_id: str,
    result: dict[str, Any],
    retry_on_create_conflict: bool,
) -> AirflowCatalogReconciliationResponse:
    return execute_airflow_catalog_commit(
        db,
        job_id=job_id,
        run_id=run_id,
        result=result,
        retry_on_create_conflict=retry_on_create_conflict,
        hooks=airflow_catalog_reconciliation_hooks(),
    )


def persist_catalog_reconciliation_failure(db: Session, run_id: str, dataset_id: str, message: str) -> None:
    record_airflow_catalog_failure(
        db,
        run_id,
        dataset_id,
        message,
        hooks=airflow_catalog_reconciliation_hooks(),
    )


def validate_catalog_output_identity(job: ETLJobModel, run_id: str, output_path: str) -> None:
    if not output_path or output_path == "-":
        raise catalog_reconciliation_error(
            "Successful Spark result does not include an output path.",
            {"jobId": job.id, "runId": run_id},
        )
    configured_root = normalize_spark_output_storage_path(job.storage_path)
    if not configured_root:
        return
    expected = canonical_storage_path(f"{configured_root.rstrip('/')}/{run_id}")
    actual = canonical_storage_path(output_path)
    if actual != expected:
        raise catalog_reconciliation_error(
            "Spark output path does not match the persisted Job destination.",
            {"expected": expected, "outputPath": actual, "runId": run_id},
        )


def normalize_spark_output_storage_path(value: str | None) -> str:
    configured_root = str(value or "").strip()
    if not re.match(r"^s3a?://", configured_root, re.IGNORECASE):
        return configured_root
    configured_bucket = str(os.environ.get("ASKLAKE_SPARK_OUTPUT_BUCKET") or "asklake-output").strip()
    if not configured_bucket or configured_bucket.lower() == "asklake-output":
        return configured_root
    parsed = urlparse(re.sub(r"^s3a://", "s3://", configured_root, flags=re.IGNORECASE))
    if parsed.netloc.lower() != "asklake-output":
        return configured_root
    suffix = f"/{parsed.path.lstrip('/')}" if parsed.path else ""
    return f"s3a://{configured_bucket}{suffix}"


def canonical_storage_path(value: str) -> str:
    text_value = str(value or "").strip()
    if re.match(r"^s3a?://", text_value, re.IGNORECASE):
        return re.sub(r"^s3://", "s3a://", text_value, flags=re.IGNORECASE).rstrip("/")
    return str(Path(text_value).expanduser().resolve()).rstrip("/")


def inspect_spark_output(output_path: str, *, s3_client: Any | None = None) -> dict[str, int]:
    if re.match(r"^s3a?://", output_path, re.IGNORECASE):
        return inspect_s3_spark_output(output_path, s3_client=s3_client)
    path = Path(output_path)
    if not path.exists():
        raise catalog_reconciliation_error(
            "Spark output path does not exist.",
            {"outputPath": output_path},
        )
    files = [path] if path.is_file() else [item for item in path.rglob("*") if item.is_file()]
    parquet_files = [item for item in files if item.name.lower().endswith(".parquet")]
    storage_size_bytes = sum(item.stat().st_size for item in files)
    if not parquet_files or storage_size_bytes <= 0:
        raise catalog_reconciliation_error(
            "Spark output does not contain a non-empty Parquet result.",
            {"outputPath": output_path},
        )
    return {
        "parquetObjectCount": len(parquet_files),
        "storageSizeBytes": storage_size_bytes,
    }


def inspect_s3_spark_output(output_path: str, *, s3_client: Any | None = None) -> dict[str, int]:
    parsed = urlparse(re.sub(r"^s3a://", "s3://", output_path, flags=re.IGNORECASE))
    bucket = parsed.netloc
    key = parsed.path.lstrip("/").rstrip("/")
    if not bucket or not key:
        raise catalog_reconciliation_error(
            "Spark S3 output path is invalid.",
            {"outputPath": output_path},
        )
    client = s3_client or build_catalog_s3_client()
    prefix = f"{key}/"
    continuation_token = None
    parquet_count = 0
    storage_size_bytes = 0
    try:
        while True:
            request = {"Bucket": bucket, "Prefix": prefix}
            if continuation_token:
                request["ContinuationToken"] = continuation_token
            response = client.list_objects_v2(**request)
            for item in response.get("Contents") or []:
                object_key = str(item.get("Key") or "")
                storage_size_bytes += max(int(item.get("Size") or 0), 0)
                if object_key.lower().endswith(".parquet"):
                    parquet_count += 1
            if not response.get("IsTruncated"):
                break
            continuation_token = response.get("NextContinuationToken")
            if not continuation_token:
                break
    except ApiError:
        raise
    except Exception as exc:
        raise catalog_reconciliation_error(
            "Spark S3 output could not be inspected.",
            {"bucket": bucket, "prefix": prefix, "reason": compact_storage_text(exc, limit=1000)},
        ) from exc
    if parquet_count <= 0 or storage_size_bytes <= 0:
        raise catalog_reconciliation_error(
            "Spark S3 output does not contain a non-empty Parquet result.",
            {"bucket": bucket, "prefix": prefix},
        )
    return {
        "parquetObjectCount": parquet_count,
        "storageSizeBytes": storage_size_bytes,
    }


def build_catalog_s3_client() -> Any:
    try:
        import boto3
        from botocore.config import Config
    except ImportError as exc:
        raise catalog_reconciliation_error(
            "Python S3 client dependency is not installed.",
        ) from exc

    runtime = object_storage_runtime()
    kwargs = runtime.boto3_kwargs()
    kwargs["config"] = Config(
        s3={"addressing_style": "path" if runtime.force_path_style else "auto"},
    )
    return boto3.client("s3", **kwargs)


def catalog_reconciliation_error(message: str, details: dict[str, Any] | None = None) -> ApiError:
    return ApiError(
        "CATALOG_RECONCILIATION_FAILED",
        message,
        status.HTTP_500_INTERNAL_SERVER_ERROR,
        details,
    )


def spark_result_manifest(result: dict[str, Any], run_id: str) -> dict[str, Any]:
    manifest = {
        key: result.get(key)
        for key in (
            "durationMs",
            "endedAt",
            "error",
            "failedStage",
            "format",
            "inputBytes",
            "inputFileCount",
            "inputRows",
            "outputFileCount",
            "icebergCommit",
            "outputPath",
            "outputRows",
            "quality",
            "schema",
            "sourceCollection",
            "sourcePath",
            "sparkExitCode",
            "startedAt",
            "status",
            "warehouseLocation",
        )
        if result.get(key) is not None
    }
    manifest["runId"] = str(result.get("runId") or run_id)
    if manifest.get("error"):
        manifest["error"] = compact_storage_text(manifest["error"], limit=1800)
    return manifest


def execute_airflow_run(
    db: Session,
    job_id: str,
    run_id: str,
    command: str,
    airflow_token: str | None,
) -> AirflowRunExecutionResponse:
    require_airflow_internal_token(airflow_token)
    job = etl_repository.get_job(db, job_id)
    run = etl_repository.get_run(db, run_id)
    if job is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job_id}", status.HTTP_404_NOT_FOUND)
    if run is None or run.job_id != job_id:
        raise ApiError(ErrorCode.NOT_FOUND, f"Run not found for job: {run_id}", status.HTTP_404_NOT_FOUND)
    if not run.airflow_dag_run_id:
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            f"Run is not owned by Airflow: {run_id}",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    dataset_id = job.dataset_id or make_dataset_id(job.target)
    job.dataset_id = dataset_id
    existing_dataset = etl_repository.get_dataset_by_id(db, dataset_id)
    if airflow_run_has_materialization(run, existing_dataset):
        return airflow_execution_response_from_persisted(job, run, existing_dataset)

    try:
        result = run_spark_job(db, job, command, run_id)
    except ApiError as exc:
        now = iso_now()
        result = {
            "endedAt": now,
            "error": exc.message,
            "failedStage": "Spark ETL bridge",
            "inputRows": 0,
            "outputPath": "-",
            "outputRows": 0,
            "runId": run_id,
            "startedAt": now,
            "status": "failed",
        }

    spark_run = run_from_spark_result(job, result)
    apply_spark_result_to_airflow_run(run, spark_run)
    run.task_states = {
        **(run.task_states or {}),
        "sparkResult": spark_result_manifest(result, run_id),
    }
    dataset_model = None
    if result.get("status") == "success":
        # Do not hold the dataset lock while Spark is running. Re-read and
        # lock immediately before merging the new materialization history.
        existing_dataset = etl_repository.get_dataset_by_id_for_update(db, dataset_id)
        dataset_model = dataset_from_spark_result(job, result, existing_dataset)
        job.target_path = result.get("outputPath") or job.target_path
        job.last_state = "Spark 적재 및 카탈로그 등록 완료 · Airflow 종료 확인 중"
        job.progress = {"label": "Airflow 종료 확인 중", "value": 95}
        job.status = "running"
    else:
        finalize_job_from_spark_result(job, command, result)

    run_schema = etl_repository.run_to_schema(run)
    other_runs = [item for item in etl_repository.list_runs_for_job(db, job.id) if item.run_id != run.run_id]
    job.stats = stats_from_runs(job, [run_schema, *other_runs])
    etl_repository.save_command_result(db, job, run, dataset_model)
    return airflow_execution_response(job, result, dataset_model.id if dataset_model else None)


def require_airflow_internal_token(provided_token: str | None) -> None:
    expected_token = str(settings.airflow_internal_token or "")
    if not expected_token:
        raise ApiError(
            "AIRFLOW_INTERNAL_TOKEN_MISSING",
            "AIRFLOW_INTERNAL_TOKEN is not configured on the AskLake backend.",
            status.HTTP_503_SERVICE_UNAVAILABLE,
        )
    if not provided_token or not secrets.compare_digest(expected_token, provided_token):
        raise ApiError(
            ErrorCode.FORBIDDEN,
            "Airflow worker authentication failed.",
            status.HTTP_403_FORBIDDEN,
        )


def apply_spark_result_to_airflow_run(run: ETLRunModel, spark_run: ETLRunModel) -> None:
    run.duration = spark_run.duration
    run.ended_at = spark_run.ended_at
    run.error_summary = spark_run.error_summary
    run.failed_stage = spark_run.failed_stage
    run.input_rows = spark_run.input_rows
    run.output_path = spark_run.output_path
    run.output_rows = spark_run.output_rows
    # Airflow remains the orchestration source of truth until the DAG reaches a terminal state.
    run.status = "running" if spark_run.status == "success" else "failed"


def airflow_execution_response(
    job: ETLJobModel,
    result: dict[str, Any],
    dataset_id: str | None,
) -> AirflowRunExecutionResponse:
    return AirflowRunExecutionResponse(
        status="success" if result.get("status") == "success" else "failed",
        job_id=job.id,
        run_id=str(result.get("runId") or ""),
        dataset_id=dataset_id,
        input_bytes=parse_count_value(result.get("inputBytes")),
        input_file_count=parse_count_value(result.get("inputFileCount")),
        input_rows=parse_count_value(result.get("inputRows")),
        output_file_count=parse_count_value(result.get("outputFileCount")),
        output_rows=parse_count_value(result.get("outputRows")),
        output_path=str(result.get("outputPath") or "-"),
        duration_ms=parse_optional_integer(result.get("durationMs")),
        schema=result.get("schema") if isinstance(result.get("schema"), list) else [],
        quality=result.get("quality") if isinstance(result.get("quality"), dict) else None,
        failed_stage=str(result.get("failedStage") or "") or None,
        error=spark_error_summary(result) if result.get("status") != "success" else None,
    )


def airflow_execution_response_from_persisted(
    job: ETLJobModel,
    run: ETLRunModel,
    dataset: CatalogDatasetModel,
) -> AirflowRunExecutionResponse:
    payload = dataset.payload or {}
    schema_payload = payload.get("schema") if isinstance(payload.get("schema"), list) else []
    schema = [
        {"name": str(item[0]), "type": str(item[1])}
        for item in schema_payload
        if isinstance(item, list) and len(item) >= 2
    ]
    spark_result = (run.task_states or {}).get("sparkResult")
    if not isinstance(spark_result, dict):
        spark_result = {}
    return AirflowRunExecutionResponse(
        status="success",
        job_id=job.id,
        run_id=run.run_id,
        dataset_id=dataset.id,
        input_bytes=parse_count_value(spark_result.get("inputBytes")),
        input_file_count=parse_count_value(spark_result.get("inputFileCount")),
        input_rows=parse_count_value(run.input_rows),
        output_file_count=parse_count_value(spark_result.get("outputFileCount")),
        output_rows=parse_count_value(run.output_rows),
        output_path=str(run.output_path or payload.get("storageLocation") or "-"),
        schema=schema,
    )


def airflow_run_reservation(
    job: ETLJobModel,
    command: str,
    airflow_client: AirflowGateway,
) -> ETLRunModel:
    submitted_at = iso_now()
    run_id = stable_id("run", f"{job.id}:{command}:airflow:{submitted_at}")
    reserved_dag_run = AirflowDagRun(
        dag_id=airflow_client.config.dag_id,
        dag_run_id=run_id,
        state="queued",
        asklake_status="queued",
        conf=airflow_dag_run_conf(job, command, run_id, submitted_at),
        raw={"reservation": True},
    )
    reserved = run_from_airflow_submit(
        job,
        command,
        run_id,
        submitted_at,
        reserved_dag_run,
        airflow_client.dag_run_url(run_id),
    )
    reserved.task_states = {
        "airflowReservation": {
            "reservedAt": submitted_at,
            "status": "queued",
        },
    }
    return reserved


def submit_airflow_job_run(
    job: ETLJobModel,
    command: str,
    *,
    run_id: str | None = None,
    submitted_at: str | None = None,
    airflow_client: AirflowGateway | None = None,
) -> ETLRunModel:
    submitted_at = submitted_at or iso_now()
    run_id = run_id or stable_id("run", f"{job.id}:{command}:airflow:{submitted_at}")
    airflow_client = airflow_client or build_airflow_client()
    dag_run = airflow_client.trigger_dag_run(
        dag_run_id=run_id,
        conf=airflow_dag_run_conf(job, command, run_id, submitted_at),
        note=f"AskLake {command} command for {job.id}",
    )
    if not dag_run.dag_run_id or dag_run.dag_run_id != run_id:
        raise ApiError(
            "AIRFLOW_RUN_MISMATCH",
            "Airflow DAG Run response did not match the reserved run.",
            status.HTTP_502_BAD_GATEWAY,
            {
                "dagId": airflow_client.config.dag_id,
                "expectedRunId": run_id,
                "responseRunId": dag_run.dag_run_id or None,
            },
        )
    return run_from_airflow_submit(
        job,
        command,
        run_id,
        submitted_at,
        dag_run,
        airflow_client.dag_run_url(dag_run.dag_run_id),
    )


def submit_or_reconcile_airflow_job_run(
    job: ETLJobModel,
    command: str,
    reserved_run: ETLRunModel,
    airflow_client: Any,
) -> tuple[ETLRunModel | None, Exception | None]:
    try:
        return submit_airflow_job_run(
            job,
            command,
            run_id=reserved_run.run_id,
            submitted_at=reserved_run.started_at,
            airflow_client=airflow_client,
        ), None
    except Exception as trigger_error:
        try:
            dag_run = airflow_client.get_dag_run(reserved_run.run_id)
        except Exception:
            return None, trigger_error
        if not dag_run.dag_run_id or dag_run.dag_run_id != reserved_run.run_id:
            return None, ApiError(
                "AIRFLOW_RUN_MISMATCH",
                "Airflow reconciliation did not match the reserved run.",
                status.HTTP_502_BAD_GATEWAY,
                {
                    "expectedRunId": reserved_run.run_id,
                    "responseRunId": dag_run.dag_run_id or None,
                },
            )
        return run_from_airflow_submit(
            job,
            command,
            reserved_run.run_id,
            reserved_run.started_at,
            dag_run,
            airflow_client.dag_run_url(dag_run.dag_run_id),
        ), None


def airflow_dag_run_conf(job: ETLJobModel, command: str, run_id: str, submitted_at: str) -> dict[str, Any]:
    return {
        "command": command,
        "executionMode": "spark",
        "jobId": job.id,
        "runId": run_id,
        "submittedAt": submitted_at,
    }


def job_payload_for_spark(
    job: ETLJobModel,
    incremental_since: str | None = None,
    incremental_before: str | None = None,
    source_object_keys: list[str] | None = None,
    source_object_inventory: list[dict[str, Any]] | None = None,
    *,
    source_window_rebaseline: bool = False,
    source_iceberg_table: dict[str, Any] | None = None,
) -> dict[str, Any]:
    compiled_rules = compile_job_rules(job)
    require_compiled_rules(compiled_rules)
    canonical_rules = [
        rule.model_dump(mode="json", by_alias=True)
        for rule in compiled_rules.result.rules
    ]
    return {
        "id": job.id,
        "name": job.name,
        "owner": job.owner,
        "partition": job.partition,
        "qualityInvalidRows": job.quality_invalid_rows or [],
        "qualityRules": [
            rule.model_dump(mode="json", by_alias=True)
            for rule in compiled_rules.quality_rules
        ],
        "qualityScore": job.quality_score,
        "qualityStatus": job.quality_status,
        "rag": job.rag,
        "ruleContractVersion": compiled_rules.result.contract_version,
        "ruleOutputSchema": compiled_rules.result.output_schema,
        "rules": canonical_rules,
        "ruleFingerprint": canonical_rule_fingerprint(
            compiled_rules.result.contract_version,
            canonical_rules,
        ),
        "recordParsing": job.record_parsing or None,
        "schedule": job.schedule,
        "schemaColumns": job.schema_columns or [],
        "schemaFingerprint": job.schema_fingerprint,
        "schemaSampleRows": job.schema_sample_rows or [],
        "source": job.source,
        "sourceConfig": job.source_config or [],
        "sourceIncrementalBefore": incremental_before,
        "sourceIncrementalSince": incremental_since,
        "sourceObjectKeys": source_object_keys,
        "sourceObjectInventory": source_object_inventory,
        "sourceWindowContractVersion": SOURCE_WINDOW_CONTRACT_VERSION if source_uses_incremental_folder_window(job) else None,
        "sourceWindowRebaseline": source_window_rebaseline,
        "sourceLabel": job.source_label,
        "sourceIcebergTable": source_iceberg_table,
        "sourceType": job.source_type,
        "stats": job.stats or {},
        "target": job.target,
        "targetDescription": job.target_description,
        "targetFormat": job.target_format,
        "targetLayer": job.target_layer,
        "targetPath": job.target_path,
        "targetTags": job.target_tags or [],
        "storagePath": job.storage_path,
        "icebergTarget": job.iceberg_target,
        "storageType": job.storage_type,
        "partition": job.partition,
        "partitionColumns": job.partition_columns or [],
        "indexColumns": job.index_columns or [],
        "compression": job.compression,
        "transformOutputColumns": compiled_rules.result.output_schema,
        "transformSteps": [
            step.model_dump(mode="json", by_alias=True)
            for step in compiled_rules.transform_steps
        ],
    }


EXPORTED_FUNCTIONS = (
    'run_spark_job',
    'ensure_batch_iceberg_target',
    'execute_airflow_spark_run',
    'airflow_spark_execution_hooks',
    'spark_execution_lease_is_active',
    'spark_execution_lease_seconds',
    'finalize_spark_execution_attempt',
    'reconcile_airflow_catalog',
    'airflow_catalog_reconciliation_hooks',
    'airflow_catalog_identity',
    'commit_airflow_catalog_reconciliation',
    'persist_catalog_reconciliation_failure',
    'validate_catalog_output_identity',
    'normalize_spark_output_storage_path',
    'canonical_storage_path',
    'inspect_spark_output',
    'inspect_s3_spark_output',
    'build_catalog_s3_client',
    'catalog_reconciliation_error',
    'spark_result_manifest',
    'execute_airflow_run',
    'require_airflow_internal_token',
    'apply_spark_result_to_airflow_run',
    'airflow_execution_response',
    'airflow_execution_response_from_persisted',
    'airflow_run_reservation',
    'submit_airflow_job_run',
    'submit_or_reconcile_airflow_job_run',
    'airflow_dag_run_conf',
    'job_payload_for_spark',
)

IMPLEMENTATIONS = {name: globals()[name] for name in EXPORTED_FUNCTIONS}
