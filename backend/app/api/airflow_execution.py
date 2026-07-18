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
from app.schemas.eks_execution import AirflowMskAuthorizationFaultRequest
from app.application.eks_msk_fault_execution import (
    record_eks_msk_authorization_fault,
)
from app.services import etl_service

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
        airflow_source_boundary=request.source_boundary,
    )


@router.post("/spark-runs/{run_id}/fault-attempts/msk-authorization", response_model=dict)
def record_msk_authorization_fault(
    run_id: str,
    request: AirflowMskAuthorizationFaultRequest,
    _: None = Depends(require_airflow_execution_token),
    db: Session = Depends(get_db),
) -> dict:
    return record_eks_msk_authorization_fault(
        db,
        acknowledged_records=request.acknowledged_records,
        attempted_records=request.attempted_records,
        category=request.category,
        evidence_sha256=request.evidence_sha256,
        job_id=request.job_id,
        run_id=run_id,
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
