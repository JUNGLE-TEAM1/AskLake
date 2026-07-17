"""API permissions, pipeline, and job query operations behind the ETL facade."""

from __future__ import annotations

RUNTIME_NAMES = {
    'ActorContext',
    'ApiError',
    'AuthUserModel',
    'Base',
    'CompatibilityPath',
    'CreatePipelineMappingContext',
    'DEMO_GROUPS',
    'DEMO_USERS',
    'ErrorCode',
    'EtlJobDeleteHooks',
    'EtlJobQueryHooks',
    'EtlPipelineCreateHooks',
    'EtlPipelineUpdateHooks',
    'Exception',
    'LEGACY_PERMISSION_GROUP_IDS',
    'PERMISSION_GROUP_ACTIONS',
    'PermissionGrant',
    'PermissionOptionGroup',
    'PermissionOptionUser',
    'PermissionOptionsResponse',
    'QueryRunResponse',
    'ScheduledJobRunItem',
    'ScheduledJobRunResponse',
    'SimpleNamespace',
    'SourceConnectorDefaults',
    'add_audit_event',
    'advance_scheduled_job_after_tick',
    'any',
    'apply_append_request_to_job',
    'apply_compiled_rules',
    'apply_update_request',
    'build_iceberg_writer_target',
    'command_job',
    'compile_pipeline_rules',
    'continuous_checkpoint_initialized',
    'continuous_config_from_request',
    'continuous_processing_contract_changed',
    'continuous_replay_result_is_durable',
    'continuous_runtime_from_job',
    'continuous_runtime_report_path',
    'dataset_sample_rows_from_request',
    'dataset_schema_from_request',
    'dict',
    'ensure_legacy_permission_grants',
    'ensure_scheduled_job_next_run',
    'etl_repository',
    'execute_create_pipeline',
    'execute_delete_job',
    'execute_update_pipeline',
    'fallback_lineage_graph',
    'getattr',
    'has_successful_run',
    'hydrate_job_list_query',
    'hydrate_job_query',
    'identity_name',
    'identity_profile',
    'initial_dag_steps',
    'initial_job_stats',
    'is_internal_data_lake_source',
    'isinstance',
    'iso_now',
    'job_schedule_kind',
    'legacy_permission_grants',
    'len',
    'list',
    'make_dataset_id',
    'make_job_id',
    'map_create_request_to_job',
    'max',
    'nonnegative_int',
    'normalize_actions',
    'normalize_string_list',
    'os',
    'permission_grants_for_etl_job',
    'permission_grants_for_resource',
    'persist_requested_permission_grants',
    'pipeline_create_mapping_context',
    'range',
    'read_runtime_json',
    'reconcile_stale_continuous_maintenance_runs',
    'record_compatibility_path',
    'recover_continuous_replay_result',
    'refresh_kafka_continuous_runtime',
    'replace_permission_ui_grants',
    'require_compiled_rules',
    'require_governed_access',
    'require_permission',
    'resolve_internal_data_lake_source',
    'safe_record_audit_event',
    'schedule_next_run_label',
    'schedule_policy_from_request',
    'select',
    'should_run_scheduled_job',
    'source_metrics_from_request',
    'stable_id',
    'status',
    'str',
    'sum',
    'sync_airflow_runs_for_job',
    'target_identity_changed',
    'trino_sql_job_run_as_actor',
    'validate_create_request',
    'validate_target_contract',
    'validate_update_request',
    'with_job_permissions',
    'writer_mode_for_pipeline',
}


def source_connector_defaults() -> SourceConnectorDefaults:
    return SourceConnectorDefaults(
        kafka_broker=os.environ.get("ASKLAKE_KAFKA_BROKER") or "127.0.0.1:19092",
        kafka_topic=(
            os.environ.get("ASKLAKE_SOURCE_DEFAULT_KAFKA_TOPIC")
            or os.environ.get("ASKLAKE_KAFKA_TOPIC")
            or "asklake-source-events"
        ),
        s3_bucket=(
            os.environ.get("ASKLAKE_SOURCE_DEFAULT_S3_BUCKET")
            or os.environ.get("ASKLAKE_RAW_BUCKET")
            or ""
        ),
        s3_prefix=os.environ.get("ASKLAKE_SOURCE_DEFAULT_S3_PREFIX") or "",
    )


def legacy_permission_grants(roles: list[dict[str, Any]] | None) -> list[PermissionGrant]:
    grants: list[PermissionGrant] = []
    for role in roles or []:
        if not isinstance(role, dict) or role.get("checked") is False:
            continue
        name = str(role.get("name") or "").strip()
        if not name:
            continue
        group_id = LEGACY_PERMISSION_GROUP_IDS.get(name.casefold())
        grants.append(PermissionGrant(
            actions=normalize_actions(role.get("access")) or ["view"],
            principal_id=group_id or name,
            principal_type="group" if group_id else "role",
            source="legacy_permission_roles",
        ))
    if grants:
        record_compatibility_path(
            CompatibilityPath.ETL_LEGACY_PERMISSION_ROLES,
            reason="legacy permissionRoles are being projected into persisted grants",
            context={"grantCount": len(grants)},
        )
    return grants


