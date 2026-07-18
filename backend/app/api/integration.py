from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, Query, status
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, get_actor_context
from app.core.database import get_db
from app.schemas.integration import (
    CatalogModelArtifactResponse,
    ReviewAnalysisPreviewRequest,
    ReviewAnalysisPreviewResponse,
    ReviewAnalysisRunRequest,
    ReviewAnalysisRunResponse,
    ReviewAnalysisSchemaSuggestionRequest,
    ReviewAnalysisStatusResponse,
    S3BucketsResponse,
    S3PrefixesResponse,
    TargetDatabasesResponse,
)
from app.services.catalog_model_service import list_catalog_model_artifacts
from app.services.review_analysis_service import ReviewAnalysisService
from app.services.s3_browser_service import list_s3_buckets, list_s3_prefixes
from app.services.target_database_service import list_target_databases

router = APIRouter(tags=["frontend-contracts"])


@router.get("/target/databases", response_model=TargetDatabasesResponse)
def get_target_databases(
    _: Annotated[ActorContext, Depends(get_actor_context)],
) -> TargetDatabasesResponse:
    return list_target_databases()


@router.get("/s3/buckets", response_model=S3BucketsResponse)
def get_s3_buckets(
    _: Annotated[ActorContext, Depends(get_actor_context)],
) -> S3BucketsResponse:
    return list_s3_buckets()


@router.get("/s3/prefixes", response_model=S3PrefixesResponse)
def get_s3_prefixes(
    bucket: str,
    prefix: str = "",
    continuation_token: str | None = Query(default=None, alias="continuationToken"),
    _: Annotated[ActorContext, Depends(get_actor_context)] = None,
) -> S3PrefixesResponse:
    return list_s3_prefixes(
        bucket=bucket,
        continuation_token=continuation_token,
        prefix=prefix,
    )


@router.get("/review-analysis/runs/latest", response_model=ReviewAnalysisStatusResponse)
def get_latest_review_analysis(
    actor: Annotated[ActorContext, Depends(get_actor_context)],
    db: Session = Depends(get_db),
) -> dict[str, object]:
    return ReviewAnalysisService(db).get_status(actor)


@router.get("/review-analysis/runs/{run_id}", response_model=ReviewAnalysisRunResponse)
def get_review_analysis_run(
    run_id: str,
    actor: Annotated[ActorContext, Depends(get_actor_context)],
    db: Session = Depends(get_db),
) -> dict[str, object]:
    return ReviewAnalysisService(db).get_status(actor, run_id)


@router.post(
    "/review-analysis/runs",
    response_model=ReviewAnalysisRunResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
def enqueue_review_analysis(
    request: ReviewAnalysisRunRequest,
    background_tasks: BackgroundTasks,
    actor: Annotated[ActorContext, Depends(get_actor_context)],
    db: Session = Depends(get_db),
) -> dict[str, object]:
    return ReviewAnalysisService(db).enqueue(
        request.model_dump(by_alias=True, mode="json", exclude_none=True),
        actor,
        background_tasks,
    )


@router.get("/review-analysis/cellphones", deprecated=True)
def get_cellphones_review_analysis(
    actor: Annotated[ActorContext, Depends(get_actor_context)],
    db: Session = Depends(get_db),
) -> dict[str, object]:
    return ReviewAnalysisService(db).get_status(actor)


@router.post("/review-analysis/schema-suggestion")
def suggest_review_analysis_schema(
    request: ReviewAnalysisSchemaSuggestionRequest,
    _: Annotated[ActorContext, Depends(get_actor_context)],
) -> dict[str, object]:
    return ReviewAnalysisService().suggest_schema(request.model_dump(by_alias=True, mode="json"))


@router.post("/review-analysis/preview", response_model=ReviewAnalysisPreviewResponse)
def preview_review_analysis(
    request: ReviewAnalysisPreviewRequest,
    _: Annotated[ActorContext, Depends(get_actor_context)],
) -> ReviewAnalysisPreviewResponse:
    payload = ReviewAnalysisService().preview(request.model_dump(by_alias=True, mode="json"))
    return ReviewAnalysisPreviewResponse.model_validate(payload)


@router.post(
    "/review-analysis/cellphones/run",
    deprecated=True,
    # Preserve the legacy 200 response; the new /runs endpoint is the 202 API.
    status_code=status.HTTP_200_OK,
)
def run_cellphones_review_analysis(
    request: ReviewAnalysisRunRequest,
    background_tasks: BackgroundTasks,
    actor: Annotated[ActorContext, Depends(get_actor_context)],
    db: Session = Depends(get_db),
) -> dict[str, object]:
    return ReviewAnalysisService(db).enqueue(
        request.model_dump(by_alias=True, mode="json", exclude_none=True),
        actor,
        background_tasks,
    )


@router.get("/catalog/models", response_model=list[CatalogModelArtifactResponse])
def get_catalog_models(
    _: Annotated[ActorContext, Depends(get_actor_context)],
) -> list[CatalogModelArtifactResponse]:
    return list_catalog_model_artifacts()
