"""Kafka continuous worker and maintenance operations behind the ETL facade."""

from __future__ import annotations

RUNTIME_NAMES = {
    'AuditTargetType',
    'ApiError',
    'ContinuousQuarantineResponse',
    'ContinuousWorkerLogsResponse',
    'ErrorCode',
    'IcebergWriterError',
    'IcebergWriterService',
    'IcebergWriterTarget',
    'clickhouse_kafka_ingest_v2_enabled',
    'UTC',
    'ValueError',
    'apply_continuous_replay_runtime_counters',
    'bool',
    'bounded_environment_integer',
    'canonical_rule_fingerprint',
    'compile_job_rules',
    'continuous_maintenance_bridge_timeout_seconds',
    'continuous_maintenance_poll_timeout_ms',
    'continuous_maintenance_state_file',
    'continuous_replay_result_is_durable',
    'datetime',
    'dict',
    'etl_repository',
    'execute_kafka_continuous_maintenance',
    'int',
    'isinstance',
    'iso_now',
    'list',
    'materialize_continuous_replay',
    'max',
    'min',
    'nonnegative_int',
    'optional_string',
    'os',
    'parse_kafka_target_path',
    'parse_maintenance_datetime',
    'read_runtime_json',
    'reconcile_pending_continuous_replay_catalog',
    'reconcile_stale_continuous_maintenance_runs',
    'recover_continuous_replay_result',
    'recover_spark_rest_submission',
    'refresh_kafka_continuous_runtime',
    'require_compiled_rules',
    'require_continuous_job_access',
    'require_continuous_maintenance_idle',
    'require_no_active_continuous_maintenance',
    'reversed',
    'run_kafka_continuous_maintenance',
    'run_clickhouse_kafka_ingest_v2',
    'run_kafka_continuous_worker',
    'run_node_bridge',
    'safe_record_audit_event',
    'settings',
    'spark_rest_mode_enabled',
    'stable_id',
    'status',
    'str',
    'trusted_legacy_replay_run_ids',
}