def permission_grants_for_etl_job(
    db: Session,
    job: ETLJobModel | JobRowData,
) -> list[PermissionGrant]:
    ensure_legacy_permission_grants(
        db,
        resource_type="etl_job",
        resource_id=job.id,
        grants=legacy_permission_grants(job.permission_roles),
        created_by=job.owner,
    )
    return permission_grants_for_resource(db, "etl_job", job.id, [])


def get_permission_options(
    db: Session,
    actor: ActorContext,
    job_id: str | None = None,
) -> PermissionOptionsResponse:
    if job_id:
        job = etl_repository.get_job(db, job_id)
        if job is None:
            raise ApiError(ErrorCode.NOT_FOUND, f"Job not found: {job_id}", status.HTTP_404_NOT_FOUND)
        is_creator = actor.name == job.created_by
        is_owner = actor.name == job.owner
        if not actor.is_admin and not is_creator and not is_owner:
            require_permission(
                actor,
                "manage",
                owner=job.owner,
                grants=permission_grants_for_etl_job(db, job),
                resource_label="job permissions",
            )
    Base.metadata.create_all(bind=db.get_bind(), tables=[AuthUserModel.__table__])
    stored_users = list(db.scalars(select(AuthUserModel).order_by(AuthUserModel.display_name.asc())).all())
    users = stored_users or [
        SimpleNamespace(
            id=value["id"],
            display_name=value["display_name"],
            email=value["email"],
            role=value["role"],
        )
        for value in DEMO_USERS.values()
    ]
    return PermissionOptionsResponse(
        groups=[
            PermissionOptionGroup(
                id=group.id,
                name=group.name,
                description=group.description,
                actions=PERMISSION_GROUP_ACTIONS.get(group.id, ["view", "run"]),
            )
            for group in DEMO_GROUPS.values()
        ],
        users=[
            PermissionOptionUser(
                id=user.id,
                name=user.display_name,
                email=user.email,
                initials="".join(part[0] for part in user.display_name.split()[:2]).upper() or user.display_name[:2].upper(),
                role=user.role,
            )
            for user in users
        ],
    )


def create_pipeline(
    db: Session,
    request: CreatePipelineRequest,
    actor: ActorContext | str = "demo-user",
) -> CreatePipelineResponse:
    return execute_create_pipeline(
        db,
        request,
        actor,
        hooks=EtlPipelineCreateHooks(
            apply_append_request_to_job=apply_append_request_to_job,
            apply_compiled_rules=apply_compiled_rules,
            build_mapping_context=pipeline_create_mapping_context,
            compile_pipeline_rules=compile_pipeline_rules,
            continuous_runtime_from_job=continuous_runtime_from_job,
            identity_name=identity_name,
            identity_profile=identity_profile,
            is_internal_data_lake_source=is_internal_data_lake_source,
            make_dataset_id=make_dataset_id,
            make_job_id=make_job_id,
            map_create_request_to_job=map_create_request_to_job,
            persist_permission_grants=persist_requested_permission_grants,
            require_compiled_rules=require_compiled_rules,
            resolve_internal_data_lake_source=resolve_internal_data_lake_source,
            validate_create_request=validate_create_request,
        ),
    )


def pipeline_create_mapping_context(
    request: CreatePipelineRequest,
    *,
    dataset_id: str,
    job_id: str,
    created_by: str,
    created_by_profile: dict[str, Any],
) -> CreatePipelineMappingContext:
    dataset_schema = dataset_schema_from_request(request)
    sample_rows = dataset_sample_rows_from_request(request, dataset_schema)
    metrics = source_metrics_from_request(request, dataset_schema, sample_rows)
    schedule_policy = schedule_policy_from_request(request)
    return CreatePipelineMappingContext(
        continuous_config=continuous_config_from_request(request, job_id),
        created_by=created_by,
        created_by_profile=created_by_profile,
        dag_steps=initial_dag_steps(request, metrics),
        dataset_id=dataset_id,
        iceberg_target=build_iceberg_writer_target(
            request.target_dataset,
            dataset_id,
            write_mode=writer_mode_for_pipeline(request.source_type, request.source_config),
            partition_columns=normalize_string_list(request.partition_columns),
        ).model_dump(mode="json", by_alias=True),
        job_id=job_id,
        metrics=metrics,
        next_run=schedule_next_run_label(
            request.schedule_label,
            schedule_policy.get("nextRunUtc"),
        ),
        schedule_policy=schedule_policy,
        stats=initial_job_stats(metrics),
    )


