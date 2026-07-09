from fastapi import APIRouter, Depends, Header, status
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, get_actor_context
from app.core.database import get_db
from app.schemas.etl import (
    CreatePipelineRequest,
    CreatePipelineResponse,
    JobCommandRequest,
    JobCommandResponse,
    JobRowData,
    SchemaDraft,
    SourceAssetsRequest,
    SourceAssetsResponse,
    SourceConnectorAnalysis,
    SourceConnectorRequest,
)
from app.services import etl_service

router = APIRouter(prefix="/etl", tags=["etl"])


@router.post("/sources/test", response_model=SourceConnectorAnalysis)
def test_source_connector(request: SourceConnectorRequest) -> SourceConnectorAnalysis:
    return etl_service.test_source_connector(request)


@router.post("/sources/assets", response_model=SourceAssetsResponse)
def list_source_assets(request: SourceAssetsRequest) -> SourceAssetsResponse:
    return etl_service.list_source_assets(request)


@router.post("/schema-inference", response_model=SchemaDraft)
def infer_schema(request: SourceConnectorRequest) -> SchemaDraft:
    return etl_service.infer_schema(request)


@router.post("/jobs", response_model=CreatePipelineResponse, status_code=status.HTTP_201_CREATED)
def create_job(
    request: CreatePipelineRequest,
    db: Session = Depends(get_db),
    actor_name: str = Header(default="demo-user", alias="X-AskLake-User"),
) -> CreatePipelineResponse:
    return etl_service.create_pipeline(db, request, actor_name)


@router.get("/jobs", response_model=list[JobRowData])
def list_jobs(db: Session = Depends(get_db)) -> list[JobRowData]:
    return etl_service.list_jobs(db)


@router.get("/jobs/{job_id}", response_model=JobRowData)
def get_job(job_id: str, db: Session = Depends(get_db)) -> JobRowData:
    return etl_service.get_job(db, job_id)


@router.post("/jobs/{job_id}/commands", response_model=JobCommandResponse)
def command_job(
    job_id: str,
    request: JobCommandRequest,
    db: Session = Depends(get_db),
    actor: ActorContext = Depends(get_actor_context),
) -> JobCommandResponse:
    return etl_service.command_job(db, job_id, request.command, actor)
