import hashlib
import json
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import status
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext
from app.core.config import Settings
from app.core.errors import ApiError
from app.models import (
    TextStructuringModelModel,
    TextStructuringReviewItemModel,
    TextStructuringSpecModel,
    TextStructuringSpecVersionModel,
    TextStructuringTrainingRunModel,
)
from app.repositories.text_structuring_repository import TextStructuringRepository
from app.schemas.common import ErrorCode
from app.schemas.text_structuring import (
    CreateTextStructuringSpecRequest,
    CreateTextStructuringVersionRequest,
    CreateTextTrainingRunRequest,
    TextFieldSpec,
    TextLabelSpec,
    TextModelResponse,
    TextRepeatedGroupSpec,
    TextReviewItemResponse,
    TextRoutingPolicy,
    TextStructuringBatchRequest,
    TextStructuringBatchResponse,
    TextStructuringDefinition,
    TextStructuringPreviewRequest,
    TextStructuringPreviewResponse,
    TextStructuringSpecRef,
    TextStructuringSpecResponse,
    TextStructuringSpecVersionResponse,
    TextStructuringSuggestionRequest,
    TextStructuringSuggestionResponse,
    TextTrainingRunResponse,
    UpdateTextReviewItemRequest,
)
from app.services.text_structuring_compiler import (
    PROMPT_VERSION,
    compile_definition,
    definition_fingerprint,
)
from app.services.text_structuring_inference import TextStructuringInferenceEngine
from app.services.text_structuring_training import artifact_filename, train_student_artifact


def create_spec(
    db: Session,
    request: CreateTextStructuringSpecRequest,
    actor: ActorContext,
) -> TextStructuringSpecResponse:
    repository = TextStructuringRepository(db)
    spec_id = unique_spec_id(request.name)
    fingerprint = definition_fingerprint(request.definition)
    spec = TextStructuringSpecModel(
        id=spec_id,
        name=request.name.strip(),
        description=request.description.strip(),
        owner=actor.name,
        created_by=actor.name,
        status="draft",
        active_version=None,
    )
    version = TextStructuringSpecVersionModel(
        id=version_id(spec_id, 1),
        spec_id=spec_id,
        version=1,
        fingerprint=fingerprint,
        status="draft",
        definition=request.definition.model_dump(mode="json", by_alias=True),
        compiled_schema=compile_definition(request.definition),
        prompt_version=PROMPT_VERSION,
    )
    repository.create_spec(spec, version)
    return spec_response(repository, spec)


def list_specs(db: Session, actor: ActorContext) -> list[TextStructuringSpecResponse]:
    repository = TextStructuringRepository(db)
    specs = repository.list_specs(None if actor.is_admin else actor.name)
    return [spec_response(repository, spec) for spec in specs]


def get_spec(db: Session, spec_id: str, actor: ActorContext) -> TextStructuringSpecResponse:
    repository = TextStructuringRepository(db)
    spec = require_spec(repository, spec_id, actor)
    return spec_response(repository, spec)


def create_version(
    db: Session,
    spec_id: str,
    request: CreateTextStructuringVersionRequest,
    actor: ActorContext,
) -> TextStructuringSpecVersionResponse:
    repository = TextStructuringRepository(db)
    spec = require_spec(repository, spec_id, actor, manage=True)
    versions = repository.list_versions(spec_id)
    next_version = max((item.version for item in versions), default=0) + 1
    fingerprint = definition_fingerprint(request.definition)
    if versions and versions[0].fingerprint == fingerprint:
        raise ApiError(
            ErrorCode.CONFLICT,
            "The definition is identical to the latest version.",
            status.HTTP_409_CONFLICT,
        )
    version = TextStructuringSpecVersionModel(
        id=version_id(spec_id, next_version),
        spec_id=spec_id,
        version=next_version,
        fingerprint=fingerprint,
        status="draft",
        definition=request.definition.model_dump(mode="json", by_alias=True),
        compiled_schema=compile_definition(request.definition),
        prompt_version=PROMPT_VERSION,
    )
    repository.add_version(spec, version)
    if request.publish:
        version = repository.publish_version(spec, version, now_iso())
    return version_response(version)