def run_kafka_continuous_worker(
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
    action: str,
    options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if clickhouse_kafka_ingest_v2_enabled(job, settings):
        return run_clickhouse_kafka_ingest_v2(
            job,
            runtime,
            action,
            options,
            runtime_settings=settings,
        )
    config = job.continuous_config or {}
    compiled_rules = compile_job_rules(job)
    require_compiled_rules(compiled_rules)
    canonical_rules = [
        rule.model_dump(mode="json", by_alias=True)
        for rule in compiled_rules.result.rules
    ]
    if not isinstance(job.iceberg_target, dict):
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            "Continuous Job does not have an Iceberg target; copy the Job to create a new Continuous checkpoint.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    rule_fingerprint = canonical_rule_fingerprint(compiled_rules.result.contract_version, canonical_rules)
    target = parse_kafka_target_path(job.storage_path or job.target_path, job.target, job.target_layer)
    output_path = f"s3a://{target['bucket']}/{target['prefix'].strip('/')}"
    return run_node_bridge(
        "manage-kafka-continuous.mjs",
        "ASKLAKE_KAFKA_CONTINUOUS_RESULT",
        {
            "action": action,
            "broker": runtime.broker,
            "checkpointPath": runtime.checkpoint_path,
            "consumerGroupId": runtime.consumer_group_id,
            "initialOffsetPolicy": config.get("initialOffsetPolicy", "earliest"),
            "initialCounts": {
                "consumedCount": runtime.consumed_count,
                "storedCount": runtime.stored_count,
                "quarantinedCount": runtime.quarantined_count,
                "failedCount": runtime.failed_count,
            },
            "initialMetrics": {
                "lag": runtime.lag,
                **(runtime.metrics or {}),
            },
            "initialSchemaState": runtime.schema_state or {},
            "streamPartitionCursors": (
                (runtime.metrics or {}).get("streamPartitionCursors")
                if isinstance((runtime.metrics or {}).get("streamPartitionCursors"), list)
                else []
            ),
            "icebergTarget": job.iceberg_target,
            "jobId": job.id,
            "maxOffsetsPerTrigger": config.get("maxOffsetsPerTrigger", 100),
            "outputPath": output_path,
            "ruleContractVersion": compiled_rules.result.contract_version,
            "ruleFingerprint": rule_fingerprint,
            "ruleOutputSchema": compiled_rules.result.output_schema,
            "rules": canonical_rules,
            "recordParsing": job.record_parsing or None,
            "schemaColumns": job.schema_columns or [],
            "schemaFingerprint": job.schema_fingerprint or "",
            "schemaEvolutionPolicy": config.get("schemaEvolutionPolicy") or {},
            "topic": runtime.topic,
            "triggerIntervalSeconds": config.get("triggerIntervalSeconds", 10),
            **(options or {}),
        },
        error_marker="ASKLAKE_KAFKA_CONTINUOUS_ERROR",
        timeout_seconds=90 if action == "start" else 20,
    )


def get_kafka_continuous_worker_logs(
    db: Session,
    job_id: str,
    actor: ActorContext,
    tail: int,
) -> ContinuousWorkerLogsResponse:
    job = require_continuous_job_access(db, job_id, actor, "view", "GET", "continuous/logs")
    runtime = etl_repository.get_kafka_continuous_runtime(db, job.id)
    if runtime is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Continuous runtime not found: {job_id}", status.HTTP_404_NOT_FOUND)
    result = run_kafka_continuous_worker(job, runtime, "logs", {"tail": min(max(tail, 1), 1000)})
    return ContinuousWorkerLogsResponse(
        job_id=job.id,
        container_state=str(result.get("containerState") or "unknown"),
        lines=[str(line) for line in (result.get("lines") or [])],
        truncated=bool(result.get("truncated")),
    )


def list_kafka_continuous_sessions(
    db: Session,
    job_id: str,
    actor: ActorContext,
) -> list[KafkaContinuousSession]:
    job = require_continuous_job_access(db, job_id, actor, "view", "GET", "continuous/sessions")
    refresh_kafka_continuous_runtime(db, job)
    return etl_repository.list_kafka_continuous_sessions(db, job.id)


def get_kafka_continuous_session(
    db: Session,
    job_id: str,
    session_id: str,
    actor: ActorContext,
) -> KafkaContinuousSession:
    job = require_continuous_job_access(db, job_id, actor, "view", "GET", f"continuous/sessions/{session_id}")
    refresh_kafka_continuous_runtime(db, job)
    session = etl_repository.get_kafka_continuous_session(db, session_id)
    if session is None or session.job_id != job.id:
        raise ApiError(ErrorCode.NOT_FOUND, f"Continuous session not found: {session_id}", status.HTTP_404_NOT_FOUND)
    return etl_repository.continuous_session_to_schema(session)


def list_kafka_continuous_session_batches(
    db: Session,
    job_id: str,
    session_id: str,
    actor: ActorContext,
    limit: int,
) -> list[KafkaContinuousBatch]:
    job = require_continuous_job_access(db, job_id, actor, "view", "GET", f"continuous/sessions/{session_id}/batches")
    refresh_kafka_continuous_runtime(db, job)
    session = etl_repository.get_kafka_continuous_session(db, session_id)
    if session is None or session.job_id != job.id:
        raise ApiError(ErrorCode.NOT_FOUND, f"Continuous session not found: {session_id}", status.HTTP_404_NOT_FOUND)
    return etl_repository.list_kafka_continuous_batches(db, session_id, min(max(limit, 1), 500))


def get_kafka_continuous_quarantine(
    db: Session,
    job_id: str,
    actor: ActorContext,
    limit: int,
) -> ContinuousQuarantineResponse:
    job = require_continuous_job_access(db, job_id, actor, "view", "GET", "continuous/quarantine")
    locked_job = etl_repository.get_job_for_update(db, job.id)
    if locked_job is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job.id}", status.HTTP_404_NOT_FOUND)
    job = locked_job
    reconcile_stale_continuous_maintenance_runs(db, job.id, commit=False)
    runtime = etl_repository.lock_kafka_continuous_runtime(db, job.id)
    require_continuous_maintenance_idle(db, job, runtime=runtime)
    require_no_active_continuous_maintenance(db, job.id)
    result = run_kafka_continuous_maintenance(
        job,
        "inspect_quarantine",
        stable_id("inspect", iso_now()),
        {
            "limit": limit,
            "trustedLegacyReplayRunIds": trusted_legacy_replay_run_ids(db, job),
        },
    )
    return ContinuousQuarantineResponse(job_id=job.id, records=result.get("records") or [], total=int(result.get("total") or 0))


