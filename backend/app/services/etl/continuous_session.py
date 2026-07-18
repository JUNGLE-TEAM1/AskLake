"""Kafka continuous session and runtime synchronization operations behind the ETL facade."""

from __future__ import annotations

RUNTIME_NAMES = {
    'ApiError',
    'CallableKafkaRuntimeGateway',
    'ContinuousReconciliationHooks',
    'ErrorCode',
    'KafkaContinuousBatchModel',
    'KafkaContinuousSessionModel',
    '_apply_continuous_runtime_report',
    'continuous_batch_dag_steps',
    'continuous_runtime_report_path',
    'continuous_session_dag_steps',
    'continuous_worker_status',
    'current_kafka_continuous_session',
    'dict',
    'enumerate',
    'etl_repository',
    'int',
    'is_kafka_job',
    'isinstance',
    'iso_now',
    'list',
    'mark_continuous_runtime_failed',
    'materialize_continuous_batch',
    'max',
    'next',
    'nonnegative_int',
    'optional_int',
    'optional_string',
    'read_runtime_json',
    'reconcile_continuous_runtime',
    'reconcile_pending_continuous_replay_catalog',
    'reconcile_stale_continuous_maintenance_runs',
    'require_governed_access',
    'reversed',
    'run_kafka_continuous_worker',
    'secrets',
    'sorted',
    'status',
    'str',
    'sync_kafka_continuous_batches',
    'sync_kafka_continuous_session',
    'write_continuous_catalog_ack',
}


def require_no_active_continuous_maintenance(db: Session, job_id: str) -> None:
    active_runs = etl_repository.list_kafka_continuous_maintenance_run_models(db, job_id, active_only=True)
    if active_runs:
        raise ApiError(
            ErrorCode.CONFLICT,
            f"Continuous maintenance is already active: {active_runs[0].run_id}",
            status.HTTP_409_CONFLICT,
            {"activeRunId": active_runs[0].run_id, "kind": active_runs[0].kind},
        )


def require_continuous_job_access(
    db: Session,
    job_id: str,
    actor: ActorContext,
    action: str,
    http_method: str,
    suffix: str,
) -> ETLJobModel:
    job = etl_repository.get_job(db, job_id)
    if job is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job_id}", status.HTTP_404_NOT_FOUND)
    if job.execution_mode != "continuous" or not is_kafka_job(job):
        raise ApiError(ErrorCode.INVALID_JOB_STATE, "Continuous operation requires a continuous Kafka Job.", status.HTTP_422_UNPROCESSABLE_ENTITY)
    require_governed_access(
        db,
        actor,
        action=action,
        api_path=f"/api/etl/jobs/{job_id}/{suffix}",
        http_method=http_method,
        metadata={"owner": job.owner},
        resource_id=job.id,
        resource_name=job.name,
        resource_type="etl_job",
    )
    return job


def require_continuous_maintenance_idle(
    db: Session,
    job: ETLJobModel,
    *,
    runtime: KafkaContinuousRuntimeModel | None = None,
) -> None:
    runtime = runtime or etl_repository.get_kafka_continuous_runtime(db, job.id)
    if runtime is None:
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            "Continuous maintenance requires an initialized runtime.",
            status.HTTP_409_CONFLICT,
        )
    if runtime.status not in {"paused", "stopped"}:
        raise ApiError(
            ErrorCode.CONFLICT,
            "Pause or stop the Continuous worker before Lake maintenance.",
            status.HTTP_409_CONFLICT,
            {"runtimeStatus": runtime.status},
        )


def begin_kafka_continuous_session(
    db: Session | None,
    job: ETLJobModel,
    runtime: KafkaContinuousRuntimeModel,
) -> KafkaContinuousSessionModel | None:
    session_id = f"SESSION-{job.id}-{secrets.token_hex(6)}"
    baseline_counts = {
        "consumedCount": int(runtime.consumed_count or 0),
        "storedCount": int(runtime.stored_count or 0),
        "quarantinedCount": int(runtime.quarantined_count or 0),
        "failedCount": int(runtime.failed_count or 0),
        "lastBatchId": runtime.last_batch_id,
    }
    runtime.metrics = {
        **(runtime.metrics or {}),
        "currentSessionId": session_id,
        "currentSessionEndReason": None,
    }
    if db is None:
        return None
    session = KafkaContinuousSessionModel(
        session_id=session_id,
        job_id=job.id,
        status="starting",
        started_at=iso_now(),
        checkpoint_path=runtime.checkpoint_path,
        baseline_counts=baseline_counts,
    )
    etl_repository.stage_kafka_continuous_session(db, session)
    return session


