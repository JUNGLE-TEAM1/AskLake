from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import time
from typing import Any, Iterator, Literal, Protocol

from sqlglot import exp, parse_one

from app.benchmarks.dataset import execute_statement
from app.benchmarks.run import BenchmarkExecutionStats, BenchmarkRunService
from app.benchmarks.suite import BenchmarkCase, BenchmarkSuite, canonical_result_hash
from app.services.sql_service import validate_read_only_query
from app.services.trino_client import TrinoClient


class CandidateRejected(RuntimeError):
    pass


@dataclass(frozen=True)
class SqlCandidate:
    sql: str
    request_id: str
    generation_latency_ms: int
    regeneration_count: int
    generator_version: str
    prompt_version: str
    model: str
    provider: str
    semantic_context_version: str
    source_sql_hash: str | None = None


class CandidateSource(Protocol):
    def generate(self, case: BenchmarkCase) -> SqlCandidate: ...


class ReferenceCandidateSource:
    """Deterministic CI source; never represents a live Nessie provider campaign."""

    def generate(self, case: BenchmarkCase) -> SqlCandidate:
        if case.expected_failure:
            raise CandidateRejected("fixture expected rejection")
        return SqlCandidate(
            sql=case.reference_sql or "",
            request_id=f"fixture-{case.case_id}",
            generation_latency_ms=0,
            regeneration_count=0,
            generator_version="reference-sql-v1",
            prompt_version="fixture-question-v1",
            model="deterministic-reference",
            provider="fixture",
            semantic_context_version="fixture-context-v1",
            source_sql_hash=None,
        )


class ReceiptCandidateSource:
    """Read private, provider-produced candidates without tracking SQL in Git."""

    def __init__(self, path: Path) -> None:
        payload = json.loads(path.read_text(encoding="utf-8"))
        self.aliases = {str(key): str(value) for key, value in payload.get("datasetAliases", {}).items()}
        self.candidates = {str(item["caseId"]): item for item in payload.get("candidates", [])}

    def generate(self, case: BenchmarkCase) -> SqlCandidate:
        item = self.candidates.get(case.case_id)
        if item is None:
            raise CandidateRejected("provider receipt has no candidate for case")
        if item.get("rejected") is True:
            raise CandidateRejected(str(item.get("reason") or "provider rejected case"))
        source_sql = str(item["sql"])
        return SqlCandidate(
            sql=normalize_candidate_tables(source_sql, self.aliases),
            request_id=str(item["requestId"]),
            generation_latency_ms=int(item.get("generationLatencyMs") or 0),
            regeneration_count=int(item.get("regenerationCount") or 0),
            generator_version=str(item["generatorVersion"]),
            prompt_version=str(item["promptVersion"]),
            model=str(item["model"]),
            provider=str(item["provider"]),
            semantic_context_version=str(item["semanticContextVersion"]),
            source_sql_hash=hashlib.sha256(source_sql.encode()).hexdigest(),
        )


@dataclass(frozen=True)
class RunnerConfig:
    campaign_id: str
    candidate_role: Literal["baseline", "candidate"]
    cache_mode: Literal["cold", "warm"]
    repetition_index: int
    attempt_index: int
    runtime_profile: str
    timeout_seconds: float
    mode: Literal["preflight", "live"]


