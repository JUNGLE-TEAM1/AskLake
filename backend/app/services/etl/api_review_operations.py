"""API commands, connectors, and review operations behind the ETL facade."""

from __future__ import annotations

RUNTIME_NAMES = {
    'ApiError',
    'CallableKafkaRuntimeGateway',
    'CatalogRepository',
    'ContinuousCommandHooks',
    'ContinuousCommandRequest',
    'ErrorCode',
    'Exception',
    'NodeSourceConnectorGateway',
    'PERMISSION_REVIEW_ACTION_LABELS',
    'ReviewEntry',
    'ReviewSchemaRow',
    'ReviewSnapshot',
    'ReviewValidationRow',
    'SchemaDraft',
    'SourceConnectorRequest',
    'UI_MANAGED_SOURCES',
    'any',
    'begin_kafka_continuous_session',
    'blocked_principal_for_actor',
    'bool',
    'compile_pipeline_rules',
    'continuous_runtime_from_job',
    'dict',
    'execute_continuous_command',
    'execute_list_source_assets',
    'execute_test_source_connector',
    'fail_kafka_continuous_session',
    'field_value',
    'has_pending_continuous_replay_catalog',
    'hasattr',
    'is_internal_data_lake_source',
    'is_kafka_job',
    'isinstance',
    'legacy_permission_grants',
    'len',
    'list',
    'list_permission_grants_by_resource',
    'locked_resource_ids',
    'mark_kafka_continuous_session_stopping',
    'merge_permission_grants',
    'next',
    'normalize_column_name',
    'permission_grants_for_etl_job',
    'permission_grants_for_resource',
    'permission_review_entries',
    'permissions_for_actor_with_governance',
    'permissions_for_actor_with_governance_state',
    'persisted_stream_partition_cursors',
    'reconcile_pending_continuous_replay_catalog',
    'reconcile_stale_continuous_maintenance_runs',
    'require_no_active_continuous_maintenance',
    'resolve_internal_data_lake_source',
    'review_entry',
    'review_permission_issue',
    'review_validation',
    'run_kafka_continuous_worker',
    'status',
    'str',
    'sum',
    'target_contract_issue',
    'test_source_connector',
    'with_job_permissions',
}


def command_kafka_continuous_job(
    db: Session,
    job: ETLJobModel,
    command: str,
    actor: ActorContext,
) -> JobCommandResponse:
    return execute_continuous_command(
        db,
        job,
        ContinuousCommandRequest(command=command, job_id=job.id),
        actor,
        worker=CallableKafkaRuntimeGateway(run_kafka_continuous_worker),
        hooks=ContinuousCommandHooks(
            is_kafka_job=is_kafka_job,
            runtime_from_job=continuous_runtime_from_job,
            reconcile_stale_maintenance=reconcile_stale_continuous_maintenance_runs,
            require_no_active_maintenance=require_no_active_continuous_maintenance,
            reconcile_pending_replay=reconcile_pending_continuous_replay_catalog,
            has_pending_replay=has_pending_continuous_replay_catalog,
            begin_session=begin_kafka_continuous_session,
            persisted_partition_cursors=persisted_stream_partition_cursors,
            fail_session=fail_kafka_continuous_session,
            mark_session_stopping=mark_kafka_continuous_session_stopping,
            with_permissions=with_job_permissions,
        ),
    )


def with_job_permissions(db: Session, job: JobRowData, actor: ActorContext) -> JobRowData:
    job_with_grants = job.model_copy(update={
        "permission_grants": permission_grants_for_etl_job(db, job),
    })
    grant_payloads = [
        grant.model_dump(by_alias=True) if hasattr(grant, "model_dump") else grant
        for grant in job_with_grants.permission_grants
    ]
    return job_with_grants.model_copy(update={
        "permissions": permissions_for_actor_with_governance(
            db,
            actor,
            owner=job_with_grants.owner,
            grants=grant_payloads,
            resource_id=job_with_grants.id,
            resource_type="etl_job",
        ),
    })