def publish_version(
    db: Session,
    spec_id: str,
    version_number: int,
    actor: ActorContext,
) -> TextStructuringSpecVersionResponse:
    repository = TextStructuringRepository(db)
    spec = require_spec(repository, spec_id, actor, manage=True)
    version = repository.get_version(spec_id, version_number)
    if version is None:
        raise ApiError(ErrorCode.NOT_FOUND, "Text structuring version not found.", status.HTTP_404_NOT_FOUND)
    if version.status != "published" or spec.active_version != version.version:
        version = repository.publish_version(spec, version, now_iso())
    return version_response(version)


def suggest_definition(
    request: TextStructuringSuggestionRequest,
    settings: Settings,
) -> TextStructuringSuggestionResponse:
    source_fields = infer_source_fields(request)
    definition = default_review_definition(source_fields, request.locale, request.include_aspects)
    warnings = [
        "추천안은 시작점입니다. 각 라벨의 의미와 예시를 도메인 담당자가 확인한 뒤 게시하세요."
    ]
    if settings.text_structuring_enabled and (settings.text_structuring_api_key or settings.openai_api_key):
        warnings.append("현재 추천은 재현 가능한 기본 템플릿이며 Preview 단계에서 실제 모델 결과를 검증합니다.")
    return TextStructuringSuggestionResponse(
        definition=definition,
        source="fallback",
        model="asklake-review-template-v2",
        warnings=warnings,
    )


def preview(
    db: Session,
    request: TextStructuringPreviewRequest,
    actor: ActorContext,
    settings: Settings,
) -> TextStructuringPreviewResponse:
    if len(request.rows) > settings.text_structuring_preview_max_rows:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            f"Preview supports at most {settings.text_structuring_preview_max_rows} rows.",
            status.HTTP_400_BAD_REQUEST,
        )
    repository = TextStructuringRepository(db)
    definition, spec_ref = resolve_definition(repository, request.definition, request.spec_ref, actor)
    engine = TextStructuringInferenceEngine(
        settings,
        load_champion_artifact(repository, spec_ref),
    )
    rows, warnings, route_breakdown = engine.run(definition, request.rows)
    if request.persist_review_items:
        if spec_ref is None:
            raise ApiError(
                ErrorCode.VALIDATION_ERROR,
                "persistReviewItems requires a saved specRef.",
                status.HTTP_400_BAD_REQUEST,
            )
        persist_review_rows(repository, spec_ref, rows)
    return TextStructuringPreviewResponse(
        spec_ref=spec_ref,
        rows=rows,
        warnings=warnings,
        route_breakdown=route_breakdown,
    )


def run_batch(
    db: Session,
    request: TextStructuringBatchRequest,
    settings: Settings,
) -> TextStructuringBatchResponse:
    if len(request.rows) > settings.text_structuring_batch_max_rows:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            f"Batch supports at most {settings.text_structuring_batch_max_rows} rows per request.",
            status.HTTP_400_BAD_REQUEST,
        )
    if request.spec_ref and definition_fingerprint(request.definition) != request.spec_ref.fingerprint:
        raise ApiError(
            ErrorCode.CONFLICT,
            "Batch definition fingerprint does not match specRef.",
            status.HTTP_409_CONFLICT,
        )
    repository = TextStructuringRepository(db)
    rows, _, route_breakdown = TextStructuringInferenceEngine(
        settings,
        load_champion_artifact(repository, request.spec_ref),
    ).run(request.definition, request.rows)
    if request.spec_ref:
        sampled_rows = sample_batch_review_rows(
            rows,
            settings.text_structuring_review_sample_rate,
            settings.text_structuring_review_max_per_batch,
        )
        persist_review_rows(
            repository,
            request.spec_ref,
            sampled_rows,
            run_id=request.run_id,
            job_id=request.job_id,
        )
    return TextStructuringBatchResponse(rows=rows, route_breakdown=route_breakdown)


def list_review_items(
    db: Session,
    spec_id: str,
    actor: ActorContext,
    *,
    item_status: str | None,
    limit: int,
) -> list[TextReviewItemResponse]:
    repository = TextStructuringRepository(db)
    require_spec(repository, spec_id, actor)
    return [
        review_item_response(item)
        for item in repository.list_review_items(spec_id, item_status, limit)
    ]


