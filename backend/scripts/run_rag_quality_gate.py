"""Run Dataset golden cases against the live RAG search API.

Example:
  python backend/scripts/run_rag_quality_gate.py --base-url http://localhost:8080 \
    --token "$ASKLAKE_TOKEN" --fixture backend/tests/fixtures/rag_golden.sample.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.services.rag_evaluation import DEFAULT_QUALITY_THRESHOLDS, run_golden_set


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--fixture", required=True, type=Path)
    parser.add_argument("--min-parent-recall", type=float, default=DEFAULT_QUALITY_THRESHOLDS["parentRecall"])
    parser.add_argument("--min-parent-mrr", type=float, default=DEFAULT_QUALITY_THRESHOLDS["parentMrr"])
    parser.add_argument("--min-parent-ndcg", type=float, default=DEFAULT_QUALITY_THRESHOLDS["parentNdcg"])
    parser.add_argument("--min-chunk-recall", type=float, default=DEFAULT_QUALITY_THRESHOLDS["chunkRecall"])
    parser.add_argument("--min-filter-precision", type=float, default=DEFAULT_QUALITY_THRESHOLDS["filterPrecision"])
    parser.add_argument("--max-duplicate-parent-rate", type=float, default=DEFAULT_QUALITY_THRESHOLDS["duplicateParentRate"])
    args = parser.parse_args()
    payload = json.loads(args.fixture.read_text(encoding="utf-8"))
    cases = payload.get("cases") if isinstance(payload, dict) else payload
    if not isinstance(cases, list) or not cases:
        raise SystemExit("Golden fixture must contain a non-empty cases list")

    def retrieve(case: dict) -> dict:
        dataset_id = str(case.get("datasetId") or "")
        if not dataset_id:
            raise ValueError("Every golden case requires datasetId")
        body = json.dumps({"query": case["query"], "filters": case.get("filters") or {}}).encode("utf-8")
        request = Request(f"{args.base_url.rstrip('/')}/api/catalog/datasets/{dataset_id}/rag/search", data=body, method="POST", headers={"Authorization": f"Bearer {args.token}", "Content-Type": "application/json"})
        with urlopen(request, timeout=120) as response:
            return json.loads(response.read().decode("utf-8"))

    thresholds = {"parentRecall": args.min_parent_recall, "parentMrr": args.min_parent_mrr, "parentNdcg": args.min_parent_ndcg, "chunkRecall": args.min_chunk_recall, "filterPrecision": args.min_filter_precision, "duplicateParentRate": args.max_duplicate_parent_rate}
    try:
        report = run_golden_set(cases, retrieve, thresholds)
    except Exception as exc:
        print(json.dumps({"gate": {"passed": False, "error": str(exc)}}, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