class BenchmarkRunner:
    def __init__(
        self,
        *,
        suite: BenchmarkSuite,
        dataset_evidence: dict[str, Any],
        source: CandidateSource,
        run_service: BenchmarkRunService,
        trino: TrinoClient,
    ) -> None:
        self.suite = suite
        self.dataset_evidence = dataset_evidence
        self.source = source
        self.run_service = run_service
        self.trino = trino

    def preflight_snapshot(self) -> str:
        expected = {str(table["name"]): str(table["snapshotId"]) for table in self.dataset_evidence["tables"]}
        observed: dict[str, str] = {}
        schema = str(self.dataset_evidence["schema"])
        catalog = str(self.dataset_evidence["catalog"])
        for table, snapshot_id in expected.items():
            columns, rows, _ = execute_statement(
                self.trino,
                f'''SELECT CAST(snapshot_id AS VARCHAR) AS snapshot_id FROM "{catalog}"."{schema}"."{table}$refs" WHERE name = 'main' LIMIT 1''',
            )
            if columns != ["snapshot_id"] or len(rows) != 1:
                raise RuntimeError(f"could not resolve fixture snapshot: {table}")
            observed[table] = str(rows[0][0])
            if observed[table] != snapshot_id:
                raise RuntimeError(f"dataset snapshot drift: {table}")
        return hashlib.sha256(json.dumps(observed, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

    def run_case(self, case: BenchmarkCase, config: RunnerConfig) -> dict[str, Any]:
        snapshot_hash = self.preflight_snapshot()
        started = time.monotonic()
        candidate: SqlCandidate | None = None
        try:
            candidate = self.source.generate(case)
        except CandidateRejected as exc:
            correctness = "passed" if case.expected_failure else "failed"
            record, _ = self.run_service.start(**self._record_inputs(
                case, config, snapshot_hash, candidate=None,
                validation_result={"accepted": False, "reason": str(exc)},
            ))
            terminal = self.run_service.finish(
                record.run_id,
                status="rejected",
                correctness=correctness,
                failure_reason=None if case.expected_failure else "generation_rejected",
            )
            return public_receipt(terminal, generation_latency_ms=int((time.monotonic() - started) * 1000))

        validation = validate_candidate(case, candidate.sql)
        record, _ = self.run_service.start(**self._record_inputs(
            case, config, snapshot_hash, candidate=candidate, validation_result=validation,
        ))
        if record.status != "running":
            return public_receipt(record, generation_latency_ms=candidate.generation_latency_ms)
        if not validation["accepted"]:
            terminal = self.run_service.finish(
                record.run_id,
                status="failed",
                correctness="failed",
                failure_reason="generation_validation_failed",
            )
            return public_receipt(terminal, generation_latency_ms=candidate.generation_latency_ms)
        if config.mode == "preflight":
            terminal = self.run_service.finish(record.run_id, status="cancelled", correctness="pending", failure_reason="preflight_only")
            return public_receipt(terminal, generation_latency_ms=candidate.generation_latency_ms)

        estimate_bytes = self._upper_bound_bytes(case)
        try:
            columns, rows, stats, query_id, wall_ms = execute_bounded(
                self.trino,
                compile_physical_sql(candidate.sql, case, self.dataset_evidence),
                timeout_seconds=config.timeout_seconds,
            )
            result_hash = canonical_result_hash(columns, rows, order_matters=case.result_order_matters)
            result_matches = len(rows) == case.golden.row_count and result_hash == case.golden.result_hash
            if (
                case.approximate_allowed
                and case.golden.numeric_value is not None
                and len(rows) == 1
                and len(rows[0]) == 1
                and isinstance(rows[0][0], (int, float))
            ):
                expected = float(case.golden.numeric_value)
                result_matches = abs(float(rows[0][0]) - expected) / max(1.0, abs(expected)) <= float(case.golden.numeric_tolerance or 0)
            correctness = "passed" if result_matches else "failed"
            terminal = self.run_service.finish(
                record.run_id,
                status="succeeded" if correctness == "passed" else "failed",
                correctness=correctness,
                failure_reason=None if correctness == "passed" else "golden_result_mismatch",
                estimated_bytes=estimate_bytes,
                estimate_source="fixture_file_upper_bound",
                query_run_id=query_id,
                execution_stats=stats.model_copy(update={"wall_ms": wall_ms, "result_row_count": len(rows)}),
            )
        except TimeoutError:
            terminal = self.run_service.finish(
                record.run_id,
                status="timed_out",
                correctness="failed",
                failure_reason="execution_timeout",
                estimated_bytes=estimate_bytes,
                estimate_source="fixture_file_upper_bound",
            )
        except Exception as exc:
            terminal = self.run_service.finish(
                record.run_id,
                status="failed",
                correctness="failed",
                failure_reason=f"execution_failed:{type(exc).__name__}",
                estimated_bytes=estimate_bytes,
                estimate_source="fixture_file_upper_bound",
            )
        return public_receipt(terminal, generation_latency_ms=candidate.generation_latency_ms)

    def _record_inputs(
        self,
        case: BenchmarkCase,
        config: RunnerConfig,
        snapshot_hash: str,
        *,
        candidate: SqlCandidate | None,
        validation_result: dict[str, Any],
    ) -> dict[str, Any]:
        candidate = candidate or SqlCandidate("", "", 0, 0, "unknown", "unknown", "unknown", "unknown", "unknown")
        return {
            "idempotency_key": ":".join((config.campaign_id, case.case_id, config.cache_mode, str(config.repetition_index), str(config.attempt_index))),
            "benchmark_suite": self.suite.suite_id,
            "suite_version": self.suite.suite_version,
            "campaign_id": config.campaign_id,
            "case_id": case.case_id,
            "candidate_role": config.candidate_role,
            "fixture_version": self.suite.fixture_version,
            "dataset_snapshot_hash": snapshot_hash,
            "schema_fingerprint": str(self.dataset_evidence["manifestHash"]),
            "partition_version": "month-order-date-v1",
            "generator_version": candidate.generator_version,
            "prompt_version": candidate.prompt_version,
            "model": candidate.model,
            "provider": candidate.provider,
            "semantic_context_version": candidate.semantic_context_version,
            "request_id": candidate.request_id or None,
            "sanitized_sql_hash": candidate.source_sql_hash or (hashlib.sha256(candidate.sql.encode()).hexdigest() if candidate.sql else None),
            "private_sql_reference": None,
            "validation_result": validation_result,
            "runtime_profile": config.runtime_profile,
            "cache_mode": config.cache_mode,
            "repetition_index": config.repetition_index,
            "regeneration_count": candidate.regeneration_count,
        }

    def _upper_bound_bytes(self, case: BenchmarkCase) -> int:
        sizes = {str(table["name"]): int(table["storageBytes"]) for table in self.dataset_evidence["tables"]}
        return sum(sizes[name] for name in case.allowed_datasets)


def validate_candidate(case: BenchmarkCase, sql: str) -> dict[str, Any]:
    violations: list[str] = []
    try:
        statement_sql = validate_read_only_query(sql)
        statement = parse_one(statement_sql, read="trino")
    except Exception as exc:
        return {"accepted": False, "violations": [f"invalid_read_only_sql:{type(exc).__name__}"]}
    tables = {table.name for table in statement.find_all(exp.Table)}
    unknown = sorted(tables - set(case.allowed_datasets))
    if unknown:
        violations.append("out_of_scope_tables:" + ",".join(unknown))
    for pattern in case.forbidden_patterns:
        if re.search(re.escape(pattern), sql, flags=re.IGNORECASE):
            violations.append("forbidden_pattern:" + pattern)
    return {"accepted": not violations, "violations": violations, "referencedTables": sorted(tables)}


def normalize_candidate_tables(sql: str, aliases: dict[str, str]) -> str:
    if not aliases:
        return sql
    statement = parse_one(sql, read="trino")
    for table in statement.find_all(exp.Table):
        logical_name = aliases.get(table.name)
        if logical_name and not table.db and not table.catalog:
            table.set("this", exp.to_identifier(logical_name))
    return statement.sql(dialect="trino")


def compile_physical_sql(sql: str, case: BenchmarkCase, evidence: dict[str, Any]) -> str:
    statement = parse_one(sql, read="trino")
    allowed = set(case.allowed_datasets)
    catalog = str(evidence["catalog"])
    schema = str(evidence["schema"])
    for table in statement.find_all(exp.Table):
        if table.name not in allowed or table.db or table.catalog:
            continue
        table.set("this", exp.to_identifier(table.name, quoted=True))
        table.set("db", exp.to_identifier(schema, quoted=True))
        table.set("catalog", exp.to_identifier(catalog, quoted=True))
    return statement.sql(dialect="trino")


def execute_bounded(
    client: TrinoClient,
    sql: str,
    *,
    timeout_seconds: float,
) -> tuple[list[str], list[list[Any]], BenchmarkExecutionStats, str, int]:
    started = time.monotonic()
    page = client.submit(sql, timeout_seconds=min(timeout_seconds, 30))
    query_id = page.query_id
    columns = list(page.columns)
    rows = list(page.rows)
    raw_stats = dict(page.raw_stats)
    while page.next_uri:
        if time.monotonic() - started >= timeout_seconds:
            client.cancel(page.next_uri, timeout_seconds=5)
            raise TimeoutError("benchmark case timed out")
        page = client.fetch(page.next_uri, timeout_seconds=min(timeout_seconds, 30))
        if page.error:
            raise RuntimeError(f"Trino query failed [{page.error.code}]")
        if page.columns:
            columns = list(page.columns)
        rows.extend(page.rows)
        raw_stats.update(page.raw_stats)
    if page.error:
        raise RuntimeError(f"Trino query failed [{page.error.code}]")
    try:
        info = client.query_info(query_id)
        raw_stats.update(info.raw_stats)
    except Exception:
        pass
    wall_ms = int((time.monotonic() - started) * 1000)
    return columns, rows, stats_from_trino(raw_stats), query_id, wall_ms


def stats_from_trino(raw: dict[str, Any]) -> BenchmarkExecutionStats:
    def number(*names: str) -> int | None:
        for name in names:
            value = raw.get(name)
            if isinstance(value, (int, float)):
                return max(0, int(value))
        return None
    return BenchmarkExecutionStats(
        processed_bytes=number("processedBytes", "physicalInputDataSizeBytes"),
        processed_rows=number("processedRows", "physicalInputPositions"),
        elapsed_ms=number("elapsedTimeMillis"),
        queued_ms=number("queuedTimeMillis"),
        cpu_ms=number("cpuTimeMillis", "totalCpuTimeMillis"),
        peak_memory_bytes=number("peakMemoryBytes", "peakUserMemoryBytes"),
        spilled_bytes=number("spilledBytes"),
        file_count=None,
        partition_count=None,
        query_state=str(raw.get("state") or "").upper() or None,
    )


def public_receipt(record: Any, *, generation_latency_ms: int) -> dict[str, Any]:
    payload = record.model_dump(mode="json")
    payload.pop("private_sql_reference", None)
    payload["generationLatencyMs"] = generation_latency_ms
    return payload


def ensure_private_receipt_dir(path: Path, repository_root: Path) -> None:
    resolved = path.resolve()
    root = repository_root.resolve()
    if resolved == root or root in resolved.parents:
        raise ValueError("benchmark receipts must be outside the Git repository")
    resolved.mkdir(parents=True, exist_ok=True)


def write_receipt_once(path: Path, payload: dict[str, Any]) -> None:
    with path.open("x", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")


@contextmanager
def campaign_lock(receipt_dir: Path, campaign_id: str) -> Iterator[None]:
    lock_path = receipt_dir / ".active-campaign.lock"
    descriptor: int | None = None
    old_handlers: dict[int, Any] = {}
    try:
        descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.write(descriptor, campaign_id.encode("utf-8"))

        def stop(_signum: int, _frame: Any) -> None:
            raise KeyboardInterrupt("benchmark interrupted")

        for signum in (signal.SIGINT, signal.SIGTERM):
            old_handlers[signum] = signal.signal(signum, stop)
        yield
    except FileExistsError as exc:
        raise RuntimeError("another benchmark campaign is active") from exc
    finally:
        for signum, handler in old_handlers.items():
            signal.signal(signum, handler)
        if descriptor is not None:
            os.close(descriptor)
            lock_path.unlink(missing_ok=True)
