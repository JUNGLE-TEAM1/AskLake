#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
import time

import httpx

from app.benchmarks.suite import load_suite
from app.services.query_ai_service import QUERY_AI_GENERATOR_VERSION, QUERY_AI_PROMPT_VERSION


def main() -> None:
    parser = argparse.ArgumentParser(description="Collect private Query AI candidates through the public AskLake API")
    parser.add_argument("--suite", type=Path, required=True)
    parser.add_argument("--dataset-map", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:8080")
    parser.add_argument("--confirm", choices=["CALL_LIVE_QUERY_AI"])
    parser.add_argument("--timeout-seconds", type=float, default=60)
    args = parser.parse_args()
    if args.confirm != "CALL_LIVE_QUERY_AI":
        raise SystemExit("live Query AI collection requires --confirm CALL_LIVE_QUERY_AI")
    repository_root = Path(__file__).resolve().parents[2]
    if repository_root.resolve() in args.receipt.resolve().parents or repository_root.resolve() in args.dataset_map.resolve().parents:
        raise SystemExit("candidate receipt and Dataset map must stay outside the Git repository")
    if args.receipt.exists():
        raise SystemExit("candidate receipt already exists")

    suite = load_suite(args.suite)
    dataset_map = json.loads(args.dataset_map.read_text(encoding="utf-8"))
    candidates: list[dict[str, object]] = []
    with httpx.Client(base_url=args.base_url, timeout=args.timeout_seconds, headers={"X-AskLake-User": "Benchmark Admin", "X-AskLake-Role": "admin"}) as client:
        for case in suite.cases:
            dataset_ids = [str(dataset_map[name]) for name in case.allowed_datasets]
            started = time.monotonic()
            response = client.post("/api/query/ai-suggestions", json={
                "mode": "draft_sql",
                "prompt": case.question,
                "baseDatasetId": dataset_ids[0],
                "selectedDatasetIds": dataset_ids,
            })
            latency_ms = int((time.monotonic() - started) * 1000)
            if response.status_code >= 400:
                candidates.append({
                    "caseId": case.case_id,
                    "rejected": True,
                    "reason": f"query_ai_http_{response.status_code}",
                    "generationLatencyMs": latency_ms,
                })
                continue
            payload = response.json()
            candidates.append({
                "caseId": case.case_id,
                "sql": payload["sql"],
                "requestId": payload["requestId"],
                "generationLatencyMs": latency_ms,
                "regenerationCount": int(payload.get("regenerationCount") or 0),
                "generatorVersion": str(payload.get("generatorVersion") or QUERY_AI_GENERATOR_VERSION),
                "promptVersion": str(payload.get("promptVersion") or QUERY_AI_PROMPT_VERSION),
                "model": payload["model"],
                "provider": payload["provider"],
                "semanticContextVersion": "semantic-rag-current",
            })
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    with args.receipt.open("x", encoding="utf-8") as handle:
        json.dump({
            "receiptVersion": "1",
            "suiteVersion": suite.suite_version,
            "datasetAliases": {str(dataset_id): str(name) for name, dataset_id in dataset_map.items()},
            "candidates": candidates,
        }, handle, indent=2)
        handle.write("\n")
    print(json.dumps({
        "receipt": str(args.receipt),
        "cases": len(candidates),
        "generated": sum(1 for item in candidates if not item.get("rejected")),
        "rejected": sum(1 for item in candidates if item.get("rejected")),
    }, indent=2))


if __name__ == "__main__":
    main()