def update_review_item(
    db: Session,
    item_id: str,
    request: UpdateTextReviewItemRequest,
    actor: ActorContext,
) -> TextReviewItemResponse:
    repository = TextStructuringRepository(db)
    item = repository.get_review_item(item_id)
    if item is None:
        raise ApiError(ErrorCode.NOT_FOUND, "Review item not found.", status.HTTP_404_NOT_FOUND)
    require_spec(repository, item.spec_id, actor, manage=True)
    if request.status == "corrected" and not request.correction:
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "A corrected review item requires correction data.",
            status.HTTP_400_BAD_REQUEST,
        )
    item.status = request.status
    item.correction = request.correction
    return review_item_response(repository.save_review_item(item))


def create_training_run(
    db: Session,
    request: CreateTextTrainingRunRequest,
    actor: ActorContext,
    settings: Settings,
) -> TextTrainingRunResponse:
    repository = TextStructuringRepository(db)
    spec = require_spec(repository, request.spec_id, actor, manage=True)
    version = repository.get_version(request.spec_id, request.spec_version)
    if version is None:
        raise ApiError(ErrorCode.NOT_FOUND, "Text structuring version not found.", status.HTTP_404_NOT_FOUND)
    run_id = f"text_train_{uuid.uuid4().hex}"
    run = TextStructuringTrainingRunModel(
        id=run_id,
        spec_id=spec.id,
        spec_version=version.version,
        status="running",
        task_fields=request.task_fields,
        training_rows=0,
        metrics={},
    )
    repository.create_training_run(run)
    reviewed = repository.reviewed_items(spec.id, version.version)
    artifact_path = Path(settings.text_structuring_model_dir) / artifact_filename(spec.id, version.version, run.id)
    try:
        _, metrics = train_student_artifact(
            definition=TextStructuringDefinition.model_validate(version.definition),
            review_items=reviewed,
            task_fields=request.task_fields,
            artifact_path=artifact_path,
        )
        model = TextStructuringModelModel(
            id=f"text_model_{uuid.uuid4().hex}",
            spec_id=spec.id,
            spec_version=version.version,
            status="candidate",
            provider="asklake_multinomial_nb",
            model_name=f"{spec.name} v{version.version} student",
            artifact_uri=str(artifact_path.resolve()),
            task_fields=request.task_fields or list(metrics.get("fields") or {}),
            metrics=metrics,
        )
        repository.create_model(model)
        run.status = "success"
        run.training_rows = len(reviewed)
        run.model_id = model.id
        run.label_manifest_uri = str(artifact_path.resolve())
        run.metrics = metrics
    except ValueError as exc:
        run.status = "failed"
        run.training_rows = len(reviewed)
        run.error = str(exc)
    repository.save_training_run(run)
    return training_run_response(run)


def list_models(
    db: Session,
    spec_id: str,
    actor: ActorContext,
) -> list[TextModelResponse]:
    repository = TextStructuringRepository(db)
    require_spec(repository, spec_id, actor)
    return [model_response(model) for model in repository.list_models(spec_id)]


def promote_model(
    db: Session,
    model_id: str,
    actor: ActorContext,
) -> TextModelResponse:
    repository = TextStructuringRepository(db)
    model = repository.get_model(model_id)
    if model is None:
        raise ApiError(ErrorCode.NOT_FOUND, "Text structuring model not found.", status.HTTP_404_NOT_FOUND)
    require_spec(repository, model.spec_id, actor, manage=True)
    return model_response(repository.promote_model(model))


def resolve_published_spec_ref(
    db: Session,
    spec_ref: TextStructuringSpecRef,
    actor: ActorContext,
) -> tuple[TextStructuringDefinition, TextStructuringSpecVersionModel]:
    repository = TextStructuringRepository(db)
    require_spec(repository, spec_ref.spec_id, actor)
    version = require_version_ref(repository, spec_ref)
    if version.status != "published":
        raise ApiError(
            ErrorCode.VALIDATION_ERROR,
            "ETL jobs may reference only a published text structuring version.",
            status.HTTP_400_BAD_REQUEST,
        )
    return TextStructuringDefinition.model_validate(version.definition), version


