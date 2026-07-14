#!/usr/bin/env python3
"""Stream-validate large synthetic commerce JSONL tiers without SQLite."""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, BinaryIO, Iterator


class ValidationFailure(RuntimeError):
    pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--tier", action="append", default=[])
    parser.add_argument("--skip-hash-check", action="store_true")
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def read_json_line(handle: BinaryIO, path: Path, line_number: int, digest: Any) -> dict[str, Any] | None:
    raw = handle.readline()
    if not raw:
        return None
    digest.update(raw)
    if not raw.endswith(b"\n"):
        raise ValidationFailure(f"{path.name}:{line_number} is not newline-terminated")
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValidationFailure(f"{path.name}:{line_number} is not valid UTF-8 JSON") from exc
    if not isinstance(value, dict):
        raise ValidationFailure(f"{path.name}:{line_number} must contain a JSON object")
    return value


def scan_products(path: Path) -> tuple[set[str], dict[str, Any]]:
    product_ids: set[str] = set()
    categories: Counter[str] = Counter()
    digest = hashlib.sha256()
    rows = 0
    with path.open("rb") as handle:
        while True:
            row = read_json_line(handle, path, rows + 1, digest)
            if row is None:
                break
            rows += 1
            product_id = str(row.get("product_id") or "")
            if not product_id:
                raise ValidationFailure(f"{path.name}:{rows} has no product_id")
            if product_id in product_ids:
                raise ValidationFailure(f"duplicate product_id: {product_id}")
            product_ids.add(product_id)
            categories[str(row.get("category") or "")] += 1
    return product_ids, {
        "rows": rows,
        "bytes": path.stat().st_size,
        "sha256": digest.hexdigest(),
        "categories": dict(categories),
    }


def next_event(
    handle: BinaryIO,
    path: Path,
    line_number: int,
    digest: Any,
) -> tuple[dict[str, Any] | None, int]:
    row = read_json_line(handle, path, line_number + 1, digest)
    return row, line_number + (1 if row is not None else 0)


