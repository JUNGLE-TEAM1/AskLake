import hmac

from fastapi import APIRouter, Depends, Header, status
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, get_actor_context
from app.core.database import get_db
from app.core.config import Settings, get_settings
from app.core.errors import ApiError
from app.schemas.common import ErrorCode
from app.schemas.etl import (
    CreatePipelineRequest,
    CreatePipelineResponse,
    JobCommandRequest,
    JobCommandResponse,
    InternalSparkExecutionRequest,
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
def ingest_kafka_reviews(request: KafkaReviewIngestRequest) -> KafkaReviewIngestResponse:
    return etl_service.ingest_kafka_reviews(request)


@router.post("/jobs", response_model=CreatePipelineResponse, status_code=status.HTTP_201_CREATED)
def create_job(
    request: CreatePipelineRequest,
    db: Session = Depends(get_db),
    actor: ActorContext = Depends(get_actor_context),
) -> CreatePipelineResponse:
    return etl_service.create_pipeline(db, request, actor)


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


@router.post("/jobs/{job_id}/commands", response_model=JobCommandResponse)
def command_job(
    job_id: str,
    request: JobCommandRequest,
    db: Session = Depends(get_db),
    actor: ActorContext = Depends(get_actor_context),
) -> JobCommandResponse:
    return etl_service.command_job(db, job_id, request.command, actor)


@router.post("/internal/jobs/{job_id}/runs/{run_id}/spark", response_model=dict)
def execute_airflow_spark_run(
    job_id: str,
    run_id: str,
    request: InternalSparkExecutionRequest,
    callback_token: str | None = Header(default=None, alias="X-AskLake-Airflow-Token"),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict:
    expected = settings.airflow_callback_token
    if expected and (not callback_token or not hmac.compare_digest(expected, callback_token)):
        raise ApiError(
            ErrorCode.UNAUTHORIZED,
            "Invalid Airflow callback token.",
            status.HTTP_401_UNAUTHORIZED,
        )
    return etl_service.execute_airflow_spark_run(db, job_id, run_id, request.command)


@router.post("/schedules/run-due", response_model=ScheduledJobRunResponse)
def run_due_scheduled_jobs(
    request: ScheduledJobRunRequest,
    db: Session = Depends(get_db),
    actor: ActorContext = Depends(get_actor_context),
) -> ScheduledJobRunResponse:
    return etl_service.run_due_scheduled_jobs(db, request, actor)
