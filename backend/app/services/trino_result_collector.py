from dataclasses import dataclass
from uuid import uuid4

from fastapi import status

from app.core.auth_context import ActorContext
from app.core.config import Settings, settings
from app.core.errors import ApiError
from app.repositories.audit_repository import safe_record_audit_event
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.sql_repository import SqlRepository
from app.services.trino_query_run_service import TrinoQueryRunService


@dataclass(frozen=True)
class TrinoCollectorSummary:
    claimed_runs: int
    completed_runs: int
    retriable_failures: int


class TrinoResultCollector:
    """Durably claims and drains Trino continuation URLs outside request handling."""

    def __init__(
        self,
        repository: SqlRepository,
        catalog_repository: CatalogRepository,
        runtime_settings: Settings | None = None,
        worker_id: str | None = None,
    ) -> None:
        self.repository = repository
        self.catalog_repository = catalog_repository
        self.settings = runtime_settings or settings
        self.worker_id = worker_id or f"collector-{uuid4().hex[:12]}"
        self.query_service = TrinoQueryRunService(
            repository=repository,
            catalog_repository=catalog_repository,
            runtime_settings=self.settings,
        )

    def collect_available(self, *, max_runs: int = 20) -> TrinoCollectorSummary:
        claimed_runs = 0
        completed_runs = 0
        retriable_failures = 0

        while claimed_runs < max_runs:
            claim = self.repository.claim_next_trino_run(
                self.worker_id,
                self.settings.trino_collector_lease_seconds,
            )
            if claim is None:
                break
            claimed_runs += 1
            safe_record_audit_event(
                self.repository.db,
                action="query_run.collector.recovered" if claim.recovered else "query_run.collector.started",
                actor=ActorContext(name="AskLake Collector", role="admin"),
                api_path="/internal/trino-result-collector",
                http_method="POST",
                metadata={"workerId": self.worker_id},
                result="success",
                status_code=status.HTTP_202_ACCEPTED,
                target_id=claim.run_id,
                target_type="query_run",
            )
            try:
                response = self.query_service.collect_claimed_run(claim.run_id, self.worker_id, claim.generation)
                if response.status in {"succeeded", "failed", "cancelled"}:
                    completed_runs += 1
            except ApiError as exc:
                # Lease expiry makes this run recoverable by a later worker.
                retriable_failures += 1
                retry = self.repository.schedule_collector_retry(
                    claim.run_id,
                    worker_id=self.worker_id,
                    generation=claim.generation,
                )
                safe_record_audit_event(
                    self.repository.db,
                    action="query_run.collector.retry",
                    actor=ActorContext(name="AskLake Collector", role="admin"),
                    api_path="/internal/trino-result-collector",
                    http_method="POST",
                    metadata={
                        "workerId": self.worker_id,
                        "cause": str(exc.code),
                        "attempt": retry[0] if retry else None,
                        "nextAttemptAt": retry[1].isoformat() if retry else None,
                    },
                    result="failed",
                    status_code=exc.status_code,
                    target_id=claim.run_id,
                    target_type="query_run",
                )

        return TrinoCollectorSummary(
            claimed_runs=claimed_runs,
            completed_runs=completed_runs,
            retriable_failures=retriable_failures,
        )
