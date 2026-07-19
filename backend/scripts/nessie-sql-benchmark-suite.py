#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.benchmarks.suite import generate_golden_receipt, golden_mismatches, load_suite
from app.core.config import Settings
from app.services.trino_client import TrinoClient


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate a Nessie SQL benchmark suite and optionally generate golden results")
    parser.add_argument("--suite", type=Path, required=True)
    parser.add_argument("--live-golden", action="store_true")
    parser.add_argument("--confirm", choices=["GENERATE_GOLDEN_RESULTS"])
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()

    suite = load_suite(args.suite)
    if not args.live_golden:
        print(json.dumps({"mode": "validate", "cases": len(suite.cases), "suiteHash": suite.canonical_hash()}, indent=2))
        return
    if args.confirm != "GENERATE_GOLDEN_RESULTS" or args.receipt is None:
        raise SystemExit("live golden generation requires --confirm GENERATE_GOLDEN_RESULTS and --receipt")
    receipt = generate_golden_receipt(suite, TrinoClient(Settings()))
    mismatches = golden_mismatches(suite, receipt)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"mode": "live-golden", "receipt": str(args.receipt), "cases": len(suite.cases), "mismatches": mismatches}, indent=2))
    if mismatches:
        raise SystemExit("golden result drift detected")


if __name__ == "__main__":
    main()
