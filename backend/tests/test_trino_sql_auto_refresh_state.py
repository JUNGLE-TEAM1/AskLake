from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext
from app.core.config import settings
from app.core.errors import ApiError
from app.models import CatalogDatasetModel, ETLJobModel, ETLRunModel
from app.models.base import Base
from app.models.sql import SqlRunModel
from app.repositories import etl_repository
from app.repositories.catalog_deletion_repository import CatalogDeletionRepository
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.sql_repository import SqlRepository
from app.services import trino_sql_auto_refresh
from app.services.trino_sql_auto_refresh import (
    _claim_expired,
    _processing_claim_blocks_submission,
)
from app.services.trino_sql_job_service import TrinoSqlJobService
from app.schemas.trino import TrinoClientPage


@compiles(JSONB, "sqlite")
def compile_jsonb_for_sqlite(_type, _compiler, **_kwargs):
    return "JSON"


def claimed_state(
    revision: int = 13,
    published_revision: int = 12,
    *,
    claimed_at: str | None = None,
    latest_revision: int | None = None,
) -> dict:
    return {
        "claimId": f"claim-{revision}",
        "claimedAt": claimed_at or datetime.now(UTC).isoformat(),
        "latestSourceRevision": latest_revision or revision,
        "processingRunId": f"run_sql_{revision}",
        "processingSourceRevision": revision,
        "publishedSourceRevision": published_revision,
        "status": "running",
    }


def auto_refresh_payload(
    revision: int = 13,
    *,
    finalized: bool = False,
    status: str = "succeeded",
) -> dict:
    run_id = f"run_sql_{revision}"
    return {
        "autoRefresh": {
            "claimId": f"claim-{revision}",
            "sourceDatasetId": "DATA-KAFKA",
            "sourceRevision": revision,
        },
        "datasetId": "DATA-GOLD",
        "engine": "trino-job-materialization",
        "etlRunId": run_id,
        "finalized": finalized,
        "jobId": "job-refresh",
        "query": f"CREATE TABLE gold_{revision} AS SELECT 1",
        "runId": run_id,
        "status": status,
        "target": {
            "catalog": "iceberg",
            "schema": "gold",
            "table": f"gold_{revision}",
            "format": "iceberg",
            "partitionColumns": [],
        },
        "updateCount": 1,
    }


def refresh_job(state: dict) -> SimpleNamespace:
    return SimpleNamespace(
        id="job-refresh",
        sql_recipe={
            "baseDatasetId": "DATA-KAFKA",
            "query": "SELECT * FROM kafka JOIN products USING (product_id)",
            "referenceDatasetIds": ["DATA-PRODUCTS"],
        },
        continuous_config={"revisionRefresh": dict(state)},
    )


def persisted_job(state: dict) -> ETLJobModel:
    return ETLJobModel(
        id="job-refresh",
        name="refresh",
        owner="owner",
        status="running",
        tag="test",
        source="Kafka + S3",
        target="gold",
        schedule="revision",
        source_config=[],
        source_label="kafka",
        source_type="Kafka",
        job_kind="trino_sql_materialization",
        sql_recipe={
            "baseDatasetId": "DATA-KAFKA",
            "query": "SELECT 1 AS id",
            "referenceDatasetIds": ["DATA-PRODUCTS"],
            "target": {
                "datasetId": "DATA-GOLD",
                "datasetName": "gold",
                "partitionColumns": [],
            },
        },
        continuous_config={"revisionRefresh": dict(state)},
        schema_columns=[],
        schema_sample_rows=[],
        target_format="iceberg",
        target_layer="GOLD",
        transform_output_columns=[],
        transform_steps=[],
        quality_invalid_rows=[],
        quality_rules=[],
        last_run="-",
        last_state="running",
        next_run="-",
        stats={},
        dag_steps=[],
        dataset_id="DATA-GOLD",
    )


