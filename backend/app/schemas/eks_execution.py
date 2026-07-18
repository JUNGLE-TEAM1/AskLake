"""Private Airflow-to-EKS execution request schemas."""

from typing import Literal

from pydantic import Field

from app.schemas.common import CamelModel


class AirflowMskAuthorizationFaultRequest(CamelModel):
    acknowledged_records: Literal[0]
    attempted_records: Literal[1]
    category: Literal["AUTHORIZATION"]
    evidence_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    job_id: str