def with_jobs_permissions(
    db: Session,
    jobs: list[JobRowData],
    actor: ActorContext,
) -> list[JobRowData]:
    """Project list permissions with a fixed number of database reads."""
    if not jobs:
        return []

    persisted_grants = list_permission_grants_by_resource(
        db,
        [("etl_job", job.id) for job in jobs],
    )
    principal_blocked = blocked_principal_for_actor(db, actor) is not None
    locked_job_ids = locked_resource_ids(
        db,
        resource_ids=[job.id for job in jobs],
        resource_type="etl_job",
    )

    projected_jobs: list[JobRowData] = []
    for job in jobs:
        stored_grants = persisted_grants.get(("etl_job", job.id), [])
        has_ui_managed_grants = any(
            grant.source in UI_MANAGED_SOURCES
            for grant in stored_grants
        )
        effective_grants = merge_permission_grants(
            stored_grants,
            [] if has_ui_managed_grants else legacy_permission_grants(job.permission_roles),
        )
        grant_payloads = [grant.model_dump(by_alias=True) for grant in effective_grants]
        projected_jobs.append(job.model_copy(update={
            "permission_grants": effective_grants,
            "permissions": permissions_for_actor_with_governance_state(
                actor,
                owner=job.owner,
                grants=grant_payloads,
                principal_blocked=principal_blocked,
                resource_locked=job.id in locked_job_ids,
            ),
        }))
    return projected_jobs


def test_source_connector(request: SourceConnectorRequest) -> SourceConnectorAnalysis:
    return execute_test_source_connector(
        request,
        gateway=NodeSourceConnectorGateway(),
    )


def is_internal_data_lake_source(source_type: str | None) -> bool:
    return str(source_type or "").strip().casefold() == "data lake"


def resolve_internal_data_lake_source(
    db: Session,
    source_config: Any,
    *,
    actor: ActorContext | None = None,
) -> dict[str, Any]:
    dataset_id = field_value(source_config or [], "Source Dataset ID").strip()
    if not dataset_id:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "Data Lake source requires Source Dataset ID.",
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    payload = CatalogRepository(db).get_dataset_payload(dataset_id)
    if payload is None:
        raise ApiError(ErrorCode.NOT_FOUND, f"Dataset not found: {dataset_id}", status.HTTP_404_NOT_FOUND)
    if str(payload.get("status") or "").strip().casefold() != "available":
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            "Data Lake source dataset is not available.",
            status.HTTP_409_CONFLICT,
            {"datasetId": dataset_id, "datasetStatus": payload.get("status")},
        )

    query_engine_table = payload.get("queryEngineTable")
    query_engine_status = str(payload.get("queryEngineStatus") or "").strip().casefold()
    if (
        not isinstance(query_engine_table, dict)
        or str(query_engine_table.get("format") or "").strip().casefold() != "iceberg"
        or query_engine_status != "available"
        or not str(query_engine_table.get("schema") or "").strip()
        or not str(query_engine_table.get("table") or "").strip()
    ):
        raise ApiError(
            ErrorCode.INVALID_JOB_STATE,
            "Data Lake source dataset requires an available Iceberg table.",
            status.HTTP_409_CONFLICT,
            {"datasetId": dataset_id, "queryEngineStatus": query_engine_status or "unavailable"},
        )

    if actor is not None:
        fallback_grants = payload.get("permissionGrants") if isinstance(payload.get("permissionGrants"), list) else []
        grants = permission_grants_for_resource(db, "dataset", dataset_id, fallback_grants)
        grant_payloads = [grant.model_dump(mode="json", by_alias=True) for grant in grants]
        permissions = permissions_for_actor_with_governance(
            db,
            actor,
            owner=str(payload.get("owner") or "") or None,
            grants=grant_payloads,
            resource_id=dataset_id,
            resource_type="dataset",
        )
        if not permissions.can_view:
            raise ApiError(
                ErrorCode.FORBIDDEN,
                f"Actor {actor.name} is not allowed to view this dataset",
                status.HTTP_403_FORBIDDEN,
                {"datasetId": dataset_id},
            )

    return {
        "catalog": str(query_engine_table.get("catalog") or "iceberg"),
        "format": "iceberg",
        "namespace": str(query_engine_table["schema"]),
        "table": str(query_engine_table["table"]),
    }