class FakeDb:
    def __init__(self, freshness=None) -> None:
        self.freshness = freshness
        self.commit_count = 0
        self.rollback_count = 0

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        return None

    def add(self, _value) -> None:
        return None

    def commit(self) -> None:
        self.commit_count += 1

    def rollback(self) -> None:
        self.rollback_count += 1

    def get(self, _model, _identity):
        return self.freshness


class FakeSqlRepository:
    def __init__(self, payload: dict | None = None) -> None:
        self.payload = payload

    def get_run_payload(self, _run_id: str) -> dict | None:
        return self.payload

    def get_latest_trino_job_auto_refresh_run_payload(
        self,
        _job_id: str,
        _source_revision: int,
    ) -> dict | None:
        return self.payload

    def get_active_trino_job_run_payload(self, _job_id: str) -> dict | None:
        if self.payload is None:
            return None
        return self.payload if self.payload.get("status") in {"queued", "running"} else None

    def get_unfinalized_trino_job_run_payload(self, _job_id: str) -> dict | None:
        if self.payload is None:
            return None
        return self.payload if self.payload.get("finalized") is not True else None


class FakeCatalogRepository:
    def __init__(self, datasets: dict[str, object]) -> None:
        self.datasets = datasets

    def get_dataset_model(self, dataset_id: str):
        return self.datasets.get(dataset_id)


class FakeFinalizeRepository:
    def __init__(self, db: FakeDb) -> None:
        self.db = db
        self.saved_payloads: list[tuple[dict, bool]] = []

    def save_run_payload(self, payload: dict, *, commit: bool = True) -> dict:
        self.saved_payloads.append((dict(payload), commit))
        if commit:
            self.db.commit()
        return payload


class FakeFinalizeCatalogRepository:
    def __init__(self, db: FakeDb, dataset: dict | None = None) -> None:
        self.db = db
        self.dataset = dataset
        self.saved_payloads: list[tuple[dict, bool]] = []

    def get_dataset_payload(self, _dataset_id: str) -> dict | None:
        return self.dataset

    def save_dataset_payload(self, payload: dict, *, commit: bool = True) -> dict:
        self.saved_payloads.append((dict(payload), commit))
        if commit:
            self.db.commit()
        return payload


class FailingFinalizeSqlRepository(SqlRepository):
    def save_run_payload(self, payload: dict, *, commit: bool = True) -> dict:
        if payload.get("finalized") is True and not commit:
            raise RuntimeError("final marker write failed")
        return super().save_run_payload(payload, commit=commit)


class ReservationCheckingClient:
    def __init__(self, engine, run_id: str, *, failure: ApiError | None = None) -> None:
        self.engine = engine
        self.failure = failure
        self.run_id = run_id
        self.reservation: dict | None = None

    def submit(self, _statement: str) -> TrinoClientPage:
        with Session(self.engine) as check_db:
            self.reservation = SqlRepository(check_db).get_run_payload(self.run_id)
        if self.reservation is None:
            raise AssertionError("Trino CTAS started before its durable reservation committed")
        if self.failure is not None:
            raise self.failure
        return TrinoClientPage(
            next_uri="http://trino.example/v1/statement/queued",
            query_id="query-1",
            raw_stats={"state": "QUEUED"},
            state="QUEUED",
        )


def submission_service(db: Session, client: ReservationCheckingClient) -> TrinoSqlJobService:
    service = object.__new__(TrinoSqlJobService)
    service.repository = SqlRepository(db)
    service.catalog_repository = SimpleNamespace()
    service.settings = settings.model_copy(update={"trino_enabled": True})
    service.client = client
    service.query_access = SimpleNamespace(
        compile_for_actor=lambda **_kwargs: ("SELECT 1 AS id", []),
    )
    service.registration = SimpleNamespace()
    service._ensure_target_schema = Mock()
    service._record = Mock()
    service._result = Mock(return_value=SimpleNamespace())
    return service


