from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
import hashlib
import json
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.benchmarks.dataset import execute_statement
from app.services.trino_client import TrinoClient


class GoldenExpectation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    row_count: int | None = Field(default=None, ge=0)
    result_hash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    numeric_tolerance: float | None = Field(default=None, ge=0)
    numeric_value: float | None = None


class CostExpectation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    max_processed_bytes: int | None = Field(default=None, ge=0)
    partition_pruning_required: bool = False


class BenchmarkCase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    case_id: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    case_type: Literal[
        "projection_filter",
        "time_partition",
        "aggregate",
        "high_cardinality",
        "fact_dimension_join",
        "multi_join",
        "ambiguous",
        "invalid_scope",
        "select_star_trap",
        "cross_join_trap",
        "approximate_aggregate",
    ]
    question: str = Field(min_length=3)
    allowed_datasets: list[str] = Field(min_length=1)
    expected_semantics: list[str] = Field(min_length=1)
    reference_sql: str | None = None
    golden: GoldenExpectation
    forbidden_patterns: list[str] = Field(default_factory=list)
    cost: CostExpectation = Field(default_factory=CostExpectation)
    expected_failure: bool = False
    approximate_allowed: bool = False
    result_order_matters: bool = False

    @model_validator(mode="after")
    def validate_outcome(self) -> "BenchmarkCase":
        if self.expected_failure and self.reference_sql is not None:
            raise ValueError("expected failure cases must not include reference SQL")
        if not self.expected_failure and not self.reference_sql:
            raise ValueError("successful cases require reference SQL")
        if self.approximate_allowed and self.golden.numeric_tolerance is None:
            raise ValueError("approximate cases require numeric tolerance")
        return self


class BenchmarkSuite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    suite_id: str
    suite_version: str
    fixture_version: str
    cases: list[BenchmarkCase] = Field(min_length=1)

    @model_validator(mode="after")
    def unique_cases(self) -> "BenchmarkSuite":
        ids = [case.case_id for case in self.cases]
        if len(ids) != len(set(ids)):
            raise ValueError("benchmark case IDs must be unique")
        return self

    def canonical_hash(self) -> str:
        payload = self.model_dump(mode="json")
        return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def load_suite(path: Path) -> BenchmarkSuite:
    return BenchmarkSuite.model_validate_json(path.read_text(encoding="utf-8"))


def canonical_result_hash(columns: list[str], rows: list[list[Any]], *, order_matters: bool = True) -> str:
    # Output aliases are presentation metadata. Correctness compares ordered
    # values so semantically identical SQL is not rejected for choosing a
    # different aggregate alias; projection order and every value still count.
    normalized_rows = [[normalize_value(value) for value in row] for row in rows]
    if not order_matters:
        normalized_rows.sort(key=lambda row: json.dumps(row, ensure_ascii=False, separators=(",", ":")))
    payload = {"rows": normalized_rows}
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def normalize_value(value: Any) -> Any:
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, float):
        return format(value, ".12g")
    return value


def generate_golden_receipt(suite: BenchmarkSuite, client: TrinoClient) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    for case in suite.cases:
        if case.expected_failure:
            results.append({"caseId": case.case_id, "expectedFailure": True})
            continue
        columns, rows, _ = execute_statement(client, case.reference_sql or "")
        results.append({
            "caseId": case.case_id,
            "rowCount": len(rows),
            "resultHash": canonical_result_hash(columns, rows, order_matters=case.result_order_matters),
        })
    return {
        "receiptVersion": "1",
        "suiteId": suite.suite_id,
        "suiteVersion": suite.suite_version,
        "suiteHash": suite.canonical_hash(),
        "fixtureVersion": suite.fixture_version,
        "results": results,
    }


def golden_mismatches(suite: BenchmarkSuite, receipt: dict[str, Any]) -> list[str]:
    actual = {str(item.get("caseId")): item for item in receipt.get("results", []) if isinstance(item, dict)}
    mismatches: list[str] = []
    for case in suite.cases:
        result = actual.get(case.case_id)
        if result is None:
            mismatches.append(f"{case.case_id}: missing result")
            continue
        if case.expected_failure:
            if result.get("expectedFailure") is not True:
                mismatches.append(f"{case.case_id}: expected failure marker")
            continue
        if result.get("rowCount") != case.golden.row_count:
            mismatches.append(f"{case.case_id}: row count drift")
        if result.get("resultHash") != case.golden.result_hash:
            mismatches.append(f"{case.case_id}: result hash drift")
    return mismatches
