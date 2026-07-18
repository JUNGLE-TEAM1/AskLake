#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.benchmarks.dataset import cleanup_dataset, load_dataset, load_dataset_manifest, render_dataset_sql
from app.core.config import Settings
from app.services.trino_client import TrinoClient


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Render or load the bounded Nessie SQL benchmark Dataset")
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--render-sql", action="store_true")
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--cleanup", action="store_true")
    parser.add_argument("--confirm", choices=["LOAD_BENCHMARK_DATASET", "CLEANUP_BENCHMARK_DATASET"])
    parser.add_argument("--replace", action="store_true")
    parser.add_argument("--receipt", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    manifest = load_dataset_manifest(args.manifest)
    if args.cleanup:
        if not args.live or args.confirm != "CLEANUP_BENCHMARK_DATASET":
            raise SystemExit("live cleanup requires --live --confirm CLEANUP_BENCHMARK_DATASET")
        receipt = cleanup_dataset(manifest, TrinoClient(Settings()))
        if args.receipt:
            if args.receipt.exists():
                raise SystemExit("cleanup receipt already exists")
            args.receipt.parent.mkdir(parents=True, exist_ok=True)
            args.receipt.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(receipt, indent=2))
        return
    if args.render_sql:
        print(";\n\n".join(render_dataset_sql(manifest, replace=args.replace)) + ";")
        return
    if not args.live:
        print(json.dumps({"mode": "preflight", "manifestHash": manifest.canonical_hash()}, indent=2))
        return
    if args.confirm != "LOAD_BENCHMARK_DATASET":
        raise SystemExit("live load requires --confirm LOAD_BENCHMARK_DATASET")
    if args.receipt is None:
        raise SystemExit("live load requires a private --receipt path")
    if args.receipt.exists():
        raise SystemExit("live receipt already exists")

    receipt = load_dataset(manifest, TrinoClient(Settings()), replace=args.replace)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"mode": "live", "receipt": str(args.receipt), "tables": len(receipt["tables"])}, indent=2))


if __name__ == "__main__":
    main()