def execute_fake_finalize(
    state: dict,
    payload: dict,
    *,
    catalog_dataset: dict | None = None,
) -> SimpleNamespace:
    job = SimpleNamespace(
        id="job-refresh",
        name="refresh",
        status="running-new-claim",
        continuous_config={"revisionRefresh": dict(state)},
        dag_steps=[],
        dag_steps_by_run_id={},
    )
    run = SimpleNamespace(
        run_id=str(payload["runId"]),
        started_at="2026-07-24T00:00:00Z",
    )
    db = FakeDb()
    repository = FakeFinalizeRepository(db)
    catalog = FakeFinalizeCatalogRepository(db, catalog_dataset)
    service = object.__new__(TrinoSqlJobService)
    service.repository = repository
    service.catalog_repository = catalog
    service.registration = SimpleNamespace(
        describe_table=lambda _target: [["id", "bigint"]],
    )
    service._apply_terminal_job_state = Mock()
    service._catalog_payload = Mock(return_value={
        "id": "DATA-GOLD",
        "name": "gold",
        "rag": False,
        "sourceRunId": run.run_id,
    })
    service._drop_unpublished_target = Mock()
    service._record = Mock()

    with (
        patch.object(etl_repository, "get_job_for_update", return_value=job) as get_job,
        patch.object(etl_repository, "get_run_model", return_value=run),
        patch.object(
            etl_repository,
            "get_dataset_schema_by_id",
            return_value=SimpleNamespace(id="DATA-GOLD"),
        ),
        patch.object(
            etl_repository,
            "job_to_schema",
            return_value=SimpleNamespace(id=job.id),
        ),
        patch.object(
            etl_repository,
            "run_to_schema",
            return_value=SimpleNamespace(run_id=run.run_id),
        ),
    ):
        result = service._finalize(payload, str(payload["status"]), None)

    return SimpleNamespace(
        catalog=catalog,
        db=db,
        get_job=get_job,
        job=job,
        repository=repository,
        result=result,
        run=run,
        service=service,
    )