def list_jobs(
    db: Session,
    actor: ActorContext | None = None,
    last_run_outcome: JobRunOutcome | None = None,
    owner: str | None = None,
    statuses: list[str] | None = None,
    schedule_kind: JobScheduleKind | None = None,
) -> JobListResponse:
    return hydrate_job_list_query(
        db,
        actor,
        last_run_outcome=last_run_outcome,
        owner=owner,
        statuses=statuses,
        schedule_kind=schedule_kind,
        hooks=EtlJobQueryHooks(
            record_audit_event=safe_record_audit_event,
            refresh_continuous_runtime=refresh_kafka_continuous_runtime,
            schedule_kind=job_schedule_kind,
            sync_airflow_runs=sync_airflow_runs_for_job,
            with_permissions=with_job_permissions,
        ),
    )


def continuous_report_has_unacknowledged_publication(
    job_id: str,
    runtime: KafkaContinuousRuntimeModel,
    *,
    document_store: RuntimeDocumentStore | None = None,
) -> bool:
    report_path = continuous_runtime_report_path(job_id)
    document = read_runtime_json(report_path, document_store=document_store)
    if not document.found:
        return False
    report = document.value or {}
    publications = report.get("publishedBatches")
    cursor = nonnegative_int((runtime.metrics or {}).get("catalogBatchCursor"), -1)
    if not isinstance(publications, list) or not publications:
        return (
            report.get("lastBatchWritten") is True
            and nonnegative_int(report.get("lastBatchId"), -1) > cursor
        )
    if any(
        isinstance(publication, dict)
        and nonnegative_int(publication.get("batchId"), -1) > cursor
        for publication in publications
    ):
        return True
    return (
        report.get("lastBatchWritten") is True
        and nonnegative_int(report.get("lastBatchId"), -1) > cursor
    )


def has_pending_continuous_replay_catalog(
    db: Session,
    job_or_id: ETLJobModel | str,
) -> bool:
    job = job_or_id if not isinstance(job_or_id, str) else None
    job_id = job_or_id if isinstance(job_or_id, str) else job_or_id.id
    maintenance_runs = etl_repository.list_kafka_continuous_maintenance_run_models(
        db,
        job_id,
        active_only=False,
    )
    for run in maintenance_runs:
        if run.kind != "quarantine_replay" or run.status not in {"failed", "success"}:
            continue
        result = dict(run.result or {}) if isinstance(run.result, dict) else {}
        if result.get("catalogApplied") is True and result.get("countersApplied") is True:
            continue
        if continuous_replay_result_is_durable(result):
            return True
        if job is None:
            try:
                job = etl_repository.get_job(db, job_id)
            except Exception:
                job = None
        recovery_state, recovered, _reason = recover_continuous_replay_result(
            job,
            run.run_id,
            result,
        )
        if recovery_state == "unavailable":
            return True
        if recovery_state == "found" and continuous_replay_result_is_durable(recovered):
            return True
    return False


def run_due_scheduled_jobs(
    db: Session,
    request: ScheduledJobRunRequest,
    actor: ActorContext | None = None,
) -> ScheduledJobRunResponse:
    jobs = etl_repository.list_job_models(db)
    if request.job_id:
        jobs = [job for job in jobs if job.id == request.job_id]
    items: list[ScheduledJobRunItem] = []
    actor_context = actor or ActorContext(name="scheduler", role="admin")

    for job in jobs:
        ensure_scheduled_job_next_run(db, job)
        should_run, reason = should_run_scheduled_job(job, request)
        if not should_run:
            items.append(ScheduledJobRunItem(
                job_id=job.id,
                job_name=job.name,
                reason=reason,
                schedule=job.schedule,
                triggered=False,
            ))
            continue

        command_kwargs: dict[str, ActorContext] = {}
        if getattr(job, "job_kind", None) == "trino_sql_materialization":
            command_kwargs["execution_actor"] = trino_sql_job_run_as_actor(db, job)
        response = command_job(
            db,
            job.id,
            "run",
            actor_context,
            **command_kwargs,
        )
        if reason == "due":
            advance_scheduled_job_after_tick(db, job.id)
        items.append(ScheduledJobRunItem(
            job_id=job.id,
            job_name=job.name,
            reason=reason,
            response=response,
            schedule=job.schedule,
            triggered=True,
        ))

    return ScheduledJobRunResponse(
        checked_count=len(items),
        items=items,
        triggered_count=sum(1 for item in items if item.triggered),
    )


def get_job(db: Session, job_id: str, actor: ActorContext | None = None) -> JobRowData:
    return hydrate_job_query(
        db,
        job_id,
        actor,
        hooks=EtlJobQueryHooks(
            record_audit_event=safe_record_audit_event,
            refresh_continuous_runtime=refresh_kafka_continuous_runtime,
            schedule_kind=job_schedule_kind,
            sync_airflow_runs=sync_airflow_runs_for_job,
            with_permissions=with_job_permissions,
        ),
    )


