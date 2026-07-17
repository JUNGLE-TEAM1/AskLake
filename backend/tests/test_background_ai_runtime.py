from __future__ import annotations

from contextlib import AbstractContextManager
from pathlib import Path

from app import main as main_module


class _SessionContext(AbstractContextManager):
    def __init__(self) -> None:
        self.session = object()

    def __enter__(self) -> object:
        return self.session

    def __exit__(self, *_args: object) -> None:
        return None


def test_scheduled_tick_runs_etl_and_both_rag_reconcilers(monkeypatch) -> None:
    context = _SessionContext()
    events: list[tuple[str, object]] = []

    class _RagService:
        def __init__(self, session: object) -> None:
            self.session = session

        def reconcile_alias_activations(self) -> None:
            events.append(("aliases", self.session))

        def reconcile_source_changes(self) -> None:
            events.append(("sources", self.session))

    monkeypatch.setattr(main_module, "SessionLocal", lambda: context)
    monkeypatch.setattr(main_module, "RagService", _RagService)
    monkeypatch.setattr(
        main_module,
        "run_due_scheduled_jobs",
        lambda session, _request: events.append(("etl", session)),
    )

    main_module.run_scheduled_job_tick()

    assert events == [
        ("etl", context.session),
        ("aliases", context.session),
        ("sources", context.session),
    ]


def test_review_recovery_worker_is_registered_in_application_lifespan() -> None:
    source = Path(main_module.__file__).read_text(encoding="utf-8")

    assert "from app.services.review_analysis_service import ReviewAnalysisService" in source
    assert "review_analysis_worker_loop()," in source
    assert 'name="asklake-review-analysis-worker"' in source