class TrinoSqlAutoRefreshStateTests(unittest.TestCase):
    def test_sync_job_reproduced_terminal_gap_does_not_submit_twice(self) -> None:
        state = claimed_state()
        job = refresh_job(state)
        db = FakeDb(SimpleNamespace(latest_revision=13))
        repository = FakeSqlRepository(auto_refresh_payload(finalized=False))
        catalog = FakeCatalogRepository({
            "DATA-KAFKA": SimpleNamespace(id="DATA-KAFKA", relation_mode="streaming"),
            "DATA-PRODUCTS": SimpleNamespace(id="DATA-PRODUCTS", relation_mode="static"),
        })

        with (
            patch.object(trino_sql_auto_refresh, "SessionLocal", return_value=db),
            patch.object(etl_repository, "get_job_for_update", return_value=job),
            patch.object(trino_sql_auto_refresh, "CatalogRepository", return_value=catalog),
            patch.object(trino_sql_auto_refresh, "SqlRepository", return_value=repository),
            patch.object(TrinoSqlJobService, "submit") as submit,
        ):
            trino_sql_auto_refresh._sync_job(job.id)

        submit.assert_not_called()

    def test_terminal_unfinalized_manual_run_blocks_revision_submission(self) -> None:
        job = refresh_job({"publishedSourceRevision": 12, "status": "dashboard_ready"})
        db = FakeDb(SimpleNamespace(latest_revision=13))
        payload = {
            **auto_refresh_payload(finalized=False),
            "autoRefresh": None,
        }
        repository = FakeSqlRepository(payload)
        catalog = FakeCatalogRepository({
            "DATA-KAFKA": SimpleNamespace(id="DATA-KAFKA", relation_mode="streaming"),
            "DATA-PRODUCTS": SimpleNamespace(id="DATA-PRODUCTS", relation_mode="static"),
        })

        with (
            patch.object(trino_sql_auto_refresh, "SessionLocal", return_value=db),
            patch.object(etl_repository, "get_job_for_update", return_value=job),
            patch.object(trino_sql_auto_refresh, "CatalogRepository", return_value=catalog),
            patch.object(trino_sql_auto_refresh, "SqlRepository", return_value=repository),
            patch.object(TrinoSqlJobService, "submit") as submit,
        ):
            trino_sql_auto_refresh._sync_job(job.id)

        submit.assert_not_called()

    def test_sync_job_claim_blocks_followup_until_first_run_finishes(self) -> None:
        job = refresh_job({"publishedSourceRevision": 13, "status": "dashboard_ready"})
        db = FakeDb(SimpleNamespace(latest_revision=14))
        repository = FakeSqlRepository()
        catalog = FakeCatalogRepository({
            "DATA-KAFKA": SimpleNamespace(id="DATA-KAFKA", relation_mode="streaming"),
            "DATA-PRODUCTS": SimpleNamespace(id="DATA-PRODUCTS", relation_mode="static"),
        })

        with (
            patch.object(trino_sql_auto_refresh, "SessionLocal", return_value=db),
            patch.object(etl_repository, "get_job_for_update", return_value=job),
            patch.object(etl_repository, "get_run_model", return_value=None),
            patch.object(trino_sql_auto_refresh, "CatalogRepository", return_value=catalog),
            patch.object(trino_sql_auto_refresh, "SqlRepository", return_value=repository),
            patch(
                "app.services.etl_service.trino_sql_job_run_as_actor",
                return_value=SimpleNamespace(id="owner", name="owner"),
            ),
            patch.object(TrinoSqlJobService, "submit") as submit,
        ):
            trino_sql_auto_refresh._sync_job(job.id)
            trino_sql_auto_refresh._sync_job(job.id)

        submit.assert_called_once()
        submitted = job.continuous_config["revisionRefresh"]
        self.assertEqual(submitted["processingSourceRevision"], 14)
        self.assertTrue(submitted["processingRunId"].startswith("run_sql_"))
        self.assertTrue(submitted["claimId"])

    def test_terminal_payload_does_not_release_expired_claim_before_finalization(self) -> None:
        state = claimed_state(
            claimed_at=(datetime.now(UTC) - timedelta(hours=3)).isoformat(),
        )
        job = SimpleNamespace(
            id="job-refresh",
            continuous_config={"revisionRefresh": dict(state)},
        )

        self.assertTrue(_processing_claim_blocks_submission(
            FakeDb(),
            job,
            FakeSqlRepository(auto_refresh_payload(finalized=False)),
            state,
        ))
        self.assertEqual(
            job.continuous_config["revisionRefresh"]["processingSourceRevision"],
            13,
        )

    def test_next_revision_is_unblocked_only_after_matching_run_finalizes(self) -> None:
        state = claimed_state(latest_revision=14)
        job = SimpleNamespace(
            id="job-refresh",
            continuous_config={"revisionRefresh": dict(state)},
        )
        payload = auto_refresh_payload(finalized=False, status="running")

        self.assertTrue(_processing_claim_blocks_submission(
            FakeDb(),
            job,
            FakeSqlRepository(payload),
            state,
        ))
        self.assertTrue(
            TrinoSqlJobService._apply_auto_refresh_result(job, payload, succeeded=True)
        )
        completed = job.continuous_config["revisionRefresh"]
        self.assertEqual(completed["publishedSourceRevision"], 13)
        self.assertIsNone(completed["processingRunId"])
        self.assertIsNone(completed["processingSourceRevision"])
        self.assertNotIn("claimId", completed)
        self.assertFalse(_processing_claim_blocks_submission(
            FakeDb(),
            job,
            FakeSqlRepository(),
            completed,
        ))

    def test_stale_run_cannot_clear_or_publish_a_newer_claim(self) -> None:
        state = claimed_state(14, 13)
        job = SimpleNamespace(continuous_config={"revisionRefresh": dict(state)})
        stale_payload = auto_refresh_payload(13)

        self.assertFalse(TrinoSqlJobService._auto_refresh_claim_matches(job, stale_payload))
        self.assertFalse(
            TrinoSqlJobService._apply_auto_refresh_result(
                job,
                stale_payload,
                succeeded=True,
            )
        )
        self.assertEqual(job.continuous_config["revisionRefresh"], state)

    def test_stale_finalize_does_not_overwrite_newer_job_or_catalog(self) -> None:
        state = claimed_state(14, 13)
        payload = auto_refresh_payload(13)
        fixture = execute_fake_finalize(state, payload)

        fixture.get_job.assert_called_once_with(fixture.db, "job-refresh")
        fixture.service._apply_terminal_job_state.assert_not_called()
        fixture.service._drop_unpublished_target.assert_called_once_with(payload)
        self.assertEqual(fixture.catalog.saved_payloads, [])
        self.assertEqual(fixture.job.status, "running-new-claim")
        self.assertEqual(fixture.job.continuous_config["revisionRefresh"], state)
        final_payload, commit = fixture.repository.saved_payloads[0]
        self.assertEqual(final_payload["status"], "failed")
        self.assertTrue(final_payload["finalized"])
        self.assertFalse(commit)
        self.assertEqual(fixture.db.commit_count, 1)

    def test_late_manual_finalize_cannot_overwrite_revision_claim(self) -> None:
        state = claimed_state(14, 13)
        payload = {
            **auto_refresh_payload(13),
            "autoRefresh": None,
        }
        fixture = execute_fake_finalize(state, payload)

        fixture.service._apply_terminal_job_state.assert_not_called()
        fixture.service._drop_unpublished_target.assert_called_once_with(payload)
        self.assertEqual(fixture.catalog.saved_payloads, [])
        self.assertEqual(fixture.job.status, "running-new-claim")
        self.assertEqual(fixture.job.continuous_config["revisionRefresh"], state)
        final_payload, commit = fixture.repository.saved_payloads[0]
        self.assertEqual(final_payload["status"], "failed")
        self.assertTrue(final_payload["finalized"])
        self.assertFalse(commit)

    def test_already_published_stale_finalize_repairs_marker_without_drop(self) -> None:
        state = claimed_state(14, 13)
        payload = auto_refresh_payload(13)
        fixture = execute_fake_finalize(
            state,
            payload,
            catalog_dataset={"id": "DATA-GOLD", "sourceRunId": "run_sql_13"},
        )

        fixture.service._apply_terminal_job_state.assert_not_called()
        fixture.service._drop_unpublished_target.assert_not_called()
        self.assertEqual(fixture.catalog.saved_payloads, [])
        self.assertEqual(fixture.job.continuous_config["revisionRefresh"], state)
        final_payload, commit = fixture.repository.saved_payloads[0]
        self.assertEqual(final_payload["status"], "succeeded")
        self.assertTrue(final_payload["finalized"])
        self.assertFalse(commit)
        self.assertEqual(fixture.result.dataset.id, "DATA-GOLD")

    def test_matching_finalize_commits_catalog_claim_and_marker_atomically(self) -> None:
        state = claimed_state(latest_revision=14)
        fixture = execute_fake_finalize(state, auto_refresh_payload())

        self.assertEqual(
            fixture.catalog.saved_payloads,
            [({
                "id": "DATA-GOLD",
                "name": "gold",
                "rag": False,
                "sourceRunId": "run_sql_13",
            }, False)],
        )
        final_payload, commit = fixture.repository.saved_payloads[0]
        self.assertEqual(final_payload["status"], "succeeded")
        self.assertTrue(final_payload["finalized"])
        self.assertFalse(commit)
        self.assertEqual(fixture.db.commit_count, 1)
        completed = fixture.job.continuous_config["revisionRefresh"]
        self.assertEqual(completed["publishedSourceRevision"], 13)
        self.assertIsNone(completed["processingRunId"])
        self.assertNotIn("claimId", completed)

    def test_final_marker_failure_rolls_back_catalog_and_claim_together(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:")
        Base.metadata.create_all(
            engine,
            tables=[
                ETLJobModel.__table__,
                ETLRunModel.__table__,
                CatalogDatasetModel.__table__,
                SqlRunModel.__table__,
            ],
        )
        with Session(engine) as warm_db:
            CatalogRepository(warm_db).list_dataset_models()
            CatalogDeletionRepository(warm_db).has_fence("DATA-GOLD")
            SqlRepository(warm_db).get_run_payload("missing")

        state = claimed_state()
        payload = auto_refresh_payload()
        with Session(engine) as db:
            db.add(persisted_job(state))
            db.add(ETLRunModel(
                run_id="run_sql_13",
                job_id="job-refresh",
                status="running",
                started_at="2026-07-24T00:00:00Z",
                ended_at="-",
                duration="-",
                input_rows="-",
                output_rows="-",
                output_path="-",
                failed_stage="",
                error_summary="",
            ))
            db.add(CatalogDatasetModel(
                id="DATA-GOLD",
                name="gold",
                payload={
                    "id": "DATA-GOLD",
                    "name": "gold",
                    "rag": False,
                    "sourceRunId": "run_sql_12",
                },
            ))
            db.add(SqlRunModel(
                id="run_sql_13",
                dataset_id="DATA-GOLD",
                query=str(payload["query"]),
                payload=dict(payload),
            ))
            db.commit()

            service = object.__new__(TrinoSqlJobService)
            service.repository = FailingFinalizeSqlRepository(db)
            service.catalog_repository = CatalogRepository(db)
            service.registration = SimpleNamespace(
                describe_table=lambda _target: [["id", "bigint"]],
            )
            service._apply_terminal_job_state = Mock()
            service._catalog_payload = Mock(return_value={
                "id": "DATA-GOLD",
                "name": "gold",
                "rag": False,
                "sourceRunId": "run_sql_13",
            })
            service._record = Mock()

            with (
                patch.object(etl_repository, "ensure_schema"),
                self.assertRaisesRegex(RuntimeError, "final marker write failed"),
            ):
                service._finalize(payload, "succeeded", None)

            db.expire_all()
            job = db.get(ETLJobModel, "job-refresh")
            catalog = db.get(CatalogDatasetModel, "DATA-GOLD")
            sql_run = db.get(SqlRunModel, "run_sql_13")
            run = db.get(ETLRunModel, "run_sql_13")
            self.assertEqual(
                job.continuous_config["revisionRefresh"]["claimId"],
                "claim-13",
            )
            self.assertEqual(
                job.continuous_config["revisionRefresh"]["publishedSourceRevision"],
                12,
            )
            self.assertEqual(catalog.payload["sourceRunId"], "run_sql_12")
            self.assertIsNot(sql_run.payload.get("finalized"), True)
            self.assertEqual(run.status, "running")

        engine.dispose()

    def test_successful_auto_refresh_advances_published_revision(self) -> None:
        job = SimpleNamespace(continuous_config={
            "revisionRefresh": {
                "latestSourceRevision": 12,
                "processingSourceRevision": 12,
                "publishedSourceRevision": 11,
                "status": "running",
            }
        })

        TrinoSqlJobService._apply_auto_refresh_result(
            job,
            {"autoRefresh": {"sourceDatasetId": "DATA-KAFKA", "sourceRevision": 12}},
            succeeded=True,
        )

        state = job.continuous_config["revisionRefresh"]
        self.assertEqual(state["publishedSourceRevision"], 12)
        self.assertIsNone(state["processingSourceRevision"])
        self.assertEqual(state["status"], "dashboard_ready")
        self.assertIsNone(state["lastError"])

    def test_failed_auto_refresh_keeps_last_published_revision(self) -> None:
        job = SimpleNamespace(continuous_config={
            "revisionRefresh": {
                "latestSourceRevision": 12,
                "processingSourceRevision": 12,
                "publishedSourceRevision": 11,
                "status": "running",
            }
        })

        TrinoSqlJobService._apply_auto_refresh_result(
            job,
            {"autoRefresh": {"sourceDatasetId": "DATA-KAFKA", "sourceRevision": 12}},
            succeeded=False,
            error_message="join failed",
        )

        state = job.continuous_config["revisionRefresh"]
        self.assertEqual(state["publishedSourceRevision"], 11)
        self.assertIsNone(state["processingSourceRevision"])
        self.assertEqual(state["status"], "failed")
        self.assertEqual(state["lastError"], "join failed")

    def test_claim_expiry_uses_configured_lease_window(self) -> None:
        now = datetime(2026, 7, 24, 1, 0, tzinfo=UTC)
        self.assertFalse(_claim_expired(
            {"claimedAt": (now - timedelta(seconds=30)).isoformat()},
            now=now,
        ))
        self.assertTrue(_claim_expired(
            {"claimedAt": (now - timedelta(hours=3)).isoformat()},
            now=now,
        ))

    def test_manual_submission_is_blocked_while_revision_claim_is_active(self) -> None:
        service = object.__new__(TrinoSqlJobService)
        service.repository = FakeSqlRepository()
        job = SimpleNamespace(
            id="job-refresh",
            continuous_config={"revisionRefresh": claimed_state()},
        )

        with self.assertRaises(ApiError) as raised:
            service._require_submission_slot(job, "run_sql_manual", None)

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(
            raised.exception.details["sourceRevision"],
            13,
        )

    def test_pending_submission_cannot_be_cancelled_without_query_identity(self) -> None:
        payload = {
            **auto_refresh_payload(status="queued"),
            "submissionOutcome": "pending",
            "trinoNextUri": None,
        }
        service = object.__new__(TrinoSqlJobService)
        service.repository = FakeSqlRepository(payload)
        service.settings = settings.model_copy(update={"trino_enabled": True})
        job = SimpleNamespace(
            id="job-refresh",
            job_kind="trino_sql_materialization",
        )

        with self.assertRaises(ApiError) as raised:
            service.cancel(job, ActorContext(id="owner", name="owner"))

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.details["runId"], "run_sql_13")

    def test_submission_reloads_locked_job_before_reserving_stale_claim(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:")
        Base.metadata.create_all(
            engine,
            tables=[
                ETLJobModel.__table__,
                ETLRunModel.__table__,
                SqlRunModel.__table__,
            ],
        )
        db = Session(engine, expire_on_commit=False)
        try:
            stale_job = persisted_job(claimed_state())
            db.add(stale_job)
            db.commit()
            with Session(engine) as updater:
                current = updater.get(ETLJobModel, "job-refresh")
                current.continuous_config = {
                    "revisionRefresh": claimed_state(14, 12),
                }
                updater.commit()

            service = submission_service(
                db,
                ReservationCheckingClient(engine, "run_sql_13"),
            )
            with self.assertRaises(ApiError) as raised:
                service.submit(
                    stale_job,
                    "revisionRefresh",
                    ActorContext(id="owner", name="owner"),
                    run_id="run_sql_13",
                    auto_refresh_context={
                        "claimId": "claim-13",
                        "sourceDatasetId": "DATA-KAFKA",
                        "sourceRevision": 13,
                    },
                )

            self.assertEqual(raised.exception.status_code, 409)
            self.assertIsNone(SqlRepository(db).get_run_payload("run_sql_13"))
        finally:
            db.close()
            engine.dispose()

    def test_ctas_submission_starts_only_after_durable_run_reservation(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:")
        Base.metadata.create_all(
            engine,
            tables=[
                ETLJobModel.__table__,
                ETLRunModel.__table__,
                SqlRunModel.__table__,
            ],
        )
        run_id = "run_sql_reserved"
        with Session(engine) as db:
            job = persisted_job({
                **claimed_state(),
                "processingRunId": run_id,
            })
            db.add(job)
            db.commit()
            client = ReservationCheckingClient(engine, run_id)
            service = submission_service(db, client)

            service.submit(
                job,
                "revisionRefresh",
                ActorContext(id="owner", name="owner"),
                run_id=run_id,
                auto_refresh_context={
                    "claimId": "claim-13",
                    "sourceDatasetId": "DATA-KAFKA",
                    "sourceRevision": 13,
                },
            )

        with Session(engine) as check_db:
            payload = SqlRepository(check_db).get_run_payload(run_id)
        engine.dispose()
        self.assertIsNotNone(client.reservation)
        self.assertEqual(client.reservation["submissionOutcome"], "pending")
        self.assertFalse(client.reservation["finalized"])
        self.assertEqual(payload["submissionOutcome"], "accepted")
        self.assertFalse(payload["finalized"])

    def test_unknown_trino_submission_keeps_claim_and_blocks_retry(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:")
        Base.metadata.create_all(
            engine,
            tables=[
                ETLJobModel.__table__,
                ETLRunModel.__table__,
                SqlRunModel.__table__,
            ],
        )
        run_id = "run_sql_unknown"
        with Session(engine) as db:
            job = persisted_job({
                **claimed_state(),
                "processingRunId": run_id,
            })
            db.add(job)
            db.commit()
            client = ReservationCheckingClient(
                engine,
                run_id,
                failure=ApiError(
                    "BACKEND_TIMEOUT",
                    "Trino coordinator is unavailable",
                    503,
                ),
            )
            service = submission_service(db, client)
            service._apply_terminal_job_state = Mock()

            with self.assertRaises(ApiError):
                service.submit(
                    job,
                    "revisionRefresh",
                    ActorContext(id="owner", name="owner"),
                    run_id=run_id,
                    auto_refresh_context={
                        "claimId": "claim-13",
                        "sourceDatasetId": "DATA-KAFKA",
                        "sourceRevision": 13,
                    },
                )

        with Session(engine) as check_db:
            persisted = check_db.get(ETLJobModel, "job-refresh")
            persisted_run = check_db.get(ETLRunModel, run_id)
            payload = SqlRepository(check_db).get_run_payload(run_id)
            blocker = SqlRepository(check_db).get_unfinalized_trino_job_run_payload(
                "job-refresh",
            )
        engine.dispose()
        state = persisted.continuous_config["revisionRefresh"]
        self.assertEqual(state["claimId"], "claim-13")
        self.assertEqual(state["processingRunId"], run_id)
        self.assertEqual(state["processingSourceRevision"], 13)
        self.assertEqual(state["status"], "failed")
        self.assertEqual(persisted.status, "running")
        self.assertEqual(persisted_run.status, "running")
        self.assertEqual(payload["status"], "submission_unknown")
        self.assertEqual(payload["submissionOutcome"], "unknown")
        self.assertFalse(payload["finalized"])
        self.assertEqual(blocker["runId"], run_id)

    def test_repository_finds_durable_run_for_exact_job_and_revision(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:")
        with Session(engine) as db:
            repository = SqlRepository(db)
            repository.save_run_payload(auto_refresh_payload())
            repository.save_run_payload({
                **auto_refresh_payload(),
                "jobId": "job-other",
                "runId": "run_sql_other",
                "etlRunId": "run_sql_other",
            })
            payload = repository.get_latest_trino_job_auto_refresh_run_payload(
                "job-refresh",
                13,
            )

        engine.dispose()
        self.assertIsNotNone(payload)
        self.assertEqual(payload["runId"], "run_sql_13")

    def test_repository_ignores_only_fully_finalized_job_runs(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:")
        with Session(engine) as db:
            repository = SqlRepository(db)
            repository.save_run_payload({
                **auto_refresh_payload(status="failed"),
                "autoRefresh": None,
                "finalized": False,
            })
            self.assertIsNotNone(
                repository.get_unfinalized_trino_job_run_payload("job-refresh")
            )
            repository.save_run_payload({
                **auto_refresh_payload(status="failed"),
                "autoRefresh": None,
                "finalized": True,
            })
            self.assertIsNone(
                repository.get_unfinalized_trino_job_run_payload("job-refresh")
            )

        engine.dispose()


if __name__ == "__main__":
    unittest.main()