def current_kafka_continuous_session(
    db: Session | None,
    runtime: KafkaContinuousRuntimeModel,
) -> KafkaContinuousSessionModel | None:
    if db is None:
        return None
    session_id = optional_string((runtime.metrics or {}).get("currentSessionId"))
    if session_id:
        session = etl_repository.get_kafka_continuous_session(db, session_id)
        if session is not None and session.job_id == runtime.job_id:
            return session
    return etl_repository.get_latest_active_kafka_continuous_session(db, runtime.job_id)


def fail_kafka_continuous_session(
    session: KafkaContinuousSessionModel | None,
    message: str,
    reason: str,
) -> None:
    if session is None:
        return
    session.status = "failed"
    session.ended_at = session.ended_at or iso_now()
    session.end_reason = reason
    session.failed_count = max(int(session.failed_count or 0), 1)
    session.last_error = message


def mark_kafka_continuous_session_stopping(
    db: Session | None,
    runtime: KafkaContinuousRuntimeModel,
    reason: str,
) -> None:
    runtime.metrics = {
        **(runtime.metrics or {}),
        "currentSessionEndReason": reason,
    }
    session = current_kafka_continuous_session(db, runtime)
    if session is not None and session.status not in {"stopped", "failed"}:
        session.status = "stopping"
        session.end_reason = reason


def sync_kafka_continuous_session(
    db: Session | None,
    runtime: KafkaContinuousRuntimeModel,
    payload: dict[str, Any] | None = None,
) -> None:
    if db is None:
        return
    session = current_kafka_continuous_session(db, runtime)
    if (
        session is not None
        and session.status in {"stopped", "failed"}
        and session.ended_at
        and runtime.status in {"starting", "running"}
    ):
        session_id = f"SESSION-{runtime.job_id}-{secrets.token_hex(6)}"
        session = KafkaContinuousSessionModel(
            session_id=session_id,
            job_id=runtime.job_id,
            status="starting",
            started_at=iso_now(),
            checkpoint_path=runtime.checkpoint_path,
            baseline_counts={
                "consumedCount": int(runtime.consumed_count or 0),
                "storedCount": int(runtime.stored_count or 0),
                "quarantinedCount": int(runtime.quarantined_count or 0),
                "failedCount": int(runtime.failed_count or 0),
                "lastBatchId": runtime.last_batch_id,
            },
        )
        runtime.metrics = {
            **(runtime.metrics or {}),
            "currentSessionId": session_id,
            "currentSessionEndReason": None,
        }
        etl_repository.stage_kafka_continuous_session(db, session)
    if session is None:
        return
    if session.status in {"stopped", "failed"} and session.ended_at:
        sync_kafka_continuous_batches(db, runtime, session, payload or {})
        session.dag_steps = continuous_session_dag_steps(session, runtime, payload or {})
        db.add(session)
        return
    metrics = runtime.metrics or {}
    worker_attempt_id = optional_string((payload or {}).get("workerAttemptId")) or optional_string(metrics.get("currentWorkerAttemptId"))
    if worker_attempt_id:
        session.worker_attempt_id = worker_attempt_id
    baseline = session.baseline_counts or {}
    session.consumed_count = max(0, int(runtime.consumed_count or 0) - nonnegative_int(baseline.get("consumedCount"), 0))
    session.stored_count = max(0, int(runtime.stored_count or 0) - nonnegative_int(baseline.get("storedCount"), 0))
    session.quarantined_count = max(0, int(runtime.quarantined_count or 0) - nonnegative_int(baseline.get("quarantinedCount"), 0))
    session.failed_count = max(0, int(runtime.failed_count or 0) - nonnegative_int(baseline.get("failedCount"), 0))
    session.last_batch_id = runtime.last_batch_id or session.last_batch_id
    session.last_flush_at = runtime.last_flush_at or session.last_flush_at
    session.lag = runtime.lag
    session.last_error = runtime.last_error
    status_map = {
        "starting": "starting",
        "running": "running",
        "pausing": "stopping",
        "stopping": "stopping",
        "paused": "stopped",
        "stopped": "stopped",
        "failed": "failed",
    }
    session.status = status_map.get(runtime.status, session.status)
    if session.status in {"stopped", "failed"}:
        session.ended_at = session.ended_at or iso_now()
        session.end_reason = optional_string(metrics.get("currentSessionEndReason")) or ("worker_failed" if session.status == "failed" else "worker_stopped")
    sync_kafka_continuous_batches(db, runtime, session, payload or {})
    session.dag_steps = continuous_session_dag_steps(session, runtime, payload or {})
    db.add(session)


