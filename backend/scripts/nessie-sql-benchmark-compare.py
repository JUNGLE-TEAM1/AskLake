#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.benchmarks.comparison import compare_campaigns, load_policy, render_markdown
from app.benchmarks.suite import load_suite


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare compatible Nessie SQL benchmark summaries")
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--suite", type=Path, required=True)
    parser.add_argument("--policy", type=Path, required=True)
    parser.add_argument("--json-output", type=Path)
    parser.add_argument("--markdown-output", type=Path)
    args = parser.parse_args()
    report = compare_campaigns(
        json.loads(args.baseline.read_text(encoding="utf-8")),
        json.loads(args.candidate.read_text(encoding="utf-8")),
        load_suite(args.suite),
        load_policy(args.policy),
    )
    if args.json_output:
        if args.json_output.exists():
            raise SystemExit(f"refusing to overwrite comparison artifact: {args.json_output}")
        args.json_output.parent.mkdir(parents=True, exist_ok=True)
        args.json_output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    if args.markdown_output:
        if args.markdown_output.exists():
            raise SystemExit(f"refusing to overwrite comparison artifact: {args.markdown_output}")
        args.markdown_output.parent.mkdir(parents=True, exist_ok=True)
        args.markdown_output.write_text(render_markdown(report), encoding="utf-8")
    print(json.dumps({"comparable": report["comparable"], "gate": report["gate"], "failures": report.get("failures", report.get("reasons", []))}, indent=2))
    if report["gate"] != "pass":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
