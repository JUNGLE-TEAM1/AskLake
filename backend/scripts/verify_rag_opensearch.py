"""Read-only OpenSearch preflight for a built RAG index.

This checks the same physical contracts required before alias activation without
touching the index or alias.  It is intended for deployment smoke verification.
"""

from __future__ import annotations

import argparse
import json
from typing import Any

import httpx


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--index", required=True)
    parser.add_argument("--dimensions", required=True, type=int)
    parser.add_argument("--username")
    parser.add_argument("--password")
    parser.add_argument("--insecure", action="store_true")
    args = parser.parse_args()
    auth = (args.username, args.password or "") if args.username else None
    base = args.base_url.rstrip("/")
    report: dict[str, Any] = {"index": args.index, "checks": {}}

    with httpx.Client(timeout=30, verify=not args.insecure, auth=auth) as client:
        count_response = client.post(f"{base}/{args.index}/_count", json={"query": {"match_all": {}}})
        count_response.raise_for_status()
        count = int(count_response.json().get("count") or 0)
        report["checks"]["count"] = {"passed": count >= 0, "value": count}

        mapping_response = client.get(f"{base}/{args.index}/_mapping")
        mapping_response.raise_for_status()
        payload = mapping_response.json()
        root = payload.get(args.index) or next(iter(payload.values()))
        properties = ((root.get("mappings") or {}).get("properties") or {}) if isinstance(root, dict) else {}
        required = {"document_id", "parent_document_id", "body", "embedding_text", "body_vector", "metadata_filter", "chunk_index", "chunk_count", "char_start", "char_end", "embedding_model", "embedding_dimensions", "source_fields", "parent_source_fields", "embedding_input_version", "field_rendering_version"}
        missing = sorted(required - set(properties))
        dimension = int((properties.get("body_vector") or {}).get("dimension") or 0)
        report["checks"]["mapping"] = {"passed": not missing and dimension == args.dimensions, "missing": missing, "dimension": dimension}

        sample_response = client.post(f"{base}/{args.index}/_search", json={"size": 1, "_source": ["body_vector", "metadata_filter"], "query": {"match_all": {}}})
        sample_response.raise_for_status()
        hits = sample_response.json().get("hits", {}).get("hits", [])
        if count and not hits:
            report["checks"]["sample"] = {"passed": False, "reason": "index has documents but sample query returned none"}
        elif not hits:
            report["checks"]["sample"] = {"passed": True, "reason": "empty index"}
        else:
            source = hits[0].get("_source") or {}
            vector = source.get("body_vector")
            vector_response = client.post(f"{base}/{args.index}/_search", json={"size": 1, "query": {"knn": {"body_vector": {"vector": vector, "k": 1}}}})
            vector_response.raise_for_status()
            report["checks"]["knn"] = {"passed": bool(vector_response.json().get("hits", {}).get("hits")), "resultCount": len(vector_response.json().get("hits", {}).get("hits", []))}
            metadata = source.get("metadata_filter") or {}
            if metadata:
                field, typed = next(iter(metadata.items()))
                typed_field = next((candidate for candidate in ("keyword", "number", "date", "boolean") if candidate in typed), next(iter(typed)))
                filter_response = client.post(f"{base}/{args.index}/_search", json={"size": 1, "query": {"term": {f"metadata_filter.{field}.{typed_field}": typed[typed_field]}}})
                filter_response.raise_for_status()
                report["checks"]["metadataFilter"] = {"passed": bool(filter_response.json().get("hits", {}).get("hits"))}

    passed = all(bool(item.get("passed")) for item in report["checks"].values())
    report["passed"] = passed
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