def sync_kafka_continuous_batches(
    db: Session,
    runtime: KafkaContinuousRuntimeModel,
    session: KafkaContinuousSessionModel,
    payload: dict[str, Any],
) -> None:
    publications = payload.get("publishedBatches")
    publications = publications if isinstance(publications, list) else []
    candidates: dict[int, dict[str, Any]] = {}
    for publication in publications:
        if not isinstance(publication, dict):
            continue
        publication_batch_id = optional_int(publication.get("batchId"))
        if publication_batch_id is not None:
            candidates[publication_batch_id] = {**publication, "status": "success"}
    last_evidence = payload.get("lastBatchEvidence")
    if not isinstance(last_evidence, dict):
        last_evidence = (runtime.metrics or {}).get("lastBatchEvidence")
    if isinstance(last_evidence, dict):
        evidence_batch_id = optional_int(last_evidence.get("batchId"))
        if evidence_batch_id is not None:
            candidates[evidence_batch_id] = last_evidence
    if not candidates:
        return
    baseline_batch_id = optional_int((session.baseline_counts or {}).get("lastBatchId"))
    latest_batch_id = optional_int(payload.get("lastBatchId"))
    latest_duration_ms = optional_int((runtime.metrics or {}).get("lastBatchDurationMs"))
    catalog_cursor = optional_int((runtime.metrics or {}).get("catalogBatchCursor"))
    for batch_id, publication in sorted(candidates.items()):
        if batch_id is None or (baseline_batch_id is not None and batch_id <= baseline_batch_id):
            continue
        status = str(publication.get("status") or "success")
        if status not in {"running", "success", "failed"}:
            status = "success"
        catalog_applied = status == "success" and catalog_cursor is not None and batch_id <= catalog_cursor
        dag_steps = continuous_batch_dag_steps(publication, status=status, catalog_applied=catalog_applied)
        iceberg_commit = publication.get("icebergCommit") if isinstance(publication.get("icebergCommit"), dict) else {}
        iceberg_target = iceberg_commit.get("target") if isinstance(iceberg_commit.get("target"), dict) else {}
        batch = KafkaContinuousBatchModel(
            id=f"{session.session_id}:{batch_id}",
            job_id=session.job_id,
            session_id=session.session_id,
            batch_id=batch_id,
            status=status,
            published_at=optional_string(publication.get("publishedAt")),
            consumed_count=nonnegative_int(publication.get("consumedCount"), 0),
            stored_count=nonnegative_int(publication.get("storedCount"), 0),
            quarantined_count=nonnegative_int(publication.get("quarantinedCount"), 0),
            duration_ms=latest_duration_ms if batch_id == latest_batch_id and latest_duration_ms is not None else optional_int(publication.get("durationMs")),
            source_ranges=publication.get("sourceRanges") if isinstance(publication.get("sourceRanges"), list) else [],
            source_boundary=publication.get("sourceBoundary") if isinstance(publication.get("sourceBoundary"), dict) else {},
            data_path=optional_string(publication.get("dataPath")),
            iceberg_snapshot_id=optional_string(iceberg_commit.get("snapshotId")),
            iceberg_table_uri=optional_string(iceberg_target.get("tableUri")),
            quarantine_path=optional_string(publication.get("quarantinePath")),
            manifest_path=optional_string(publication.get("manifestPath")),
            last_error=optional_string(publication.get("lastError")),
            dag_steps=dag_steps,
        )
        etl_repository.stage_kafka_continuous_batch(db, batch)