def list_source_assets(request: SourceAssetsRequest) -> SourceAssetsResponse:
    return execute_list_source_assets(
        request,
        gateway=NodeSourceConnectorGateway(),
    )


def infer_schema(request: SourceConnectorRequest) -> SchemaDraft:
    analysis = test_source_connector(request)
    if analysis.draft_patch.schema_ is None:
        return SchemaDraft(columns=[], sample_rows=[], summary="스키마 없음")
    return analysis.draft_patch.schema_


def review_pipeline(
    request: ReviewPipelineRequest,
    *,
    db: Session | None = None,
    actor: ActorContext | None = None,
) -> ReviewSnapshot:
    source_ready = request.source_connection_status == "success"
    if source_ready and is_internal_data_lake_source(request.source_type):
        try:
            if db is None or actor is None:
                source_ready = False
            else:
                resolve_internal_data_lake_source(db, request.source_config, actor=actor)
        except Exception:
            source_ready = False
    elif source_ready and request.source_type != "SQL Result":
        try:
            source_ready = test_source_connector(
                SourceConnectorRequest(source_type=request.source_type, source_config=request.source_config)
            ).status == "success"
        except Exception:
            source_ready = False

    included_columns = [column for column in request.schema_columns if column.included and column.target_name.strip()]
    compiled_rules = compile_pipeline_rules(request)
    output_columns = compiled_rules.result.output_schema
    schema_ready = bool(included_columns)
    rules_ready = compiled_rules.result.status == "pass"
    enabled_rule_count = sum(1 for rule in compiled_rules.result.rules if rule.enabled)
    rule_ready_value = "pass-through" if enabled_rule_count == 0 else f"{enabled_rule_count}개 규칙 compile 완료"
    rule_warning_value = compiled_rules.result.issues[0].message if compiled_rules.result.issues else "규칙 확인 필요"
    record_parsing_ready = not (request.record_parsing and request.record_parsing.enabled) or (
        request.record_parsing.expected_field_count > 0
        and len(request.record_parsing.columns) == request.record_parsing.expected_field_count
        and len({normalize_column_name(column.name) for column in request.record_parsing.columns}) == len(request.record_parsing.columns)
    )
    target_issue = target_contract_issue(
        source_type=request.source_type,
        execution_mode=request.execution_mode,
        target_layer=request.target_layer,
        target_format=request.target_format,
    )
    target_ready = target_issue is None and bool(
        request.target_dataset.strip()
        and str(request.target_layer).strip()
        and request.target_format.strip()
    )
    permission_issue = review_permission_issue(request)
    permission_ready = permission_issue is None
    can_create = (
        source_ready
        and schema_ready
        and rules_ready
        and record_parsing_ready
        and target_ready
        and permission_ready
        and bool(request.source_type.strip())
        and bool(request.source_label.strip())
        and bool(request.target_dataset.strip())
        and bool(request.owner.strip())
    )

    source_type = "PostgreSQL" if request.source_type == "Database" else request.source_type
    source_display = " · ".join(value for value in [source_type, request.source_label] if value.strip())

    return ReviewSnapshot(
        basic_information=[
            review_entry("소스", source_display),
            review_entry("처리 방식", "실시간 스트리밍" if request.execution_mode == "continuous" else "배치 처리"),
            review_entry("출력 데이터셋 이름", request.target_dataset),
            review_entry("설명", request.target_description),
        ],
        can_create=can_create,
        destination=[
            review_entry("저장 경로", request.storage_path),
            review_entry("데이터베이스", request.target_database or "asklake"),
            review_entry("형식", request.target_format),
            review_entry("파티션", request.partition or "없음"),
        ],
        permission=permission_review_entries(request),
        rule_compilation=compiled_rules.result,
        schema=[
            ReviewSchemaRow(
                column_name=name,
                nullable=("예" if column.nullable else "아니요") if (column := next((item for item in included_columns if item.target_name == name or item.source_name == name), None)) else "생성",
                transform=(f"원본.{column.source_name}" if column and column.source_name == name else f"{column.source_name} -> {name}" if column else "변환 출력"),
                type=type_ or "string",
            )
            for name, type_ in output_columns
        ],
        validation=[
            review_validation("소스 데이터", source_ready, "연결됨", "연결 확인 필요"),
            *([review_validation("레코드 구조화", record_parsing_ready, "확정됨", "구조화 규칙 확인 필요")] if request.record_parsing and request.record_parsing.enabled else []),
            review_validation("출력 스키마", schema_ready, "확정됨", "필드 선택 필요"),
            review_validation("처리 규칙", rules_ready, rule_ready_value, rule_warning_value),
            review_validation("접근 권한", permission_ready, "설정됨", permission_issue or "권한 확인 필요"),
            review_validation("저장 위치", target_ready, "설정됨", target_issue or "출력 데이터셋 이름 확인 필요"),
        ],
    )