def list_kafka_continuous_maintenance_runs(
    db: Session,
    job_id: str,
    actor: ActorContext,
) -> list[ContinuousMaintenanceRun]:
    job = require_continuous_job_access(db, job_id, actor, "view", "GET", "continuous/maintenance-runs")
    reconcile_stale_continuous_maintenance_runs(db, job_id)
    reconcile_pending_continuous_replay_catalog(db, job)
    return etl_repository.list_kafka_continuous_maintenance_runs(db, job_id)


def replay_kafka_continuous_quarantine(
    db: Session,
    job_id: str,
    request: ContinuousReplayRequest,
    actor: ActorContext,
) -> ContinuousMaintenanceRun:
    config = request.model_dump(mode="json", by_alias=True)
    return execute_kafka_continuous_maintenance(
        db,
        job_id,
        "quarantine_replay",
        config,
        actor,
        access_action="manage" if request.approve_unknown_fields else "run",
    )


def compact_kafka_continuous_target(
    db: Session,
    job_id: str,
    request: ContinuousCompactionRequest,
    actor: ActorContext,
) -> ContinuousMaintenanceRun:
    return execute_kafka_continuous_maintenance(
        db,
        job_id,
        "compaction",
        request.model_dump(mode="json", by_alias=True),
        actor,
    )


def maintain_kafka_continuous_iceberg_target(
    db: Session,
    job_id: str,
    request: ContinuousIcebergMaintenanceRequest,
    actor: ActorContext,
) -> ContinuousMaintenanceRun:
    return execute_kafka_continuous_maintenance(
        db,
        job_id,
        "iceberg_maintenance",
        request.model_dump(mode="json", by_alias=True),
        actor,
        access_action="manage" if request.expire_snapshots or request.remove_orphan_files else "run",
    )


def verify_continuous_iceberg_maintenance(
    job: ETLJobModel,
    run_id: str,
    result: dict[str, Any],
    *,
    writer_service: IcebergWriterService | None = None,
) -> dict[str, Any]:
    try:
        target = IcebergWriterTarget.model_validate(job.iceberg_target)
        if str(result.get("tableUri") or "") != target.table_uri:
            raise IcebergWriterError("ICEBERG_MAINTENANCE_TARGET_MISMATCH")
        snapshot_id = str(result.get("snapshotIdAfter") or "").strip()
        if not snapshot_id:
            raise IcebergWriterError("ICEBERG_MAINTENANCE_SNAPSHOT_MISSING")
        service = writer_service or IcebergWriterService()
        evidence = service.verify_commit(
            target,
            created_table=False,
            job_id=job.id,
            run_id=run_id,
            expected_snapshot_id=snapshot_id,
        )
        data_file_count, storage_size_bytes = service.table_storage_metrics(
            target,
            snapshot_id=snapshot_id,
        )
    except (IcebergWriterError, ValueError) as exc:
        code = exc.code if isinstance(exc, IcebergWriterError) else "ICEBERG_MAINTENANCE_VERIFICATION_FAILED"
        raise ApiError(
            code,
            "Iceberg maintenance could not be verified through Trino.",
            status.HTTP_502_BAD_GATEWAY,
            {"jobId": job.id, "maintenanceRunId": run_id},
        ) from exc
    return {
        **result,
        "dataFileCount": data_file_count,
        "icebergSnapshotId": evidence.snapshot_id,
        "queryEngineTable": evidence.query_engine_table.model_dump(mode="json", by_alias=True),
        "queryEngineVerified": True,
        "storageSizeBytes": storage_size_bytes,
        "warehouseLocation": evidence.warehouse_location,
    }


def apply_continuous_replay_runtime_counters(
    runtime: KafkaContinuousRuntimeModel,
    result: dict[str, Any],
) -> None:
    if result.get("countersApplied") is True:
        return
    replayed_count = nonnegative_int(result.get("storedCount"), 0)
    runtime.stored_count = int(runtime.stored_count or 0) + replayed_count
    runtime.metrics = {
        **(runtime.metrics or {}),
        "replayedCount": nonnegative_int((runtime.metrics or {}).get("replayedCount"), 0) + replayed_count,
    }
    result["countersApplied"] = True


