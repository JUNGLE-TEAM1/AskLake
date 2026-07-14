#!/usr/bin/env python3
"""Extract the full normalized Amazon Electronics product catalog.

The public products file preserves every row with a usable ``parent_asin``.
Missing descriptive or behavioral fields become JSON nulls.  A separate internal
click pool contains only rows that can safely drive the synthetic behavior model.
SQLite keeps de-duplication exact without retaining source cardinality in memory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sqlite3
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


PRODUCTS_NAME = "products.jsonl"
CLICK_POOL_NAME = "click_product_pool.jsonl"
PROFILE_NAME = "product-profile.json"
INDEX_NAME = ".product-index.sqlite.tmp"
SCHEMA_VERSION = 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--commit-every", type=int, default=10_000)
    parser.add_argument("--progress-every", type=int, default=100_000)
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def normalized_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def safe_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        try:
            number = float(value.replace("$", "").replace(",", "").strip())
        except ValueError:
            return None
    else:
        return None
    return number if math.isfinite(number) else None


def safe_nonnegative_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def normalized_category_path(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [text for item in value if (text := normalized_text(item)) is not None]


def normalize_product(raw: dict[str, Any]) -> dict[str, Any] | None:
    product_id = normalized_text(raw.get("parent_asin"))
    if product_id is None:
        return None
    path = normalized_category_path(raw.get("categories"))
    main_category = normalized_text(raw.get("main_category"))
    category = path[1] if len(path) > 1 else path[0] if path else main_category
    leaf_category = path[-1] if path else category
    price = safe_float(raw.get("price"))
    if price is not None and price <= 0:
        price = None
    rating = safe_float(raw.get("average_rating"))
    if rating is not None and not 1.0 <= rating <= 5.0:
        rating = None
    return {
        "product_id": product_id,
        "main_category": main_category,
        "category": category,
        "leaf_category": leaf_category,
        "title": normalized_text(raw.get("title")),
        "store": normalized_text(raw.get("store")),
        "price": round(price, 2) if price is not None else None,
        "average_rating": round(rating, 1) if rating is not None else None,
        "rating_count": safe_nonnegative_int(raw.get("rating_number")),
    }


def click_eligible(product: dict[str, Any]) -> bool:
    price = product["price"]
    rating = product["average_rating"]
    rating_count = product["rating_count"]
    return bool(
        product["title"]
        and product["category"]
        and price is not None
        and 1.0 <= price <= 10_000.0
        and rating is not None
        and 1.0 <= rating <= 5.0
        and rating_count is not None
        and rating_count >= 5
    )


def completeness_score(product: dict[str, Any]) -> int:
    fields = (
        "main_category",
        "category",
        "leaf_category",
        "title",
        "store",
        "price",
        "average_rating",
        "rating_count",
    )
    return sum(product[field] is not None for field in fields)


def compact_payload(product: dict[str, Any]) -> bytes:
    return json.dumps(
        product, ensure_ascii=False, separators=(",", ":"), sort_keys=False
    ).encode("utf-8")


def open_index(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA journal_mode=DELETE")
    connection.execute("PRAGMA synchronous=NORMAL")
    connection.execute("PRAGMA temp_store=FILE")
    connection.execute("PRAGMA cache_size=-65536")
    connection.execute(
        """
        CREATE TABLE products (
          product_id TEXT PRIMARY KEY,
          completeness INTEGER NOT NULL,
          click_eligible INTEGER NOT NULL,
          payload BLOB NOT NULL
        ) WITHOUT ROWID
        """
    )
    return connection


def insert_product(
    connection: sqlite3.Connection, product: dict[str, Any]
) -> tuple[bool, bool]:
    payload = compact_payload(product)
    score = completeness_score(product)
    eligible = int(click_eligible(product))
    cursor = connection.execute(
        "INSERT OR IGNORE INTO products VALUES (?, ?, ?, ?)",
        (product["product_id"], score, eligible, payload),
    )
    if cursor.rowcount == 1:
        return False, False
    updated = connection.execute(
        """
        UPDATE products
        SET completeness = ?, click_eligible = ?, payload = ?
        WHERE product_id = ? AND completeness < ?
        """,
        (score, eligible, payload, product["product_id"], score),
    ).rowcount == 1
    return True, updated


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def file_metadata(path: Path, rows: int) -> dict[str, Any]:
    return {"rows": rows, "bytes": path.stat().st_size, "sha256": sha256_file(path)}


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def cleanup_outputs(output_dir: Path) -> None:
    for name in (PRODUCTS_NAME, CLICK_POOL_NAME, PROFILE_NAME, INDEX_NAME):
        path = output_dir / name
        if path.exists():
            path.unlink()
    for path in output_dir.glob("*.tmp"):
        path.unlink()


def scan_source(
    source: Path,
    connection: sqlite3.Connection,
    commit_every: int,
    progress_every: int,
) -> Counter[str]:
    stats: Counter[str] = Counter()
    with source.open("r", encoding="utf-8") as handle:
        for line in handle:
            stats["source_rows"] += 1
            try:
                raw = json.loads(line)
            except json.JSONDecodeError:
                stats["invalid_json_rows"] += 1
                continue
            if not isinstance(raw, dict):
                stats["non_object_rows"] += 1
                continue
            product = normalize_product(raw)
            if product is None:
                stats["missing_product_id_rows"] += 1
                continue
            duplicate, replaced = insert_product(connection, product)
            if duplicate:
                stats["duplicate_product_id_rows"] += 1
            if replaced:
                stats["duplicate_replacements"] += 1
            if stats["source_rows"] % commit_every == 0:
                connection.commit()
            if progress_every and stats["source_rows"] % progress_every == 0:
                print(
                    json.dumps(
                        {
                            "source_rows": stats["source_rows"],
                            "missing_product_id_rows": stats["missing_product_id_rows"],
                            "duplicate_product_id_rows": stats["duplicate_product_id_rows"],
                        }
                    ),
                    flush=True,
                )
    connection.commit()
    return stats


def write_outputs(
    connection: sqlite3.Connection, products_path: Path, click_pool_path: Path
) -> tuple[Counter[str], Counter[str]]:
    products_tmp = products_path.with_suffix(products_path.suffix + ".tmp")
    click_tmp = click_pool_path.with_suffix(click_pool_path.suffix + ".tmp")
    stats: Counter[str] = Counter()
    categories: Counter[str] = Counter()
    with products_tmp.open("wb") as products_handle, click_tmp.open("wb") as click_handle:
        cursor = connection.execute(
            "SELECT click_eligible, payload FROM products ORDER BY product_id"
        )
        for eligible, payload in cursor:
            raw_payload = bytes(payload)
            line = raw_payload + b"\n"
            products_handle.write(line)
            stats["product_rows"] += 1
            product = json.loads(raw_payload)
            for field in (
                "main_category",
                "category",
                "leaf_category",
                "title",
                "store",
                "price",
                "average_rating",
                "rating_count",
            ):
                if product[field] is None:
                    stats[f"null_{field}_rows"] += 1
            categories[product["category"] or "<null>"] += 1
            if eligible:
                click_handle.write(line)
                stats["click_eligible_rows"] += 1
        for handle in (products_handle, click_handle):
            handle.flush()
            os.fsync(handle.fileno())
    os.replace(products_tmp, products_path)
    os.replace(click_tmp, click_pool_path)
    return stats, categories


def source_identity(source: Path) -> dict[str, Any]:
    metadata = source.stat()
    return {
        "name": source.name,
        "path": str(source.resolve()),
        "bytes": metadata.st_size,
        "mtime_ns": metadata.st_mtime_ns,
    }


def run_extraction(args: argparse.Namespace) -> dict[str, Any]:
    source = args.source.resolve()
    if not source.is_file():
        raise RuntimeError(f"source does not exist: {source}")
    if args.commit_every <= 0 or args.progress_every < 0:
        raise RuntimeError("commit-every must be positive and progress-every cannot be negative")
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    products_path = output_dir / PRODUCTS_NAME
    click_pool_path = output_dir / CLICK_POOL_NAME
    profile_path = output_dir / PROFILE_NAME
    index_path = output_dir / INDEX_NAME
    if args.force:
        cleanup_outputs(output_dir)
    existing = [path.name for path in (products_path, click_pool_path, profile_path, index_path) if path.exists()]
    if existing:
        raise RuntimeError(f"output already exists; use --force: {', '.join(existing)}")

    started = time.monotonic()
    started_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    connection = open_index(index_path)
    success = False
    try:
        scan_stats = scan_source(
            source, connection, args.commit_every, args.progress_every
        )
        output_stats, categories = write_outputs(
            connection, products_path, click_pool_path
        )
        product_rows = int(output_stats["product_rows"])
        eligible_rows = int(output_stats["click_eligible_rows"])
        profile = {
            "schema_version": SCHEMA_VERSION,
            "status": "complete",
            "source": source_identity(source),
            "rules": {
                "product_inclusion": "non-empty parent_asin; exact de-duplication keeps the most complete row",
                "missing_values": "preserved as JSON null",
                "category_scope": "all normalized Electronics categories; no fixed category allowlist",
                "click_eligibility": "title and category; price 1..10000; rating 1..5; rating_count >= 5",
            },
            "scan": dict(scan_stats),
            "products": {
                "rows": product_rows,
                "click_eligible_rows": eligible_rows,
                "click_eligible_pct": round(100.0 * eligible_rows / max(1, product_rows), 4),
                "null_counts": {
                    field: int(output_stats[f"null_{field}_rows"])
                    for field in (
                        "main_category",
                        "category",
                        "leaf_category",
                        "title",
                        "store",
                        "price",
                        "average_rating",
                        "rating_count",
                    )
                },
                "top_categories": dict(categories.most_common(50)),
            },
            "files": {
                PRODUCTS_NAME: file_metadata(products_path, product_rows),
                CLICK_POOL_NAME: file_metadata(click_pool_path, eligible_rows),
            },
            "started_at": started_at,
            "completed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "duration_seconds": round(time.monotonic() - started, 3),
        }
        write_json_atomic(profile_path, profile)
        success = True
        return profile
    finally:
        connection.close()
        if success and index_path.exists():
            index_path.unlink()


def main() -> None:
    args = parse_args()
    try:
        profile = run_extraction(args)
    except (OSError, RuntimeError, sqlite3.Error) as exc:
        print(str(exc), file=os.sys.stderr)
        raise SystemExit(1) from exc
    print(json.dumps(profile, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