def validate_tier(
    data_dir: Path,
    label: str,
    tier_manifest: dict[str, Any],
    product_ids: set[str],
    product_metadata: dict[str, Any],
    verify_hashes: bool,
) -> dict[str, Any]:
    users_path = data_dir / f"users_{label}.jsonl"
    events_path = data_dir / f"click_events_{label}.jsonl"
    if not users_path.is_file() or not events_path.is_file():
        raise ValidationFailure(f"tier {label} is missing users or click events JSONL")
    user_digest = hashlib.sha256()
    event_digest = hashlib.sha256()
    user_rows = 0
    event_rows = 0
    session_count = 0
    event_types: Counter[str] = Counter()
    previous_user_id = ""
    previous_event_id = ""
    previous_session_id = ""
    with users_path.open("rb") as users_handle, events_path.open("rb") as events_handle:
        current_event, event_rows = next_event(events_handle, events_path, event_rows, event_digest)
        while True:
            user = read_json_line(users_handle, users_path, user_rows + 1, user_digest)
            if user is None:
                break
            user_rows += 1
            user_id = str(user.get("user_id") or "")
            if not user_id or user_id <= previous_user_id:
                raise ValidationFailure(f"{users_path.name}:{user_rows} user_id order/uniqueness failed")
            previous_user_id = user_id
            try:
                signup_at = datetime.fromisoformat(str(user["signup_at"]))
            except (KeyError, ValueError) as exc:
                raise ValidationFailure(f"{users_path.name}:{user_rows} has invalid signup_at") from exc
            active_session = None
            prior_time = None
            prior_by_product: dict[str, set[str]] = defaultdict(set)
            while current_event is not None and str(current_event.get("user_id") or "") == user_id:
                event_id = str(current_event.get("event_id") or "")
                if not event_id or event_id <= previous_event_id:
                    raise ValidationFailure(f"{events_path.name}:{event_rows} event_id order/uniqueness failed")
                previous_event_id = event_id
                product_id = str(current_event.get("product_id") or "")
                if product_id not in product_ids:
                    raise ValidationFailure(f"{events_path.name}:{event_rows} references unknown product {product_id}")
                try:
                    event_time = datetime.fromisoformat(str(current_event["event_time"]))
                except (KeyError, ValueError) as exc:
                    raise ValidationFailure(f"{events_path.name}:{event_rows} has invalid event_time") from exc
                if event_time < signup_at:
                    raise ValidationFailure(f"{events_path.name}:{event_rows} occurs before signup")
                session_id = str(current_event.get("session_id") or "")
                if session_id != active_session:
                    if not session_id or session_id <= previous_session_id:
                        raise ValidationFailure(
                            f"session order/uniqueness failed: {session_id or '<empty>'}"
                        )
                    previous_session_id = session_id
                    session_count += 1
                    active_session = session_id
                    prior_time = None
                    prior_by_product = defaultdict(set)
                if prior_time is not None and event_time < prior_time:
                    raise ValidationFailure(f"{events_path.name}:{event_rows} session time moved backwards")
                prior_time = event_time
                event_type = str(current_event.get("event_type") or "")
                if event_type == "add_to_cart" and "product_click" not in prior_by_product[product_id]:
                    raise ValidationFailure(f"{events_path.name}:{event_rows} cart has no prior click")
                if event_type == "purchase_click" and "add_to_cart" not in prior_by_product[product_id]:
                    raise ValidationFailure(f"{events_path.name}:{event_rows} purchase click has no prior cart")
                prior_by_product[product_id].add(event_type)
                event_types[event_type] += 1
                current_event, event_rows = next_event(events_handle, events_path, event_rows, event_digest)
            if current_event is not None and str(current_event.get("user_id") or "") < user_id:
                raise ValidationFailure(f"{events_path.name}:{event_rows} user order moved backwards")
        if current_event is not None:
            raise ValidationFailure(
                f"{events_path.name}:{event_rows} references user not present in {users_path.name}: "
                f"{current_event.get('user_id')}"
            )

    result = {
        "status": "pass",
        "counts": {
            "products": product_metadata["rows"],
            "users": user_rows,
            "sessions": session_count,
            "events": event_rows,
            "event_type_counts": dict(event_types),
        },
        "files": {
            "products.jsonl": product_metadata,
            users_path.name: {
                "rows": user_rows,
                "bytes": users_path.stat().st_size,
                "sha256": user_digest.hexdigest(),
            },
            events_path.name: {
                "rows": event_rows,
                "bytes": events_path.stat().st_size,
                "sha256": event_digest.hexdigest(),
            },
        },
    }
    expected_counts = tier_manifest.get("counts") or {}
    for key in ("products", "users", "sessions", "events"):
        if int(expected_counts.get(key, -1)) != int(result["counts"][key]):
            raise ValidationFailure(
                f"tier {label} {key} count mismatch: expected={expected_counts.get(key)} "
                f"actual={result['counts'][key]}"
            )
    actual_total = sum(int(file["bytes"]) for file in result["files"].values())
    if int(tier_manifest.get("actual_total_bytes", -1)) != actual_total:
        raise ValidationFailure(
            f"tier {label} byte mismatch: expected={tier_manifest.get('actual_total_bytes')} actual={actual_total}"
        )
    overshoot = actual_total - int(tier_manifest.get("target_bytes", 0))
    if int(tier_manifest.get("overshoot_bytes", -1)) != overshoot:
        raise ValidationFailure(
            f"tier {label} overshoot mismatch: expected={tier_manifest.get('overshoot_bytes')} "
            f"actual={overshoot}"
        )
    allowed_overshoot = int(tier_manifest.get("allowed_overshoot_bytes", -1))
    if overshoot < 0 or allowed_overshoot < 0 or overshoot > allowed_overshoot:
        raise ValidationFailure(
            f"tier {label} overshoot is outside the contract: overshoot={overshoot} "
            f"allowed={allowed_overshoot}"
        )
    expected_types = expected_counts.get("event_type_counts") or {}
    if expected_types != result["counts"]["event_type_counts"]:
        raise ValidationFailure(f"tier {label} event_type_counts mismatch")
    expected_files = tier_manifest.get("files") or {}
    for name, metadata in result["files"].items():
        expected = expected_files.get(name) or {}
        if int(expected.get("bytes", -1)) != int(metadata["bytes"]):
            raise ValidationFailure(f"tier {label} file byte mismatch: {name}")
        if verify_hashes:
            if expected.get("sha256") != metadata["sha256"]:
                raise ValidationFailure(f"tier {label} sha256 mismatch: {name}")
    return result


def validate(data_dir: Path, labels: list[str], verify_hashes: bool = True) -> dict[str, Any]:
    manifest_path = data_dir / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValidationFailure(f"cannot read manifest: {manifest_path}") from exc
    manifest_tiers = manifest.get("tiers") or {}
    selected = labels or list(manifest_tiers)
    unknown = sorted(set(selected).difference(manifest_tiers))
    if unknown:
        raise ValidationFailure(f"manifest has no tiers: {', '.join(unknown)}")
    products_path = data_dir / "products.jsonl"
    product_ids, product_metadata = scan_products(products_path)
    results = {
        label: validate_tier(
            data_dir,
            label,
            manifest_tiers[label],
            product_ids,
            product_metadata,
            verify_hashes,
        )
        for label in selected
    }
    return {
        "status": "pass",
        "data_dir": str(data_dir),
        "tiers": results,
    }


def main() -> None:
    args = parse_args()
    data_dir = args.data_dir.resolve()
    output = args.output.resolve() if args.output else data_dir / "validation-result.json"
    try:
        result = validate(data_dir, args.tier, verify_hashes=not args.skip_hash_check)
    except ValidationFailure as exc:
        failure = {"status": "fail", "error": str(exc), "data_dir": str(data_dir)}
        output.write_text(json.dumps(failure, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(failure, ensure_ascii=False, indent=2))
        raise SystemExit(1) from exc
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