def resolve_definition(
    repository: TextStructuringRepository,
    definition: TextStructuringDefinition | None,
    spec_ref: TextStructuringSpecRef | None,
    actor: ActorContext,
) -> tuple[TextStructuringDefinition, TextStructuringSpecRef | None]:
    if spec_ref is None:
        if definition is None:
            raise ApiError(ErrorCode.VALIDATION_ERROR, "definition is required.")
        return definition, None
    require_spec(repository, spec_ref.spec_id, actor)
    version = require_version_ref(repository, spec_ref)
    persisted_definition = TextStructuringDefinition.model_validate(version.definition)
    if definition is not None and definition_fingerprint(definition) != version.fingerprint:
        raise ApiError(
            ErrorCode.CONFLICT,
            "Inline definition differs from the referenced version.",
            status.HTTP_409_CONFLICT,
        )
    return persisted_definition, spec_ref


def require_version_ref(
    repository: TextStructuringRepository,
    spec_ref: TextStructuringSpecRef,
) -> TextStructuringSpecVersionModel:
    version = repository.get_version(spec_ref.spec_id, spec_ref.version)
    if version is None:
        raise ApiError(ErrorCode.NOT_FOUND, "Text structuring version not found.", status.HTTP_404_NOT_FOUND)
    if version.fingerprint != spec_ref.fingerprint:
        raise ApiError(
            ErrorCode.CONFLICT,
            "Text structuring fingerprint mismatch. Refresh the published version before running.",
            status.HTTP_409_CONFLICT,
        )
    return version


def require_spec(
    repository: TextStructuringRepository,
    spec_id: str,
    actor: ActorContext,
    *,
    manage: bool = False,
) -> TextStructuringSpecModel:
    spec = repository.get_spec(spec_id)
    if spec is None:
        raise ApiError(ErrorCode.NOT_FOUND, "Text structuring spec not found.", status.HTTP_404_NOT_FOUND)
    if not actor.is_admin and spec.owner != actor.name:
        action = "manage" if manage else "view"
        raise ApiError(
            ErrorCode.FORBIDDEN,
            f"Actor {actor.name} is not allowed to {action} this text structuring spec.",
            status.HTTP_403_FORBIDDEN,
        )
    return spec


def persist_review_rows(
    repository: TextStructuringRepository,
    spec_ref: TextStructuringSpecRef,
    rows: list[Any],
    *,
    run_id: str | None = None,
    job_id: str | None = None,
) -> None:
    items = []
    for row in rows:
        if not row.review_required:
            continue
        source_json = json.dumps(row.input, ensure_ascii=False, sort_keys=True, default=str)
        source_hash = hashlib.sha256(source_json.encode("utf-8")).hexdigest()
        identity = f"{spec_ref.spec_id}:{spec_ref.version}:{row.source_row_id}:{source_hash}"
        items.append(
            TextStructuringReviewItemModel(
                id=f"text_review_{hashlib.sha256(identity.encode('utf-8')).hexdigest()[:32]}",
                spec_id=spec_ref.spec_id,
                spec_version=spec_ref.version,
                run_id=run_id,
                job_id=job_id,
                source_row_id=row.source_row_id,
                source_hash=source_hash,
                input_snapshot=row.input,
                prediction={
                    "output": row.output,
                    "repeatedGroups": row.repeated_groups,
                },
                reasons=row.review_reasons,
                route=row.route,
                confidence=None,
                status="pending",
            )
        )
    repository.upsert_review_items(items)


def sample_batch_review_rows(rows: list[Any], sample_rate: float, limit: int) -> list[Any]:
    selected = [row for row in rows if row.route.startswith("quarantine")]
    for row in rows:
        if not row.review_required or row in selected:
            continue
        bucket = int(hashlib.sha256(row.source_row_id.encode("utf-8")).hexdigest()[:8], 16) / 0xFFFFFFFF
        if bucket <= sample_rate:
            selected.append(row)
        if len(selected) >= limit:
            break
    return selected[:limit] if limit > 0 else []


