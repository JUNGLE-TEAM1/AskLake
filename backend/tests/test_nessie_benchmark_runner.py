import json
from pathlib import Path

import pytest

from app.benchmarks.runner import (
    ReferenceCandidateSource,
    campaign_lock,
    ensure_private_receipt_dir,
    execute_bounded,
    validate_candidate,
    write_receipt_once,
)
from app.benchmarks.suite import load_suite
from app.schemas.trino import TrinoClientPage


SUITE = Path(__file__).parents[1] / "benchmarks/nessie-sql/question-suite.v1.json"


def test_static_validation_blocks_scope_star_and_cross_join() -> None:
    suite = load_suite(SUITE)
    select_star = next(case for case in suite.cases if case.case_id == "avoid_select_star")
    cross_join = next(case for case in suite.cases if case.case_id == "avoid_cross_join")

    assert validate_candidate(select_star, "SELECT * FROM orders_v1")["accepted"] is False
    assert validate_candidate(cross_join, "SELECT count(*) FROM orders_v1 CROSS JOIN products_v1")["accepted"] is False
    assert validate_candidate(cross_join, cross_join.reference_sql or "")["accepted"] is True
    assert validate_candidate(select_star, "SELECT order_id FROM payroll")["accepted"] is False


def test_reference_source_marks_expected_failure_instead_of_faking_sql() -> None:
    case = next(case for case in load_suite(SUITE).cases if case.expected_failure)
    with pytest.raises(RuntimeError, match="expected rejection"):
        ReferenceCandidateSource().generate(case)


def test_receipt_is_create_only_and_campaign_lock_is_exclusive(tmp_path: Path) -> None:
    receipt = tmp_path / "receipt.json"
    write_receipt_once(receipt, {"status": "failed"})
    assert json.loads(receipt.read_text()) == {"status": "failed"}
    with pytest.raises(FileExistsError):
        write_receipt_once(receipt, {"status": "succeeded"})

    with campaign_lock(tmp_path, "one"):
        with pytest.raises(RuntimeError, match="active"):
            with campaign_lock(tmp_path, "two"):
                pass
    assert not (tmp_path / ".active-campaign.lock").exists()


def test_receipts_must_stay_outside_repository(tmp_path: Path) -> None:
    repository = tmp_path / "repo"
    repository.mkdir()
    with pytest.raises(ValueError, match="outside"):
        ensure_private_receipt_dir(repository / "receipts", repository)


def test_timeout_cancels_active_trino_query() -> None:
    class Client:
        cancelled: list[str] = []

        def submit(self, _sql: str, **_kwargs: object) -> TrinoClientPage:
            return TrinoClientPage(queryId="q1", nextUri="http://trino/v1/next", rawStats={"state": "RUNNING"})

        def fetch(self, _uri: str, **_kwargs: object) -> TrinoClientPage:
            raise AssertionError("timeout must happen before fetch")

        def cancel(self, uri: str, **_kwargs: object) -> None:
            self.cancelled.append(uri)

    client = Client()
    with pytest.raises(TimeoutError):
        execute_bounded(client, "SELECT 1", timeout_seconds=0)  # type: ignore[arg-type]
    assert client.cancelled == ["http://trino/v1/next"]
