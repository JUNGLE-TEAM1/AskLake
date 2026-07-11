from fastapi import APIRouter, Depends, Header, Query, status
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, get_actor_context
from app.core.database import get_db
from app.schemas.etl import (
    CreatePipelineRequest,
    CreatePipelineResponse,
    ContinuousCompactionRequest,
    ContinuousMaintenanceRun,
    ContinuousQuarantineResponse,
    ContinuousReplayRequest,
    ContinuousWorkerLogsResponse,
    JobCommandRequest,
    JobCommandResponse,
    JobRowData,
    KafkaReviewIngestRequest,
    KafkaReviewIngestResponse,
    ScheduledJobRunRequest,
    ScheduledJobRunResponse,
    SchemaDraft,
    SourceAssetsRequest,
    SourceAssetsResponse,
    SourceConnectorAnalysis,
    SourceConnectorRequest,
    UpdatePipelineRequest,
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


@router.post("/kafka/reviews/ingest", response_model=KafkaReviewIngestResponse)
def ingest_kafka_reviews(
    request: KafkaReviewIngestRequest,
    db: Session = Depends(get_db),
) -> KafkaReviewIngestResponse:
    return etl_service.ingest_kafka_reviews(db, request)


@router.post("/jobs", response_model=CreatePipelineResponse, status_code=status.HTTP_201_CREATED)
def create_job(
    request: CreatePipelineRequest,
    db: Session = Depends(get_db),
    actor_name: str = Header(default="demo-user", alias="X-AskLake-User"),
) -> CreatePipelineResponse:
    return etl_service.create_pipeline(db, request, actor_name)


@router.get("/jobs", response_model=list[JobRowData])
def list_jobs(
    db: Session = Depends(get_db),
    actor: ActorContext = Depends(get_actor_context),
) -> list[JobRowData]:
    return etl_service.list_jobs(db, actor)


@router.get("/jobs/{job_id}", response_model=JobRowData)
def get_job(
    job_id: str,
    db: Session = Depends(get_db),
    actor: ActorContext = Depends(get_actor_context),
) -> JobRowData:
    return etl_service.get_job(db, job_id, actor)


@router.patch("/jobs/{job_id}", response_model=JobRowData)
def update_job(
    job_id: str,
    request: UpdatePipelineRequest,
    db: Session = Depends(get_db),
    actor: ActorContext = Depends(get_actor_context),
) -> JobRowData:
    return etl_service.update_pipeline(db, job_id, request, actor)


@router.post("/jobs/{job_id}/commands", response_model=JobCommandResponse)
def command_job(
    job_id: str,
    request: JobCommandRequest,
    db: Session = Depends(get_db),
    actor: ActorContext = Depends(get_actor_context),
) -> JobCommandResponse:
    return etl_service.command_job(db, job_id, request.command, actor)


@router.get("/jobs/{job_id}/continuous/logs", response_model=ContinuousWorkerLogsResponse)
def get_continuous_worker_logs(
    job_id: str,
    tail: int = Query(default=200, ge=1, le=1000),
    db: Session = Depends(get_db),
    actor: ActorContext = Depends(get_actor_context),
) -> ContinuousWorkerLogsResponse:
    return etl_service.get_kafka_continuous_worker_logs(db, job_id, actor, tail)


@router.get("/jobs/{job_id}/continuous/quarantine", response_model=ContinuousQuarantineResponse)
def get_continuous_quarantine(
    job_id: str,
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
    actor: ActorContext = Depends(get_actor_context),
) -> ContinuousQuarantineResponse:
    return etl_service.get_kafka_continuous_quarantine(db, job_id, actor, limit)


@router.get("/jobs/{job_id}/continuous/maintenance-runs", response_model=list[ContinuousMaintenanceRun])
def list_continuous_maintenance_runs(
    job_id: str,
    db: Session = Depends(get_db),
    actor: ActorContext = Depends(get_actor_context),
) -> list[ContinuousMaintenanceRun]:
    return etl_service.list_kafka_continuous_maintenance_runs(db, job_id, actor)


@router.post("/jobs/{job_id}/continuous/quarantine/replays", response_model=ContinuousMaintenanceRun)
def replay_continuous_quarantine(
    job_id: str,
    request: ContinuousReplayRequest,
    db: Session = Depends(get_db),
    actor: ActorContext = Depends(get_actor_context),
) -> ContinuousMaintenanceRun:
    return etl_service.replay_kafka_continuous_quarantine(db, job_id, request, actor)


@router.post("/jobs/{job_id}/continuous/compactions", response_model=ContinuousMaintenanceRun)
def compact_continuous_target(
    job_id: str,
    request: ContinuousCompactionRequest,
    db: Session = Depends(get_db),
    actor: ActorContext = Depends(get_actor_context),
) -> ContinuousMaintenanceRun:
    return etl_service.compact_kafka_continuous_target(db, job_id, request, actor)


@router.post("/schedules/run-due", response_model=ScheduledJobRunResponse)
def run_due_scheduled_jobs(
    request: ScheduledJobRunRequest,
    db: Session = Depends(get_db),
    actor: ActorContext = Depends(get_actor_context),
) -> ScheduledJobRunResponse:
    return etl_service.run_due_scheduled_jobs(db, request, actor)
