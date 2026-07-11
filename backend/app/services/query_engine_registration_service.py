import hashlib
import re
import unicodedata
from typing import Any

from app.core.auth_context import ActorContext
from app.core.config import Settings, settings
from app.core.permission_metadata import dedupe_grants, resource_permissions
from app.repositories.audit_repository import safe_record_audit_event
from app.repositories.catalog_repository import CatalogRepository
from app.schemas.catalog import CatalogDatasetResponse, QueryEngineTableRef
from app.schemas.trino import TrinoQueryRunError
from app.services.trino_client import TrinoClient


OWNER_ACTIONS = ["view", "query", "run", "manage", "delete", "share"]


def physical_table_name(display_name: str, dataset_id: str) -> str:
    normalized_name = unicodedata.normalize("NFKC", display_name).casefold()
    slug = re.sub(r"[^a-z0-9_]+", "_", normalized_name).strip("_")
    slug = re.sub(r"_+", "_", slug)[:40].rstrip("_") or "dataset"
    suffix = hashlib.sha256(dataset_id.encode("utf-8")).hexdigest()[:16]
    return f"{slug}_{suffix}"


def build_query_engine_table(
    display_name: str,
    dataset_id: str,
    runtime_settings: Settings | None = None,
) -> QueryEngineTableRef:
    config = runtime_settings or settings
    return QueryEngineTableRef(
        catalog=config.trino_catalog,
        schema=config.trino_schema,
        table=physical_table_name(display_name, dataset_id),
        format="iceberg",
    )


class QueryEngineRegistrationService:
    def __init__(
        self,
        repository: CatalogRepository,
        *,
        client: TrinoClient | None = None,
        runtime_settings: Settings | None = None,
    ) -> None:
        self.repository = repository
        self.settings = runtime_settings or settings
        self.client = client or TrinoClient(
            self.settings,
            username=self.settings.trino_materializer_username,
            password=self.settings.trino_materializer_password,
        )

    def save_pending(
        self,
        payload: dict[str, Any],
        *,
        actor: ActorContext,
        run_id: str,
        target: QueryEngineTableRef,
    ) -> CatalogDatasetResponse:
        pending = self._registration_payload(payload, actor=actor, target=target, status="pending")
        saved = self.repository.save_dataset_payload(pending)
        self._record("started", actor=actor, dataset_id=str(payload["id"]), run_id=run_id)
        return CatalogDatasetResponse.model_validate(saved)

    def finalize(
        self,
        payload: dict[str, Any],
        *,
        actor: ActorContext,
        run_id: str,
        target: QueryEngineTableRef,
    ) -> CatalogDatasetResponse:
        try:
            self._verify_table(target)
        except Exception as exc:
            return self.mark_failed(payload, actor=actor, run_id=run_id, target=target, error=exc)
        available = self._registration_payload(payload, actor=actor, target=target, status="available")
        available.pop("queryEngineError", None)
        saved = self.repository.save_dataset_payload(available)
        self._record("succeeded", actor=actor, dataset_id=str(payload["id"]), run_id=run_id)
        return CatalogDatasetResponse.model_validate(saved)

    def mark_failed(
        self,
        payload: dict[str, Any],
        *,
        actor: ActorContext,
        run_id: str,
        target: QueryEngineTableRef,
        error: Exception | TrinoQueryRunError,
    ) -> CatalogDatasetResponse:
        failed = self._registration_payload(payload, actor=actor, target=target, status="registration_failed")
        failed["queryEngineError"] = registration_error_code(error)
        saved = self.repository.save_dataset_payload(failed)
        self._record(
            "failed",
            actor=actor,
            dataset_id=str(payload["id"]),
            run_id=run_id,
            result="failed",
            error_code=failed["queryEngineError"],
        )
        return CatalogDatasetResponse.model_validate(saved)

    def _verify_table(self, target: QueryEngineTableRef) -> None:
        query = "DESCRIBE " + ".".join(quote_identifier(value) for value in [target.catalog, target.schema_, target.table])
        page = self.client.submit(query)
        pages = 0
        has_columns = bool(page.rows)
        while page.next_uri and page.error is None:
            if pages >= 20:
                raise RuntimeError("TRINO_TABLE_VERIFICATION_PAGE_LIMIT")
            page = self.client.fetch(page.next_uri)
            pages += 1
            has_columns = has_columns or bool(page.rows)
        if page.error is not None:
            raise RuntimeError(page.error.code or "TRINO_TABLE_VERIFICATION_FAILED")
        if not has_columns:
            raise RuntimeError("TRINO_TABLE_VERIFICATION_EMPTY_SCHEMA")

    def _registration_payload(
        self,
        payload: dict[str, Any],
        *,
        actor: ActorContext,
        target: QueryEngineTableRef,
        status: str,
    ) -> dict[str, Any]:
        owner = str(payload.get("owner") or actor.name)
        owner_grant = {
            "actions": OWNER_ACTIONS,
            "principalId": actor.name or owner,
            "principalType": "user",
            "source": "owner",
        }
        next_payload = dict(payload)
        next_payload.update({
            "owner": owner,
            "createdBy": payload.get("createdBy") or actor.name,
            "permissionGrants": dedupe_grants([*(payload.get("permissionGrants") or []), owner_grant]),
            "permissions": resource_permissions(
                actor=actor.name,
                can_query=status == "available",
                can_run=status == "available",
                can_manage=True,
                can_delete=True,
                can_share=True,
            ),
            "queryEngineStatus": status,
        })
        if status == "available":
            next_payload["queryEngineTable"] = target.model_dump(by_alias=True)
        else:
            next_payload.pop("queryEngineTable", None)
        if status != "registration_failed":
            next_payload.pop("queryEngineError", None)
        return next_payload

    def _record(
        self,
        event: str,
        *,
        actor: ActorContext,
        dataset_id: str,
        run_id: str,
        result: str = "success",
        error_code: str | None = None,
    ) -> None:
        safe_record_audit_event(
            self.repository.db,
            action=f"dataset.query_engine.registration.{event}",
            actor=actor,
            api_path="/internal/query-engine-registration",
            http_method="POST",
            metadata={"errorCode": error_code, "runId": run_id},
            result=result,
            target_id=dataset_id,
            target_type="dataset",
        )


def quote_identifier(value: str) -> str:
    return f'"{value.replace(chr(34), chr(34) * 2)}"'


def registration_error_code(error: Exception | TrinoQueryRunError) -> str:
    code = getattr(error, "code", None)
    if code:
        return str(code)[:120]
    message = str(error).strip()
    if message and re.fullmatch(r"[A-Z][A-Z0-9_]{2,119}", message):
        return message
    return str(error.__class__.__name__ or "QUERY_ENGINE_REGISTRATION_FAILED")[:120]
