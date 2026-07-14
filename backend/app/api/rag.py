from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, get_actor_context
from app.core.database import get_db
from app.schemas.semantic import RagApproveRequest, RagClassifyResponse, RagDocumentPreviewResponse, RagIndexRequest, RagIndexResponse, RagJobResponse, RagProfileResponse, RagSearchRequest, RagSearchResponse
from app.services.rag_service import RagService
from app.services.rag_search_service import RagSearchService

router = APIRouter(prefix="/catalog/datasets", tags=["rag"])


@router.get("/{dataset_id}/rag", response_model=RagProfileResponse)
def get_rag_profile(dataset_id: str, db: Session = Depends(get_db), actor: ActorContext = Depends(get_actor_context)) -> RagProfileResponse:
    return RagService(db).profile(dataset_id, actor)


@router.post("/{dataset_id}/rag/classify", response_model=RagClassifyResponse, status_code=status.HTTP_202_ACCEPTED)
def classify_rag_dataset(dataset_id: str, semantic_model_id: str | None = Query(default=None), db: Session = Depends(get_db), actor: ActorContext = Depends(get_actor_context)) -> RagClassifyResponse:
    return RagService(db).classify(dataset_id, actor, semantic_model_id=semantic_model_id)


@router.get("/{dataset_id}/rag/classification-runs", response_model=list[dict])
def list_classification_runs(dataset_id: str, db: Session = Depends(get_db), actor: ActorContext = Depends(get_actor_context)) -> list[dict]:
    service = RagService(db)
    service._dataset(dataset_id, actor, "view")
    from sqlalchemy import select
    from app.models.semantic_rag import RagClassificationRunModel
    rows = db.scalars(select(RagClassificationRunModel).where(RagClassificationRunModel.dataset_id == dataset_id).order_by(RagClassificationRunModel.created_at.desc())).all()
    return [{"runId": row.id, "datasetId": row.dataset_id, "status": row.status, "model": row.model, "output": row.output, "error": row.error, "createdAt": row.created_at, "completedAt": row.completed_at} for row in rows]


@router.post("/{dataset_id}/rag/approve", response_model=RagProfileResponse)
def approve_rag_dataset(dataset_id: str, request: RagApproveRequest, db: Session = Depends(get_db), actor: ActorContext = Depends(get_actor_context)) -> RagProfileResponse:
    return RagService(db).approve(dataset_id, request, actor)


@router.get("/{dataset_id}/rag/document-preview", response_model=RagDocumentPreviewResponse)
def preview_rag_documents(dataset_id: str, db: Session = Depends(get_db), actor: ActorContext = Depends(get_actor_context)) -> RagDocumentPreviewResponse:
    return RagService(db).preview(dataset_id, actor)


@router.post("/{dataset_id}/rag/search", response_model=RagSearchResponse)
def search_rag_dataset(dataset_id: str, request: RagSearchRequest, db: Session = Depends(get_db), actor: ActorContext = Depends(get_actor_context)) -> RagSearchResponse:
    service = RagService(db)
    service._dataset(dataset_id, actor, "query")
    profile = service.profile(dataset_id, actor)
    filters = service.validate_search_filters(dataset_id, actor, request.model_dump(mode="json").get("filters") or {})
    if profile.serving_status == "not_serving" or not profile.target_alias:
        return RagSearchResponse(sources=[], retrieval={"mode": "hybrid", "status": "not_serving", "buildStatus": profile.build_status, "servingStatus": profile.serving_status, "aliases": []})
    result = RagSearchService().search(query=request.query, aliases=[profile.target_alias], actor=actor, filters=filters, embedding_model=profile.active_embedding_model)
    result["retrieval"].update({"buildStatus": profile.build_status, "servingStatus": profile.serving_status, "servingIndex": profile.active_index})
    return RagSearchResponse.model_validate(result)


@router.post("/{dataset_id}/rag/index", response_model=RagIndexResponse, status_code=status.HTTP_202_ACCEPTED)
def index_rag_dataset(dataset_id: str, request: RagIndexRequest | None = None, mode: str = Query(default="index", pattern="^(index|reindex)$"), db: Session = Depends(get_db), actor: ActorContext = Depends(get_actor_context)) -> RagIndexResponse:
    return RagService(db).index(dataset_id, actor, mode=mode, idempotency_key=request.idempotency_key if request else None)


@router.post("/{dataset_id}/rag/reindex", response_model=RagIndexResponse, status_code=status.HTTP_202_ACCEPTED)
def reindex_rag_dataset(dataset_id: str, request: RagIndexRequest | None = None, db: Session = Depends(get_db), actor: ActorContext = Depends(get_actor_context)) -> RagIndexResponse:
    return RagService(db).index(dataset_id, actor, mode="reindex", idempotency_key=request.idempotency_key if request else None)


@router.get("/{dataset_id}/rag/jobs/{job_id}", response_model=RagJobResponse)
def get_rag_job(dataset_id: str, job_id: str, db: Session = Depends(get_db), actor: ActorContext = Depends(get_actor_context)) -> RagJobResponse:
    result = RagService(db).job(job_id, actor)
    if result.dataset_id != dataset_id:
        from app.core.errors import ApiError
        raise ApiError("not_found", f"RAG job {job_id} was not found for Dataset {dataset_id}", 404)
    return result
