#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.benchmarks.run import BenchmarkRunService, SqlAlchemyBenchmarkRunRepository
from app.benchmarks.runner import (
    BenchmarkRunner,
    ReceiptCandidateSource,
    ReferenceCandidateSource,
    RunnerConfig,
    campaign_lock,
    ensure_private_receipt_dir,
    write_receipt_once,
)
from app.benchmarks.suite import load_suite
from app.core.config import Settings
from app.models.benchmark import BenchmarkRunModel
from app.services.trino_client import TrinoClient


def main() -> None:
    parser = argparse.ArgumentParser(description="Run a bounded Nessie SQL benchmark campaign")
    parser.add_argument("--suite", type=Path, required=True)
    parser.add_argument("--dataset-evidence", type=Path, required=True)
    parser.add_argument("--receipt-dir", type=Path, required=True)
    parser.add_argument("--campaign-id", required=True)
    parser.add_argument("--role", choices=["baseline", "candidate"], required=True)
    parser.add_argument("--mode", choices=["preflight", "live"], default="preflight")
    parser.add_argument("--confirm", choices=["RUN_BOUNDED_BENCHMARK"])
    parser.add_argument("--source", choices=["reference", "provider-receipt"], default="reference")
    parser.add_argument("--candidate-receipt", type=Path)
    parser.add_argument("--cache-mode", choices=["cold", "warm"], default="warm")
    parser.add_argument("--repetitions", type=int, default=1)
    parser.add_argument("--attempt", type=int, default=0)
    parser.add_argument("--timeout-seconds", type=float, default=30)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    if args.mode == "live" and args.confirm != "RUN_BOUNDED_BENCHMARK":
        raise SystemExit("live campaign requires --confirm RUN_BOUNDED_BENCHMARK")
    if not 1 <= args.repetitions <= 30:
        raise SystemExit("repetitions must be between 1 and 30")
    if not 1 <= args.timeout_seconds <= 600:
        raise SystemExit("timeout must be between 1 and 600 seconds")

    repository_root = Path(__file__).resolve().parents[2]
    ensure_private_receipt_dir(args.receipt_dir, repository_root)
    source = ReferenceCandidateSource()
    if args.source == "provider-receipt":
        if args.candidate_receipt is None:
            raise SystemExit("provider-receipt source requires --candidate-receipt")
        source = ReceiptCandidateSource(args.candidate_receipt)

    engine = create_engine(f"sqlite+pysqlite:///{args.receipt_dir / 'benchmark-runs.sqlite3'}")
    BenchmarkRunModel.__table__.create(engine, checkfirst=True)
    suite = load_suite(args.suite)
    evidence = json.loads(args.dataset_evidence.read_text(encoding="utf-8"))
    receipts: list[dict[str, object]] = []
    with campaign_lock(args.receipt_dir, args.campaign_id), Session(engine) as db:
        runner = BenchmarkRunner(
            suite=suite,
            dataset_evidence=evidence,
            source=source,
            run_service=BenchmarkRunService(SqlAlchemyBenchmarkRunRepository(db)),
            trino=TrinoClient(Settings()),
        )
        runner.preflight_snapshot()
        for repetition in range(args.repetitions):
            for case in suite.cases:
                receipt_path = args.receipt_dir / f"{args.campaign_id}-{case.case_id}-{args.cache_mode}-{repetition}-a{args.attempt}.json"
                if receipt_path.exists() and args.resume:
                    receipts.append(json.loads(receipt_path.read_text(encoding="utf-8")))
                    continue
                if receipt_path.exists():
                    raise RuntimeError(f"receipt already exists: {receipt_path.name}; use --resume or a new --attempt")
                receipt = runner.run_case(case, RunnerConfig(
                    campaign_id=args.campaign_id,
                    candidate_role=args.role,
                    cache_mode=args.cache_mode,
                    repetition_index=repetition,
                    attempt_index=args.attempt,
                    runtime_profile=str(evidence["runtimeProfile"]),
                    timeout_seconds=args.timeout_seconds,
                    mode=args.mode,
                ))
                write_receipt_once(receipt_path, receipt)
                receipts.append(receipt)
    print(json.dumps({
        "campaignId": args.campaign_id,
        "mode": args.mode,
        "source": args.source,
        "receipts": len(receipts),
        "statuses": {status: sum(1 for receipt in receipts if receipt["status"] == status) for status in sorted({str(item["status"]) for item in receipts})},
    }, indent=2))


if __name__ == "__main__":
    main()
