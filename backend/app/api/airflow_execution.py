from secrets import compare_digest

from fastapi import APIRouter, Depends, Header, status
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.errors import ApiError
from app.schemas.etl import (
    AirflowCatalogReconciliationRequest,
    AirflowCatalogReconciliationResponse,
    AirflowSparkExecutionRequest,
)
from app.services import etl_service
from app.services.rag_service import RagService

router = APIRouter(prefix="/internal/airflow", tags=["internal-airflow"])


def require_airflow_execution_token(
    authorization: str | None = Header(default=None, alias="Authorization"),
) -> None:
    expected = settings.airflow_execution_api_token or settings.airflow_internal_token
    if not expected:
        raise ApiError(
            "AIRFLOW_EXECUTION_NOT_CONFIGURED",
            "AIRFLOW_EXECUTION_API_TOKEN or AIRFLOW_INTERNAL_TOKEN is required for Airflow Spark execution.",
            status.HTTP_503_SERVICE_UNAVAILABLE,
        )
    scheme, _, supplied = str(authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not supplied or not compare_digest(supplied, expected):
        raise ApiError(
            "AIRFLOW_EXECUTION_UNAUTHORIZED",
            "Airflow Spark execution token is invalid.",
            status.HTTP_401_UNAUTHORIZED,
        )


@router.post("/spark-runs/{run_id}/execute", response_model=dict)
def execute_spark_run(
    run_id: str,
    request: AirflowSparkExecutionRequest,
    _: None = Depends(require_airflow_execution_token),
    db: Session = Depends(get_db),
) -> dict:
    return etl_service.execute_airflow_spark_run(
        db,
        job_id=request.job_id,
        run_id=run_id,
        command=request.command,
    )


@router.post("/spark-runs/{run_id}/catalog", response_model=AirflowCatalogReconciliationResponse)
def reconcile_spark_run_catalog(
    run_id: str,
    request: AirflowCatalogReconciliationRequest,
    _: None = Depends(require_airflow_execution_token),
    db: Session = Depends(get_db),
) -> AirflowCatalogReconciliationResponse:
    return etl_service.reconcile_airflow_catalog(
        db,
        job_id=request.job_id,
        run_id=run_id,
    )


@router.post("/rag-jobs/{job_id}/result", response_model=dict)
def complete_rag_job(
    job_id: str,
    result: dict,
    _: None = Depends(require_airflow_execution_token),
    db: Session = Depends(get_db),
) -> dict:
    return RagService(db).complete_job(job_id, result).model_dump(by_alias=True, mode="json")


@router.post("/rag-jobs/{job_id}/validate", response_model=dict)
def validate_rag_job(
    job_id: str,
    _: None = Depends(require_airflow_execution_token),
    db: Session = Depends(get_db),
) -> dict:
    service = RagService(db)
    try:
        return service.validate_job(job_id)
    except ApiError as exc:
        service.complete_job(job_id, {"status": "failed", "error": exc.message})
        raise