def load_champion_artifact(
    repository: TextStructuringRepository,
    spec_ref: TextStructuringSpecRef | None,
) -> dict[str, Any] | None:
    if spec_ref is None:
        return None
    model = repository.get_champion_model(spec_ref.spec_id, spec_ref.version)
    if model is None or not model.artifact_uri:
        return None
    try:
        payload = json.loads(Path(model.artifact_uri).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    payload["calibrated"] = bool((model.metrics or {}).get("calibrated"))
    return payload


def default_review_definition(
    source_fields: list[str],
    locale: str,
    include_aspects: bool,
) -> TextStructuringDefinition:
    sentiment_labels = [
        TextLabelSpec(value="positive", description="긍정적인 평가"),
        TextLabelSpec(value="negative", description="부정적인 평가"),
        TextLabelSpec(value="mixed", description="서로 다른 관점의 긍정과 부정이 함께 존재"),
        TextLabelSpec(value="neutral", description="명확한 평가가 없는 중립"),
        TextLabelSpec(value="unknown", description="근거 부족"),
    ]
    aspect_labels = [
        TextLabelSpec(value="battery", description="배터리와 충전"),
        TextLabelSpec(value="appearance", description="외관, 디자인, 마감"),
        TextLabelSpec(value="display", description="화면과 터치"),
        TextLabelSpec(value="performance", description="성능과 속도"),
        TextLabelSpec(value="camera", description="카메라"),
        TextLabelSpec(value="audio", description="음질과 스피커"),
        TextLabelSpec(value="shipping", description="배송과 포장"),
        TextLabelSpec(value="price", description="가격과 가치"),
        TextLabelSpec(value="quality", description="품질과 불량"),
        TextLabelSpec(value="unknown", description="분류 불가"),
    ]
    severity_labels = [
        TextLabelSpec(value="unknown", description="이슈가 없거나 판단 불가", order=0),
        TextLabelSpec(value="low", description="경미함", order=1),
        TextLabelSpec(value="medium", description="사용에 불편을 줌", order=2),
        TextLabelSpec(value="high", description="사용 불가, 안전, 환불 수준", order=3),
    ]
    repeated_groups = []
    if include_aspects:
        repeated_groups.append(
            TextRepeatedGroupSpec(
                group_id="aspects",
                target_name="aspects",
                description="리뷰에 언급된 관점별 평가. 상반된 관점을 한 행으로 합치지 않습니다.",
                output_mode="child_table",
                fields=[
                    TextFieldSpec(
                        field_id="aspect",
                        target_name="aspect",
                        task="classification",
                        description="평가 대상 관점",
                        allowed_values=aspect_labels,
                        unknown_value="unknown",
                        nullable=False,
                    ),
                    TextFieldSpec(
                        field_id="sentiment",
                        target_name="sentiment",
                        task="classification",
                        description="이 관점에만 해당하는 감정",
                        allowed_values=sentiment_labels,
                        unknown_value="unknown",
                        nullable=False,
                    ),
                    TextFieldSpec(
                        field_id="severity",
                        target_name="severity",
                        task="ordinal",
                        description="이 관점 이슈의 심각도",
                        allowed_values=severity_labels,
                        unknown_value="unknown",
                        nullable=False,
                    ),
                    TextFieldSpec(
                        field_id="evidence",
                        target_name="evidence",
                        task="extract_span",
                        description="판단 근거가 된 원문 구절",
                        evidence_required=True,
                    ),
                ],
            )
        )
    return TextStructuringDefinition(
        source_fields=source_fields,
        locale=locale,
        output_mode="child_table" if include_aspects else "flat",
        fields=[
            TextFieldSpec(
                field_id="overall_sentiment",
                target_name="overall_sentiment",
                task="classification",
                description="리뷰 전체 감정. 관점별 감정이 다르면 mixed입니다.",
                allowed_values=sentiment_labels,
                unknown_value="unknown",
                nullable=False,
            ),
            TextFieldSpec(
                field_id="issue_types",
                target_name="issue_types",
                task="multi_label",
                description="리뷰에서 실제로 언급된 이슈 또는 평가 관점",
                allowed_values=aspect_labels[:-1],
            ),
            TextFieldSpec(
                field_id="severity",
                target_name="severity",
                task="ordinal",
                description="리뷰에서 가장 심각한 이슈의 수준",
                allowed_values=severity_labels,
                unknown_value="unknown",
                nullable=False,
            ),
        ],
        repeated_groups=repeated_groups,
        routing_policy=TextRoutingPolicy(mode="hybrid", pii_mode="mask", on_error="quarantine"),
    )


def infer_source_fields(request: TextStructuringSuggestionRequest) -> list[str]:
    if request.source_fields:
        return list(dict.fromkeys(request.source_fields))
    names = [
        str(column.get("name") or column.get("targetName") or column.get("sourceName") or "").strip()
        for column in request.source_columns
    ]
    if not names and request.sample_rows:
        names = list(request.sample_rows[0])
    preferred = [
        name for name in names
        if any(token in name.casefold() for token in ("text", "review", "body", "content", "message", "title", "리뷰", "내용"))
    ]
    return list(dict.fromkeys(preferred or names[:1] or ["text"]))


def spec_response(
    repository: TextStructuringRepository,
    spec: TextStructuringSpecModel,
) -> TextStructuringSpecResponse:
    return TextStructuringSpecResponse(
        id=spec.id,
        name=spec.name,
        description=spec.description,
        owner=spec.owner,
        status=spec.status,
        active_version=spec.active_version,
        versions=[version_response(version) for version in repository.list_versions(spec.id)],
        created_at=iso_value(spec.created_at),
        updated_at=iso_value(spec.updated_at),
    )


def version_response(version: TextStructuringSpecVersionModel) -> TextStructuringSpecVersionResponse:
    return TextStructuringSpecVersionResponse(
        spec_id=version.spec_id,
        version=version.version,
        fingerprint=version.fingerprint,
        status=version.status,
        definition=TextStructuringDefinition.model_validate(version.definition),
        compiled_schema=version.compiled_schema,
        prompt_version=version.prompt_version,
        created_at=iso_value(version.created_at),
        published_at=version.published_at,
    )


def review_item_response(item: TextStructuringReviewItemModel) -> TextReviewItemResponse:
    return TextReviewItemResponse(
        id=item.id,
        spec_id=item.spec_id,
        spec_version=item.spec_version,
        run_id=item.run_id,
        job_id=item.job_id,
        source_row_id=item.source_row_id,
        source_hash=item.source_hash,
        input_snapshot=item.input_snapshot,
        prediction=item.prediction,
        correction=item.correction,
        reasons=item.reasons,
        route=item.route,
        confidence=item.confidence,
        status=item.status,
        created_at=iso_value(item.created_at),
        updated_at=iso_value(item.updated_at),
    )


def training_run_response(run: TextStructuringTrainingRunModel) -> TextTrainingRunResponse:
    return TextTrainingRunResponse(
        id=run.id,
        spec_id=run.spec_id,
        spec_version=run.spec_version,
        status=run.status,
        task_fields=run.task_fields,
        training_rows=run.training_rows,
        model_id=run.model_id,
        metrics=run.metrics,
        error=run.error,
        created_at=iso_value(run.created_at),
        updated_at=iso_value(run.updated_at),
    )


def model_response(model: TextStructuringModelModel) -> TextModelResponse:
    return TextModelResponse(
        id=model.id,
        spec_id=model.spec_id,
        spec_version=model.spec_version,
        status=model.status,
        provider=model.provider,
        model_name=model.model_name,
        artifact_uri=model.artifact_uri,
        task_fields=model.task_fields,
        metrics=model.metrics,
        created_at=iso_value(model.created_at),
        updated_at=iso_value(model.updated_at),
    )


def unique_spec_id(name: str) -> str:
    slug = re.sub(r"[^0-9a-z]+", "-", name.casefold()).strip("-")[:48] or "text-structuring"
    return f"text_spec_{slug}_{uuid.uuid4().hex[:10]}"


def version_id(spec_id: str, version: int) -> str:
    return f"{spec_id}:v{version}"


def iso_value(value: Any) -> str:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value.isoformat()
    return str(value or now_iso())


def now_iso() -> str:
    return datetime.now(UTC).isoformat()