def continuous_batch_dag_steps(
    publication: dict[str, Any],
    *,
    status: str,
    catalog_applied: bool,
) -> list[dict[str, Any]]:
    raw_steps = publication.get("dagSteps")
    if isinstance(raw_steps, list) and raw_steps:
        steps = [dict(step) for step in raw_steps if isinstance(step, dict)]
    else:
        consumed_count = nonnegative_int(publication.get("consumedCount"), 0)
        stored_count = nonnegative_int(publication.get("storedCount"), 0)
        quarantined_count = nonnegative_int(publication.get("quarantinedCount"), 0)
        iceberg_commit = publication.get("icebergCommit") if isinstance(publication.get("icebergCommit"), dict) else {}
        iceberg_target = iceberg_commit.get("target") if isinstance(iceberg_commit.get("target"), dict) else {}
        failed_stage = optional_string(publication.get("failedStage"))
        order = ["source", "schema", "transform", "quality", "target", "manifest-checkpoint", "catalog"]
        failed_index = order.index(failed_stage) if failed_stage in order else -1

        def fallback_status(stage: str) -> str:
            index = order.index(stage)
            if status == "failed" and failed_index >= 0:
                if index < failed_index:
                    return "success"
                if index == failed_index:
                    return "failed"
                return "blocked"
            if stage == "catalog":
                return "success" if catalog_applied else "pending"
            return "success" if status == "success" else "pending"

        steps = [
            {"id": "source", "title": "1. Source", "status": fallback_status("source"), "meta": f"Kafka {consumed_count:,}건 소비", "details": [["입력 행", f"{consumed_count:,}"]]},
            {"id": "schema", "title": "2. Schema", "status": fallback_status("schema"), "meta": "스키마 검증 완료", "details": []},
            {"id": "transform", "title": "3. Transform", "status": fallback_status("transform"), "meta": "규칙 실행 결과", "details": []},
            {"id": "quality", "title": "4. Quality", "status": fallback_status("quality"), "meta": "품질 검사 결과", "details": []},
            {"id": "target", "title": "5. Target", "status": fallback_status("target"), "meta": f"Iceberg {stored_count:,}건 커밋", "details": [["출력 행", f"{stored_count:,}"], ["격리 행", f"{quarantined_count:,}"], ["Table", str(iceberg_target.get("tableUri") or "-")], ["Snapshot", str(iceberg_commit.get("snapshotId") or "-")]]},
            {"id": "manifest-checkpoint", "title": "6. Manifest / Checkpoint", "status": fallback_status("manifest-checkpoint"), "meta": "publication과 offset 근거 저장", "details": [["Manifest", optional_string(publication.get("manifestPath")) or "-"]]},
            {"id": "catalog", "title": "7. Catalog", "status": fallback_status("catalog"), "meta": "Catalog 반영 완료" if catalog_applied else "Catalog 반영 대기", "details": []},
        ]
    completed_at = optional_string(publication.get("publishedAt"))
    patched = []
    for step in steps:
        next_step = dict(step)
        if next_step.get("id") == "catalog" and status == "success":
            next_step["status"] = "success" if catalog_applied else "pending"
            next_step["meta"] = "Catalog 반영 완료" if catalog_applied else "Catalog 반영 대기"
            next_step["details"] = [["상태", "반영 완료" if catalog_applied else "반영 대기"]]
            if catalog_applied and completed_at:
                next_step["completedAt"] = completed_at
            elif not catalog_applied:
                next_step.pop("completedAt", None)
        patched.append(next_step)
    return patched