def update_pipeline(
    db: Session,
    job_id: str,
    request: UpdatePipelineRequest,
    actor: ActorContext | None = None,
) -> JobRowData:
    return execute_update_pipeline(
        db,
        job_id,
        request,
        actor,
        hooks=EtlPipelineUpdateHooks(
            apply_compiled_rules=apply_compiled_rules,
            apply_update_request=apply_update_request,
            compile_pipeline_rules=compile_pipeline_rules,
            continuous_checkpoint_initialized=continuous_checkpoint_initialized,
            continuous_processing_contract_changed=continuous_processing_contract_changed,
            has_successful_run=has_successful_run,
            permission_grants_for_job=permission_grants_for_etl_job,
            persist_permission_grants=persist_requested_permission_grants,
            require_compiled_rules=require_compiled_rules,
            require_governed_access=require_governed_access,
            require_permission=require_permission,
            target_identity_changed=target_identity_changed,
            validate_target_contract=validate_target_contract,
            validate_update_request=validate_update_request,
            with_permissions=with_job_permissions,
        ),
    )


def persist_requested_permission_grants(
    db: Session,
    job: JobRowData,
    grants: list[Any] | None,
    created_by: str,
    actor: ActorContext,
) -> JobRowData:
    if grants is None:
        return job
    replace_permission_ui_grants(
        db,
        resource_type="etl_job",
        resource_id=job.id,
        grants=grants,
        created_by=created_by,
    )
    refreshed_job = etl_repository.get_job_schema(db, job.id) or job
    return with_job_permissions(db, refreshed_job, actor)


def delete_job(db: Session, job_id: str, actor: ActorContext | None = None) -> str:
    return execute_delete_job(
        db,
        job_id,
        actor,
        hooks=EtlJobDeleteHooks(
            add_audit_event=add_audit_event,
            permission_grants_for_job=permission_grants_for_etl_job,
            reconcile_stale_maintenance_runs=reconcile_stale_continuous_maintenance_runs,
            record_audit_event=safe_record_audit_event,
            require_governed_access=require_governed_access,
            require_permission=require_permission,
        ),
    )


def list_datasets(db: Session) -> list[CatalogDataset]:
    return etl_repository.list_datasets(db)


def get_dataset(db: Session, dataset_id: str) -> CatalogDataset:
    dataset = etl_repository.get_dataset_schema_by_id(db, dataset_id)
    if dataset is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Dataset not found: {dataset_id}", status.HTTP_404_NOT_FOUND)
    return dataset


def get_dataset_lineage(db: Session, dataset_id: str) -> dict[str, Any]:
    dataset = etl_repository.get_dataset_by_id(db, dataset_id)
    if dataset is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Dataset not found: {dataset_id}", status.HTTP_404_NOT_FOUND)
    payload_lineage = dataset.payload.get("lineageGraph") if dataset.payload else None
    if isinstance(payload_lineage, dict):
        return payload_lineage
    return dataset.lineage_graph or fallback_lineage_graph(dataset)


def execute_query(db: Session, request: QueryRunRequest) -> QueryRunResponse:
    dataset = etl_repository.get_dataset_by_id(db, request.dataset_id)
    if dataset is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Dataset not found: {request.dataset_id}", status.HTTP_404_NOT_FOUND)

    columns = [column[0] for column in (dataset.schema_json or [])[:6] if column]
    if not columns and dataset.sample_rows:
        columns = [f"col_{index + 1}" for index in range(len(dataset.sample_rows[0]))]
    width = max(len(columns), 1)
    rows = [[str(cell) for cell in row[:width]] for row in (dataset.sample_rows or [])]
    return QueryRunResponse(
        columns=columns,
        dataset_id=dataset.id,
        dataset_name=dataset.name,
        executed_at=iso_now(),
        query=request.query,
        row_count=len(rows),
        rows=rows,
        run_id=stable_id("sql", f"{dataset.id}:{request.query}:{iso_now()}"),
    )


EXPORTED_FUNCTIONS = (
    'source_connector_defaults',
    'legacy_permission_grants',
    'permission_grants_for_etl_job',
    'get_permission_options',
    'create_pipeline',
    'pipeline_create_mapping_context',
    'list_jobs',
    'continuous_report_has_unacknowledged_publication',
    'has_pending_continuous_replay_catalog',
    'run_due_scheduled_jobs',
    'get_job',
    'update_pipeline',
    'persist_requested_permission_grants',
    'delete_job',
    'list_datasets',
    'get_dataset',
    'get_dataset_lineage',
    'execute_query',
)

IMPLEMENTATIONS = {name: globals()[name] for name in EXPORTED_FUNCTIONS}
