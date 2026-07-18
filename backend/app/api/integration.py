from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.core.auth_context import ActorContext, get_actor_context
from app.schemas.integration import (
    CatalogModelArtifactResponse,
    ReviewAnalysisRunRequest,
    ReviewAnalysisSchemaSuggestionRequest,
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


@router.get("/review-analysis/cellphones")
def get_cellphones_review_analysis(
    _: Annotated[ActorContext, Depends(get_actor_context)],
) -> dict[str, object]:
    return ReviewAnalysisService().get_status()


@router.post("/review-analysis/schema-suggestion")
def suggest_review_analysis_schema(
    request: ReviewAnalysisSchemaSuggestionRequest,
    _: Annotated[ActorContext, Depends(get_actor_context)],
) -> dict[str, object]:
    return ReviewAnalysisService().suggest_schema(request.model_dump(by_alias=True, mode="json"))


@router.post("/review-analysis/cellphones/run")
def run_cellphones_review_analysis(
    request: ReviewAnalysisRunRequest,
    _: Annotated[ActorContext, Depends(get_actor_context)],
) -> dict[str, object]:
    return ReviewAnalysisService().run(request.model_dump(by_alias=True, mode="json"))


@router.get("/catalog/models", response_model=list[CatalogModelArtifactResponse])
def get_catalog_models(
    _: Annotated[ActorContext, Depends(get_actor_context)],
) -> list[CatalogModelArtifactResponse]:
    return list_catalog_model_artifacts()
