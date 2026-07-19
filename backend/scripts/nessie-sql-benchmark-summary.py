#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.benchmarks.summary import summarize_receipts


def main() -> None:
    parser = argparse.ArgumentParser(description="Summarize private benchmark receipts without raw rows or SQL")
    parser.add_argument("--receipt-dir", type=Path, required=True)
    parser.add_argument("--campaign-id", required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    summary = summarize_receipts(args.receipt_dir, args.campaign_id)
    rendered = json.dumps(summary, indent=2) + "\n"
    if args.output:
        if args.output.exists():
            raise SystemExit("summary output already exists")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")


if __name__ == "__main__":
    main()
