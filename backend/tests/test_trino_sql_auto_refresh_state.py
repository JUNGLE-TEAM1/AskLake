from types import SimpleNamespace

from app.services.trino_sql_job_service import TrinoSqlJobService


def test_successful_auto_refresh_advances_published_revision() -> None:
    job = SimpleNamespace(
        continuous_config={
            "revisionRefresh": {
                "latestSourceRevision": 12,
                "processingSourceRevision": 12,
                "publishedSourceRevision": 11,
                "status": "running",
            }
        }
    )

    TrinoSqlJobService._apply_auto_refresh_result(
        object(),
        job,
        {"autoRefresh": {"sourceDatasetId": "DATA-KAFKA", "sourceRevision": 12}},
        succeeded=True,
    )

    state = job.continuous_config["revisionRefresh"]
    assert state["publishedSourceRevision"] == 12
    assert state["processingSourceRevision"] is None
    assert state["status"] == "dashboard_ready"
    assert state["lastError"] is None


def test_failed_auto_refresh_keeps_last_published_revision() -> None:
    job = SimpleNamespace(
        continuous_config={
            "revisionRefresh": {
                "latestSourceRevision": 12,
                "processingSourceRevision": 12,
                "publishedSourceRevision": 11,
                "status": "running",
            }
        }
    )

    TrinoSqlJobService._apply_auto_refresh_result(
        object(),
        job,
        {"autoRefresh": {"sourceDatasetId": "DATA-KAFKA", "sourceRevision": 12}},
        succeeded=False,
        error_message="join failed",
    )

    state = job.continuous_config["revisionRefresh"]
    assert state["publishedSourceRevision"] == 11
    assert state["processingSourceRevision"] is None
    assert state["status"] == "failed"
    assert state["lastError"] == "join failed"
