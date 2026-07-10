from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.schemas.etl import (
    CreatePipelineRequest,
    CreatePipelineResponse,
    JobCommandRequest,
    JobCommandResponse,
    JobListResponse,
    JobRowData,
    JobRunOutcome,
    JobScheduleKind,
    JobStatus,
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
def create_job(request: CreatePipelineRequest, db: Session = Depends(get_db)) -> CreatePipelineResponse:
    return etl_service.create_pipeline(db, request)


@router.get("/jobs", response_model=JobListResponse)
def list_jobs(
    last_run_outcome: JobRunOutcome | None = Query(default=None, alias="lastRunOutcome"),
    owner: str | None = Query(default=None),
    status_filter: list[JobStatus] = Query(default_factory=list, alias="status"),
    schedule_kind: JobScheduleKind | None = Query(default=None, alias="scheduleKind"),
    db: Session = Depends(get_db),
) -> JobListResponse:
    return etl_service.list_jobs(db, last_run_outcome=last_run_outcome, owner=owner, statuses=status_filter, schedule_kind=schedule_kind)


@router.get("/jobs/{job_id}", response_model=JobRowData)
def get_job(job_id: str, db: Session = Depends(get_db)) -> JobRowData:
    return etl_service.get_job(db, job_id)


@router.post("/jobs/{job_id}/commands", response_model=JobCommandResponse)
def command_job(job_id: str, request: JobCommandRequest, db: Session = Depends(get_db)) -> JobCommandResponse:
    return etl_service.command_job(db, job_id, request.command)