def continuous_session_dag_steps(
    session: KafkaContinuousSessionModel,
    runtime: KafkaContinuousRuntimeModel,
    payload: dict[str, Any],
) -> list[dict[str, Any]]:
    evidence = payload.get("lastBatchEvidence")
    if not isinstance(evidence, dict):
        evidence = (runtime.metrics or {}).get("lastBatchEvidence")
    if not isinstance(evidence, dict):
        publications = payload.get("publishedBatches")
        evidence = next((item for item in reversed(publications) if isinstance(item, dict)), None) if isinstance(publications, list) else None
    baseline_batch_id = optional_int((session.baseline_counts or {}).get("lastBatchId"))
    evidence_batch_id = optional_int(evidence.get("batchId")) if isinstance(evidence, dict) else None
    if baseline_batch_id is not None and evidence_batch_id is not None and evidence_batch_id <= baseline_batch_id:
        evidence = None
    if not isinstance(evidence, dict):
        source_status = "running" if session.status in {"starting", "running", "stopping"} else "failed" if session.status == "failed" else "success"
        source_logs = [session.last_error] if session.last_error and source_status == "failed" else []
        return [
            {"id": "source", "title": "1. Source", "status": source_status, "meta": "Kafka worker 연결 및 소비 대기", "details": [["세션 소비", f"{session.consumed_count:,}"]], "logs": source_logs},
            {"id": "schema", "title": "2. Schema", "status": "blocked" if source_status == "failed" else "pending", "meta": "첫 batch 대기", "details": []},
            {"id": "transform", "title": "3. Transform", "status": "blocked" if source_status == "failed" else "pending", "meta": "첫 batch 대기", "details": []},
            {"id": "quality", "title": "4. Quality", "status": "blocked" if source_status == "failed" else "pending", "meta": "첫 batch 대기", "details": []},
            {"id": "target", "title": "5. Target", "status": "blocked" if source_status == "failed" else "pending", "meta": "첫 batch 대기", "details": []},
            {"id": "manifest-checkpoint", "title": "6. Manifest / Checkpoint", "status": "blocked" if source_status == "failed" else "pending", "meta": "첫 batch 대기", "details": [["Checkpoint", session.checkpoint_path]]},
            {"id": "catalog", "title": "7. Catalog", "status": "blocked" if source_status == "failed" else "pending", "meta": "첫 batch 대기", "details": []},
        ]
    batch_id = optional_int(evidence.get("batchId"))
    catalog_cursor = optional_int((runtime.metrics or {}).get("catalogBatchCursor"))
    evidence_status = str(evidence.get("status") or "success")
    steps = continuous_batch_dag_steps(
        evidence,
        status=evidence_status,
        catalog_applied=evidence_status == "success" and batch_id is not None and catalog_cursor is not None and batch_id <= catalog_cursor,
    )
    for step in steps:
        if step.get("id") == "source":
            step["meta"] = f"세션 누적 {session.consumed_count:,}건 소비"
            step["details"] = [["세션 소비", f"{session.consumed_count:,}"], ["Kafka Lag", "-" if session.lag is None else f"{session.lag:,}"]]
            if session.status in {"starting", "running", "stopping"} and evidence_status != "failed":
                step["status"] = "running"
                step.pop("completedAt", None)
                step.pop("duration", None)
        elif step.get("id") == "target":
            step["meta"] = f"세션 누적 {session.stored_count:,}건 적재 · 격리 {session.quarantined_count:,}"
        elif step.get("id") == "manifest-checkpoint":
            details = [item for item in step.get("details", []) if isinstance(item, list) and item and item[0] != "Checkpoint"]
            step["details"] = [*details, ["Checkpoint", session.checkpoint_path]]
    if session.status == "failed" and evidence_status != "failed":
        for index, step in enumerate(steps):
            if index == 0:
                step.update({"status": "failed", "meta": "Kafka worker 실행 실패", "logs": [session.last_error or "Continuous worker failed"]})
            else:
                step["status"] = "blocked"
                step.pop("completedAt", None)
                step.pop("duration", None)
    return steps


def refresh_kafka_continuous_runtime(db: Session, job: ETLJobModel) -> None:
    reconcile_continuous_runtime(
        db,
        job,
        worker=CallableKafkaRuntimeGateway(run_kafka_continuous_worker),
        hooks=ContinuousReconciliationHooks(
            reconcile_stale_maintenance=reconcile_stale_continuous_maintenance_runs,
            reconcile_pending_replay=reconcile_pending_continuous_replay_catalog,
            report_path=continuous_runtime_report_path,
            read_report=lambda path: read_runtime_json(path),
            worker_status=continuous_worker_status,
            materialize_batch=materialize_continuous_batch,
            sync_session=sync_kafka_continuous_session,
            write_ack=write_continuous_catalog_ack,
            mark_failed=mark_continuous_runtime_failed,
            apply_report=_apply_continuous_runtime_report,
        ),
    )


EXPORTED_FUNCTIONS = (
    'require_no_active_continuous_maintenance',
    'require_continuous_job_access',
    'require_continuous_maintenance_idle',
    'begin_kafka_continuous_session',
    'current_kafka_continuous_session',
    'fail_kafka_continuous_session',
    'mark_kafka_continuous_session_stopping',
    'sync_kafka_continuous_session',
    'sync_kafka_continuous_batches',
    'continuous_batch_dag_steps',
    'continuous_session_dag_steps',
    'refresh_kafka_continuous_runtime',
)

IMPLEMENTATIONS = {name: globals()[name] for name in EXPORTED_FUNCTIONS}
