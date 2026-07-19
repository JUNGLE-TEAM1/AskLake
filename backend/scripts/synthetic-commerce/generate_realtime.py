#!/usr/bin/env python3
"""Generate a deterministic, bounded five-minute commerce Kafka fixture."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from itertools import zip_longest
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote_plus


PROFILE_VERSION = 1
WINDOW_MINUTES = 5
MINIMUM_CLICKS_PER_CATEGORY = 500
MINIMUM_PURCHASE_CLICKS_PER_CATEGORY = 25
FIELD_NAMES = (
    "event_time",
    "event_id",
    "user_id",
    "session_id",
    "event_type",
    "product_id",
    "page_url",
    "device_type",
    "referrer",
    "position",
)


def encode_json(row: Any, *, indent: int | None = None) -> bytes:
    separators = None if indent is not None else (",", ":")
    return (
        json.dumps(row, ensure_ascii=False, indent=indent, separators=separators) + "\n"
    ).encode("utf-8")


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate_run_id(run_id: str) -> None:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}", run_id):
        raise ValueError("run-id must be a safe 1-80 character identifier")


def parse_anchor(value: str) -> datetime:
    anchor = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if anchor.tzinfo is None or anchor.utcoffset() is None:
        raise ValueError("anchor-at must include an explicit UTC offset")
    return anchor


def manifest_paths(baseline_dir: Path, dataset: dict[str, Any]) -> Iterable[Path]:
    for item in dataset.get("files", []):
        path = (baseline_dir / item["path"]).resolve()
        if baseline_dir.resolve() not in path.parents:
            raise ValueError(f"baseline manifest path escapes its run directory: {item['path']}")
        yield path


def jsonl_rows(paths: Iterable[Path]) -> Iterable[dict[str, Any]]:
    for path in paths:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    yield json.loads(line)


def load_baseline(baseline_dir: Path, window_start: datetime) -> dict[str, Any]:
    baseline_dir = baseline_dir.resolve()
    manifest_path = baseline_dir / "manifest.json"
    analysis_path = baseline_dir / "analysis-result.json"
    if not manifest_path.is_file() or not analysis_path.is_file():
        raise ValueError("baseline-dir must contain manifest.json and analysis-result.json")

    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    if manifest.get("generator_version", 0) < 3 or "behavior_profile" not in manifest:
        raise ValueError("a validated synthetic-commerce v3 baseline is required")
    analysis_bytes = analysis_path.read_bytes()
    analysis = json.loads(analysis_bytes)
    if not analysis.get("all_integrity_passed") or not analysis.get("all_planted_patterns_passed"):
        raise ValueError("baseline analysis must pass integrity and planted-pattern checks")

    if not {"meta", "users", "click_events"}.issubset(manifest.get("datasets", {})):
        raise ValueError("baseline manifest must include meta, users, and click_events datasets")
    for dataset in manifest["datasets"].values():
        for item, path in zip(dataset.get("files", []), manifest_paths(baseline_dir, dataset)):
            if (
                not path.is_file()
                or path.stat().st_size != item.get("bytes")
                or sha256_file(path) != item.get("sha256")
            ):
                raise ValueError(f"baseline file evidence mismatch: {item.get('path')}")
            with path.open("rb") as handle:
                rows = sum(1 for line in handle if line.strip())
            if rows != item.get("rows"):
                raise ValueError(f"baseline file row evidence mismatch: {item.get('path')}")

    products = list(jsonl_rows(manifest_paths(baseline_dir, manifest["datasets"]["meta"])))
    users = [
        row
        for row in jsonl_rows(manifest_paths(baseline_dir, manifest["datasets"]["users"]))
        if datetime.fromisoformat(row["signup_at"]) < window_start
    ]
    if not products or not users:
        raise ValueError("baseline must provide products and users eligible for the realtime window")

    products_by_category: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for product in products:
        products_by_category[product["category"]].append(product)
    for items in products_by_category.values():
        items.sort(key=lambda item: item["product_id"])

    metrics = {row["category"]: row for row in analysis.get("category_metrics", [])}
    categories = manifest["behavior_profile"]["category_purchase_intent"]["categories"]
    if set(metrics) != set(categories) or set(products_by_category) != set(categories):
        raise ValueError("baseline category metrics, profile, and products must cover the same categories")

    users.sort(key=lambda item: item["user_id"])
    return {
        "manifest": manifest,
        "manifest_sha256": sha256_bytes(manifest_bytes),
        "analysis_result_sha256": sha256_bytes(analysis_bytes),
        "products_by_category": products_by_category,
        "users": users,
        "metrics": metrics,
    }


def target_rate(baseline_rate: float, state: str) -> float:
    if state == "up":
        return min(18.0, baseline_rate + 4.0)
    if state == "steady":
        return baseline_rate
    if state == "down":
        return max(2.5, baseline_rate - 2.5)
    raise ValueError(f"unsupported realtime state: {state}")


def state_for_group(group: str) -> str:
    return {"high": "up", "medium": "steady", "low": "down"}[group]


def raw_line(raw: dict[str, Any]) -> bytes:
    return (" ".join(str(raw[field]) for field in FIELD_NAMES) + "\n").encode("utf-8")


def file_evidence(path: Path, rows: int) -> dict[str, Any]:
    return {
        "path": path.name,
        "rows": rows,
        "bytes": path.stat().st_size,
        "sha256": sha256_file(path),
    }


def evaluate_thresholds(category_metrics: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "name": "minimum samples per category",
            "passed": all(
                row["clicks"] >= MINIMUM_CLICKS_PER_CATEGORY
                and row["purchase_clicks"] >= MINIMUM_PURCHASE_CLICKS_PER_CATEGORY
                for row in category_metrics
            ),
        },
        {
            "name": "at least one category is 3pp above baseline",
            "passed": any(row["delta_pp"] >= 3.0 for row in category_metrics),
        },
        {
            "name": "at least one category stays within 1pp of baseline",
            "passed": any(abs(row["delta_pp"]) <= 1.0 for row in category_metrics),
        },
        {
            "name": "at least one category is below baseline",
            "passed": any(row["delta_pp"] < 0.0 for row in category_metrics),
        },
    ]


def _plan_categories(
    baseline: dict[str, Any], clicks_per_category: int
) -> list[dict[str, Any]]:
    category_profile = baseline["manifest"]["behavior_profile"]["category_purchase_intent"]["categories"]
    planned = []
    for category, profile in category_profile.items():
        baseline_rate = float(baseline["metrics"][category]["click_to_purchase_pct"])
        state = state_for_group(profile["group"])
        desired_rate = target_rate(baseline_rate, state)
        purchases = max(
            MINIMUM_PURCHASE_CLICKS_PER_CATEGORY,
            round(clicks_per_category * desired_rate / 100.0),
        )
        carts = max(purchases, round(clicks_per_category * 0.22))
        observed_rate = 100.0 * purchases / clicks_per_category
        planned.append(
            {
                "category": category,
                "state": state,
                "baseline_click_to_purchase_pct": baseline_rate,
                "target_click_to_purchase_pct": round(desired_rate, 4),
                "impressions": clicks_per_category * 3,
                "clicks": clicks_per_category,
                "carts": carts,
                "purchase_clicks": purchases,
                "click_to_purchase_pct": round(observed_rate, 4),
                "delta_pp": round(observed_rate - baseline_rate, 4),
            }
        )
    return planned


def _realtime_identity(
    baseline: dict[str, Any], seed: int, run_id: str, anchor: datetime
) -> str:
    return hashlib.sha256(
        (
            f"{PROFILE_VERSION}:{baseline['manifest_sha256']}:{baseline['analysis_result_sha256']}:"
            f"{seed}:{run_id}:{anchor.isoformat()}"
        ).encode("utf-8")
    ).hexdigest()[:12]


def _write_realtime_events(
    *,
    baseline: dict[str, Any],
    planned: list[dict[str, Any]],
    run_dir: Path,
    identity: str,
    run_id: str,
    seed: int,
    window_start: datetime,
) -> tuple[int, dict[str, Counter[str]]]:
    log_path = run_dir / "click-events.log"
    kafka_path = run_dir / "click-events.kafka.jsonl"
    total_events = sum(
        row["impressions"] + row["clicks"] + row["carts"] + row["purchase_clicks"]
        for row in planned
    )
    window_microseconds = WINDOW_MINUTES * 60 * 1_000_000
    event_index = 0
    session_index = 0
    observed_counts: dict[str, Counter[str]] = defaultdict(Counter)

    with log_path.open("wb") as log_file, kafka_path.open("wb") as kafka_file:
        for row in planned:
            products = baseline["products_by_category"][row["category"]]
            for click_index in range(row["clicks"]):
                session_index += 1
                user = baseline["users"][(seed + session_index * 17) % len(baseline["users"])]
                product = products[(seed + click_index * 31) % len(products)]
                session_id = f"RTS-{identity}-{session_index:06d}"
                device = user["primary_device"]

                def emit(event_type: str, page_url: str, position: int) -> None:
                    nonlocal event_index
                    event_index += 1
                    event_time = window_start + timedelta(
                        microseconds=(event_index * window_microseconds) // (total_events + 1)
                    )
                    raw = {
                        "event_time": event_time.isoformat(timespec="microseconds"),
                        "event_id": f"RTE-{identity}-{event_index:08d}",
                        "user_id": user["user_id"],
                        "session_id": session_id,
                        "event_type": event_type,
                        "product_id": product["product_id"],
                        "page_url": page_url,
                        "device_type": device,
                        "referrer": "realtime_demo",
                        "position": position,
                    }
                    log_file.write(raw_line(raw))
                    kafka_file.write(
                        encode_json(
                            {
                                "schema_version": "1.0",
                                "event_id": raw["event_id"],
                                "source": f"synthetic-commerce-realtime/{run_id}",
                                "offset": event_index,
                                "review": event_type,
                                "created_at": raw["event_time"],
                                "raw": raw,
                            }
                        )
                    )
                    observed_counts[row["category"]][event_type] += 1

                search_url = f"/search?category={quote_plus(row['category'])}"
                for position in range(1, 4):
                    emit("product_impression", search_url, position)
                emit("product_click", f"/dp/{product['product_id']}", 3)
                if click_index < row["carts"]:
                    emit("add_to_cart", f"/dp/{product['product_id']}", 3)
                if click_index < row["purchase_clicks"]:
                    emit("purchase_click", "/checkout", 3)

    if event_index != total_events:
        raise RuntimeError(f"planned {total_events} events but wrote {event_index}")
    for row in planned:
        expected = {
            "product_impression": row["impressions"],
            "product_click": row["clicks"],
            "add_to_cart": row["carts"],
            "purchase_click": row["purchase_clicks"],
        }
        if dict(observed_counts[row["category"]]) != expected:
            raise RuntimeError(f"observed realtime counts differ for {row['category']}")
    return total_events, observed_counts


def _build_realtime_manifest(
    *,
    baseline: dict[str, Any],
    planned: list[dict[str, Any]],
    checks: list[dict[str, Any]],
    run_dir: Path,
    run_id: str,
    seed: int,
    anchor: datetime,
    window_start: datetime,
    total_events: int,
) -> dict[str, Any]:
    log_path = run_dir / "click-events.log"
    kafka_path = run_dir / "click-events.kafka.jsonl"
    metrics_path = run_dir / "category-metrics.json"
    metrics_path.write_bytes(encode_json({"categories": planned, "checks": checks}, indent=2))
    files = [
        file_evidence(log_path, total_events),
        file_evidence(kafka_path, total_events),
        file_evidence(metrics_path, len(planned)),
    ]
    slug = run_id.lower().replace("_", "-").replace(".", "-")
    return {
        "fixture_type": "synthetic-commerce-realtime-5m",
        "profile_version": PROFILE_VERSION,
        "run_id": run_id,
        "seed": seed,
        "baseline": {
            "run_id": baseline["manifest"]["run_id"],
            "generator_version": baseline["manifest"]["generator_version"],
            "manifest_sha256": baseline["manifest_sha256"],
            "analysis_result_sha256": baseline["analysis_result_sha256"],
        },
        "window": {
            "start": window_start.isoformat(),
            "end_exclusive": anchor.isoformat(),
            "minutes": WINDOW_MINUTES,
        },
        "replay_boundary": {
            "mode": "bounded_one_shot",
            "topic": f"asklake-commerce-demo-{slug}",
            "consumer_group": f"asklake-commerce-demo-{slug}-consumer",
            "checkpoint": f"checkpoints/synthetic-commerce/{slug}",
            "dataset": f"synthetic-commerce-realtime-{slug}",
        },
        "raw_field_names": list(FIELD_NAMES),
        "resolved_counts": {"events": total_events, "categories": len(planned)},
        "category_metrics": planned,
        "threshold_checks": checks,
        "files": files,
    }


def generate_realtime_fixture(
    *,
    baseline_dir: Path,
    output_dir: Path,
    run_id: str,
    anchor_at: str,
    seed: int = 20260711,
    clicks_per_category: int = 1_000,
) -> dict[str, Any]:
    validate_run_id(run_id)
    if clicks_per_category < MINIMUM_CLICKS_PER_CATEGORY:
        raise ValueError(
            f"clicks-per-category must be at least {MINIMUM_CLICKS_PER_CATEGORY}"
        )
    anchor = parse_anchor(anchor_at)
    window_start = anchor - timedelta(minutes=WINDOW_MINUTES)
    baseline = load_baseline(baseline_dir, window_start)

    run_dir = output_dir.resolve() / run_id
    if run_dir.exists():
        raise FileExistsError(f"run directory already exists: {run_dir}")
    run_dir.mkdir(parents=True)
    planned = _plan_categories(baseline, clicks_per_category)
    checks = evaluate_thresholds(planned)
    if not all(item["passed"] for item in checks):
        failed = ", ".join(item["name"] for item in checks if not item["passed"])
        raise ValueError(f"realtime fixture plan does not satisfy thresholds: {failed}")
    identity = _realtime_identity(baseline, seed, run_id, anchor)
    total_events, _ = _write_realtime_events(
        baseline=baseline,
        planned=planned,
        run_dir=run_dir,
        identity=identity,
        run_id=run_id,
        seed=seed,
        window_start=window_start,
    )
    manifest = _build_realtime_manifest(
        baseline=baseline,
        planned=planned,
        checks=checks,
        run_dir=run_dir,
        run_id=run_id,
        seed=seed,
        anchor=anchor,
        window_start=window_start,
        total_events=total_events,
    )
    (run_dir / "manifest.json").write_bytes(encode_json(manifest, indent=2))
    return manifest


def _scan_realtime_events(
    data_dir: Path,
    window_start: datetime,
    window_end: datetime,
    baseline: dict[str, Any] | None,
) -> tuple[bool, int, int, dict[str, Counter[str]]]:
    valid_users = {row["user_id"] for row in baseline["users"]} if baseline else None
    product_categories = (
        {
            product["product_id"]: category
            for category, products in baseline["products_by_category"].items()
            for product in products
        }
        if baseline
        else None
    )
    expected_order = {
        "product_impression": 0,
        "product_click": 1,
        "add_to_cart": 2,
        "purchase_click": 3,
    }
    session_stage: dict[str, int] = {}
    event_ids: set[str] = set()
    observed_counts: dict[str, Counter[str]] = defaultdict(Counter)
    content_passed = True
    log_rows = 0
    kafka_rows = 0
    with (data_dir / "click-events.log").open("r", encoding="utf-8") as log_handle, (
        data_dir / "click-events.kafka.jsonl"
    ).open("r", encoding="utf-8") as kafka_handle:
        for offset, (log_line, kafka_line) in enumerate(
            zip_longest(log_handle, kafka_handle), start=1
        ):
            if log_line is None or kafka_line is None or not log_line.strip() or not kafka_line.strip():
                content_passed = False
                continue
            log_rows += 1
            kafka_rows += 1
            values = log_line.strip().split()
            if len(values) != len(FIELD_NAMES):
                content_passed = False
                continue
            raw = dict(zip(FIELD_NAMES, values))
            raw["position"] = int(raw["position"])
            envelope = json.loads(kafka_line)
            timestamp = datetime.fromisoformat(raw["event_time"])
            stage = expected_order.get(raw["event_type"], -1)
            prior_stage = session_stage.get(raw["session_id"], -1)
            invalid = (
                envelope.get("offset") != offset
                or envelope.get("event_id") != raw["event_id"]
                or envelope.get("raw") != raw
                or not window_start <= timestamp < window_end
                or raw["event_id"] in event_ids
                or stage < prior_stage
                or (raw["event_type"] == "add_to_cart" and prior_stage < 1)
                or (raw["event_type"] == "purchase_click" and prior_stage < 2)
                or (valid_users is not None and raw["user_id"] not in valid_users)
                or (product_categories is not None and raw["product_id"] not in product_categories)
            )
            content_passed = content_passed and not invalid
            event_ids.add(raw["event_id"])
            session_stage[raw["session_id"]] = stage
            if product_categories is not None:
                observed_counts[product_categories[raw["product_id"]]][raw["event_type"]] += 1
    return content_passed, log_rows, kafka_rows, observed_counts


def validate_fixture(data_dir: Path, baseline_dir: Path | None = None) -> dict[str, Any]:
    data_dir = data_dir.resolve()
    manifest = json.loads((data_dir / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("fixture_type") != "synthetic-commerce-realtime-5m":
        raise ValueError("not a synthetic-commerce realtime fixture")
    evidence_checks = []
    for item in manifest["files"]:
        path = data_dir / item["path"]
        evidence_checks.append(
            path.is_file()
            and path.stat().st_size == item["bytes"]
            and sha256_file(path) == item["sha256"]
        )
    window_start = datetime.fromisoformat(manifest["window"]["start"])
    window_end = datetime.fromisoformat(manifest["window"]["end_exclusive"])
    baseline = load_baseline(baseline_dir, window_start) if baseline_dir else None
    baseline_identity_passed = baseline is None or (
        baseline["manifest"]["run_id"] == manifest["baseline"]["run_id"]
        and baseline["manifest_sha256"] == manifest["baseline"]["manifest_sha256"]
        and baseline["analysis_result_sha256"]
        == manifest["baseline"]["analysis_result_sha256"]
    )
    content_passed, log_rows, kafka_rows, observed_counts = _scan_realtime_events(
        data_dir, window_start, window_end, baseline
    )

    category_counts_passed = True
    if baseline:
        for row in manifest["category_metrics"]:
            counts = observed_counts[row["category"]]
            category_counts_passed = category_counts_passed and counts == Counter(
                {
                    "product_impression": row["impressions"],
                    "product_click": row["clicks"],
                    "add_to_cart": row["carts"],
                    "purchase_click": row["purchase_clicks"],
                }
            )
    passed = (
        all(evidence_checks)
        and baseline_identity_passed
        and content_passed
        and category_counts_passed
        and log_rows == manifest["resolved_counts"]["events"]
        and kafka_rows == manifest["resolved_counts"]["events"]
        and all(item["passed"] for item in manifest["threshold_checks"])
    )
    return {
        "all_passed": passed,
        "evidence_files_checked": len(evidence_checks),
        "log_rows": log_rows,
        "kafka_rows": kafka_rows,
        "baseline_identity_passed": baseline_identity_passed,
        "content_contract_passed": content_passed,
        "category_counts_passed": category_counts_passed,
        "threshold_checks": manifest["threshold_checks"],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-dir", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--run-id")
    parser.add_argument("--anchor-at")
    parser.add_argument("--validate-dir", type=Path)
    parser.add_argument("--seed", type=int, default=20260711)
    parser.add_argument("--clicks-per-category", type=int, default=1_000)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.validate_dir:
        result = validate_fixture(args.validate_dir, args.baseline_dir)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["all_passed"] else 1
    missing = [
        name
        for name, value in (
            ("--baseline-dir", args.baseline_dir),
            ("--output-dir", args.output_dir),
            ("--run-id", args.run_id),
            ("--anchor-at", args.anchor_at),
        )
        if value is None
    ]
    if missing:
        raise SystemExit(f"generation requires: {', '.join(missing)}")
    try:
        manifest = generate_realtime_fixture(
            baseline_dir=args.baseline_dir,
            output_dir=args.output_dir,
            run_id=args.run_id,
            anchor_at=args.anchor_at,
            seed=args.seed,
            clicks_per_category=args.clicks_per_category,
        )
    except (FileExistsError, RuntimeError, ValueError) as error:
        raise SystemExit(str(error)) from error
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
