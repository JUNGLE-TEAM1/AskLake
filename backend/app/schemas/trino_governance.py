from typing import Literal

from pydantic import Field, model_validator

from app.schemas.common import CamelModel


class TrinoSqlJobGovernance(CamelModel):
    access_scope: Literal["organization", "private", "project"] = "private"
    owner: str = Field(min_length=1, max_length=320)
    permission_summary: str = Field(default="", max_length=2000)
    principal_id: str | None = Field(default=None, max_length=255)

    @model_validator(mode="after")
    def validate_scope_principal(self) -> "TrinoSqlJobGovernance":
        self.owner = self.owner.strip()
        self.principal_id = self.principal_id.strip() if self.principal_id else None
        if not self.owner:
            raise ValueError("Governance owner is required")
        if self.access_scope == "project" and not self.principal_id:
            raise ValueError("Project access requires a real group principalId")
        return self