def reconcile_pending_continuous_replay_catalog(
    db: Session,
    job: ETLJobModel,
) -> None:
    maintenance_runs = etl_repository.list_kafka_continuous_maintenance_run_models(
        db,
        job.id,
        active_only=False,
    )
    for run in reversed(maintenance_runs):
        if run.kind != "quarantine_replay" or run.status not in {"failed", "success"}:
            continue
        result = dict(run.result or {})
        if result.get("catalogApplied") is True and result.get("countersApplied") is True:
            continue
        recovery_state, result, recovery_reason = recover_continuous_replay_result(
            job,
            run.run_id,
            result,
        )
        if recovery_state == "missing":
            if isinstance(run.result, dict) and "replayManifestRecovery" in run.result:
                result.pop("replayManifestRecovery", None)
                run.result = dict(result)
                db.add(run)
            continue
        if recovery_state == "unavailable":
            result["replayManifestRecovery"] = {
                "state": "unavailable",
                "reason": recovery_reason,
            }
            run.result = dict(result)
            run.last_error = "Replay manifest recovery is pending before the stream can restart."
            db.add(run)
            continue
        if not continuous_replay_result_is_durable(result):
            continue
        result.pop("replayManifestRecovery", None)
        result.setdefault("catalogApplied", False)
        result.setdefault("countersApplied", False)
        run.result = dict(result)
        locked_job = etl_repository.get_job_for_update(db, job.id)
        runtime = etl_repository.lock_kafka_continuous_runtime(db, job.id)
        if locked_job is None or runtime is None:
            return
        job = locked_job
        if result.get("catalogApplied") is not True:
            if not materialize_continuous_replay(db, job, runtime, result):
                continue
            result["catalogApplied"] = True
        # Catalog reconciliation commits independently. Fence the counter
        # update again and persist countersApplied with the runtime atomically.
        locked_job = etl_repository.get_job_for_update(db, job.id)
        runtime = etl_repository.lock_kafka_continuous_runtime(db, job.id)
        if locked_job is None or runtime is None:
            return
        job = locked_job
        apply_continuous_replay_runtime_counters(runtime, result)
        run.status = "success"
        run.result = dict(result)
        run.last_error = None
        db.add(run)
        etl_repository.save_kafka_continuous_command(db, job, runtime)


def record_continuous_replay_override_audit(
    db: Session,
    job: ETLJobModel,
    actor: ActorContext,
    run_id: str,
    result: str,
) -> None:
    safe_record_audit_event(
        db,
        action="etl_job.continuous_replay.unknown_fields_approved",
        actor=actor,
        api_path=f"/api/etl/jobs/{job.id}/continuous/quarantine/replays",
        http_method="POST",
        metadata={"maintenanceRunId": run_id, "policyOverride": "approve_unknown_fields"},
        result=result,
        status_code=status.HTTP_200_OK if result == "success" else status.HTTP_502_BAD_GATEWAY,
        target_id=job.id,
        target_name=job.name,
        target_type=AuditTargetType.ETL_JOB,
    )


def run_kafka_continuous_maintenance(
    job: ETLJobModel,
    kind: str,
    run_id: str,
    config: dict[str, Any],
) -> dict[str, Any]:
    if not isinstance(job.iceberg_target, dict):
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            "Continuous Job does not have an Iceberg target; copy the Job to create a new Continuous checkpoint.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    compiled_rules = compile_job_rules(job)
    require_compiled_rules(compiled_rules)
    canonical_rules = [
        rule.model_dump(mode="json", by_alias=True)
        for rule in compiled_rules.result.rules
    ]
    target = parse_kafka_target_path(job.storage_path or job.target_path, job.target, job.target_layer)
    output_path = f"s3a://{target['bucket']}/{target['prefix'].strip('/')}"
    rest_mode = spark_rest_mode_enabled()
    poll_timeout_ms = continuous_maintenance_poll_timeout_ms()
    state_file = continuous_maintenance_state_file(run_id)
    return run_node_bridge(
        "manage-kafka-continuous-maintenance.mjs",
        "ASKLAKE_KAFKA_MAINTENANCE_RESULT",
        {
            "action": "run",
            "icebergTarget": job.iceberg_target,
            "jobId": job.id,
            "kind": kind,
            "runId": run_id,
            "outputPath": output_path,
            "ruleContractVersion": compiled_rules.result.contract_version,
            "ruleFingerprint": canonical_rule_fingerprint(compiled_rules.result.contract_version, canonical_rules),
            "ruleOutputSchema": compiled_rules.result.output_schema,
            "rules": canonical_rules,
            "schemaColumns": job.schema_columns or [],
            "schemaFingerprint": job.schema_fingerprint,
            "schemaEvolutionPolicy": (job.continuous_config or {}).get("schemaEvolutionPolicy") or {},
            **config,
        },
        error_marker="ASKLAKE_KAFKA_MAINTENANCE_ERROR",
        timeout_seconds=(
            continuous_maintenance_bridge_timeout_seconds(poll_timeout_ms)
            if rest_mode
            else 600
        ),
        timeout_recovery=(lambda: recover_spark_rest_submission(state_file)) if rest_mode else None,
    )