def review_entry(label: str, value: str | None) -> ReviewEntry:
    return ReviewEntry(label=label, value=(value or "").strip() or "미설정")


def permission_review_entries(request: ReviewPipelineRequest) -> list[ReviewEntry]:
    grants = request.permission_grants or []
    public_view = any(
        str(grant.principal_type) == "public" and "view" in grant.actions
        for grant in grants
    )
    entries = [
        review_entry("담당자", f"{request.owner} · 모든 작업 가능"),
        review_entry("로그인한 모든 사용자", "조회 가능" if public_view else "조회 불가"),
    ]
    principal_labels = {
        "group": "그룹",
        "user": "사용자",
        "role": "역할",
        "public": "모든 사용자",
    }

    for grant in grants:
        principal_type = str(grant.principal_type)
        if principal_type == "public":
            continue
        label = principal_labels.get(principal_type, principal_type)
        principal = grant.principal_name or grant.principal_id
        actions = " · ".join(
            PERMISSION_REVIEW_ACTION_LABELS.get(str(action), str(action))
            for action in grant.actions
        ) or "권한 없음"
        entries.append(review_entry(f"{principal} ({label})", actions))

    return entries


def review_permission_issue(request: ReviewPipelineRequest) -> str | None:
    if not request.owner.strip():
        return "담당자 확인 필요"
    for grant in request.permission_grants or []:
        principal_type = str(grant.principal_type)
        if principal_type != "public" and not grant.principal_id.strip():
            return "권한 대상 확인 필요"
        if not grant.actions:
            return "허용 작업 확인 필요"
    return None


def review_validation(label: str, ready: bool, ready_value: str, warning_value: str) -> ReviewValidationRow:
    return ReviewValidationRow(label=label, status="ready" if ready else "warning", value=ready_value if ready else warning_value)


EXPORTED_FUNCTIONS = (
    'command_kafka_continuous_job',
    'with_job_permissions',
    'with_jobs_permissions',
    'test_source_connector',
    'is_internal_data_lake_source',
    'resolve_internal_data_lake_source',
    'list_source_assets',
    'infer_schema',
    'review_pipeline',
    'review_entry',
    'permission_review_entries',
    'review_permission_issue',
    'review_validation',
)

IMPLEMENTATIONS = {name: globals()[name] for name in EXPORTED_FUNCTIONS}