def cleanup_kafka_continuous_maintenance(run_id: str) -> dict[str, Any]:
    return run_node_bridge(
        "manage-kafka-continuous-maintenance.mjs",
        "ASKLAKE_KAFKA_MAINTENANCE_RESULT",
        {"action": "cleanup", "runId": run_id},
        error_marker="ASKLAKE_KAFKA_MAINTENANCE_ERROR",
        timeout_seconds=20,
    )


def continuous_maintenance_lease_seconds() -> int:
    try:
        configured = int(os.environ.get("ASKLAKE_CONTINUOUS_MAINTENANCE_LEASE_SECONDS") or 900)
    except ValueError:
        configured = 900
    return max(120, min(configured, 86_400))


def continuous_maintenance_runner_stale_seconds() -> int:
    return bounded_environment_integer(
        "ASKLAKE_CONTINUOUS_MAINTENANCE_RUNNER_STALE_SECONDS",
        default=30,
        minimum=10,
        maximum=3600,
    )


def continuous_maintenance_runner_observation(run_id: str) -> dict[str, Any] | None:
    state_file = continuous_maintenance_state_file(run_id)
    document = read_runtime_json(state_file)
    if not document.found or document.value is None:
        return None
    state = document.value
    if (
        not isinstance(state, dict)
        or state.get("runner") != "rest"
        or str(state.get("runId") or "") != str(run_id)
        or not str(state.get("submissionId") or "").strip()
    ):
        return None
    updated_at = parse_maintenance_datetime(state.get("updatedAt"))
    driver_state = str(state.get("driverState") or "UNKNOWN").strip().upper() or "UNKNOWN"
    terminal = driver_state in {"ERROR", "FAILED", "FINISHED", "KILLED"}
    return {
        "driverState": driver_state,
        "submissionId": str(state.get("submissionId") or "").strip(),
        "terminal": terminal,
        "updatedAt": updated_at,
    }


def parse_maintenance_datetime(value: Any) -> datetime | None:
    normalized = optional_string(value)
    if not normalized:
        return None
    try:
        parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def persist_reconciled_maintenance_run(
    db: Session,
    run: KafkaContinuousMaintenanceRunModel,
    *,
    commit: bool,
) -> None:
    if commit:
        etl_repository.save_kafka_continuous_maintenance_run(db, run)
        return
    db.add(run)
    db.flush()


EXPORTED_FUNCTIONS = (
    'run_kafka_continuous_worker',
    'get_kafka_continuous_worker_logs',
    'list_kafka_continuous_sessions',
    'get_kafka_continuous_session',
    'list_kafka_continuous_session_batches',
    'get_kafka_continuous_quarantine',
    'list_kafka_continuous_maintenance_runs',
    'replay_kafka_continuous_quarantine',
    'compact_kafka_continuous_target',
    'maintain_kafka_continuous_iceberg_target',
    'verify_continuous_iceberg_maintenance',
    'apply_continuous_replay_runtime_counters',
    'reconcile_pending_continuous_replay_catalog',
    'record_continuous_replay_override_audit',
    'run_kafka_continuous_maintenance',
    'cleanup_kafka_continuous_maintenance',
    'continuous_maintenance_lease_seconds',
    'continuous_maintenance_runner_stale_seconds',
    'continuous_maintenance_runner_observation',
    'parse_maintenance_datetime',
    'persist_reconciled_maintenance_run',
)

IMPLEMENTATIONS = {name: globals()[name] for name in EXPORTED_FUNCTIONS}
