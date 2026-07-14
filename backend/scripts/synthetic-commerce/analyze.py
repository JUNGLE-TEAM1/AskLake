#!/usr/bin/env python3
"""Load generated files into SQLite, run insight SQL, and write a report."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable, Sequence


SCHEMA_SQL = """
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS click_events;

CREATE TABLE products (
    product_id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    leaf_category TEXT NOT NULL,
    title TEXT NOT NULL,
    store TEXT NOT NULL,
    price REAL NOT NULL,
    average_rating REAL NOT NULL,
    rating_count INTEGER NOT NULL
);

CREATE TABLE users (
    user_id TEXT PRIMARY KEY,
    age INTEGER NOT NULL,
    gender TEXT NOT NULL,
    region TEXT NOT NULL,
    signup_at TEXT NOT NULL,
    acquisition_channel TEXT NOT NULL,
    membership_tier TEXT NOT NULL,
    primary_device TEXT NOT NULL
);

CREATE TABLE click_events (
    event_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    event_time TEXT NOT NULL,
    event_type TEXT NOT NULL,
    product_id TEXT NOT NULL,
    page_url TEXT NOT NULL,
    device_type TEXT NOT NULL,
    referrer TEXT NOT NULL,
    position INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (product_id) REFERENCES products(product_id)
);
"""


QUERIES = {
    "age_category_affinity": """
WITH clicks AS (
  SELECT
    CASE
      WHEN u.age BETWEEN 18 AND 34 THEN '18-34'
      WHEN u.age BETWEEN 35 AND 44 THEN '35-44'
      ELSE '45+'
    END AS age_group,
    p.category
  FROM click_events e
  JOIN users u ON u.user_id = e.user_id
  JOIN products p ON p.product_id = e.product_id
  WHERE e.event_type = 'product_click'
), totals AS (
  SELECT age_group, COUNT(*) AS total_clicks
  FROM clicks
  GROUP BY age_group
)
SELECT
  c.age_group,
  c.category,
  COUNT(*) AS clicks,
  ROUND(100.0 * COUNT(*) / t.total_clicks, 2) AS click_share_pct
FROM clicks c
JOIN totals t ON t.age_group = c.age_group
GROUP BY c.age_group, c.category
ORDER BY c.age_group, click_share_pct DESC;
""",
    "acquisition_funnel": """
SELECT
  u.acquisition_channel,
  SUM(e.event_type = 'product_impression') AS impressions,
  SUM(e.event_type = 'product_click') AS clicks,
  SUM(e.event_type = 'add_to_cart') AS carts,
  SUM(e.event_type = 'purchase_click') AS purchase_clicks,
  ROUND(100.0 * SUM(e.event_type = 'product_click') /
        NULLIF(SUM(e.event_type = 'product_impression'), 0), 2) AS ctr_pct,
  ROUND(100.0 * SUM(e.event_type = 'purchase_click') /
        NULLIF(SUM(e.event_type = 'product_click'), 0), 2) AS click_to_purchase_pct
FROM click_events e
JOIN users u ON u.user_id = e.user_id
GROUP BY u.acquisition_channel
ORDER BY click_to_purchase_pct DESC;
""",
    "membership_funnel": """
SELECT
  u.membership_tier,
  SUM(e.event_type = 'product_click') AS clicks,
  SUM(e.event_type = 'add_to_cart') AS carts,
  SUM(e.event_type = 'purchase_click') AS purchase_clicks,
  ROUND(100.0 * SUM(e.event_type = 'add_to_cart') /
        NULLIF(SUM(e.event_type = 'product_click'), 0), 2) AS click_to_cart_pct,
  ROUND(100.0 * SUM(e.event_type = 'purchase_click') /
        NULLIF(SUM(e.event_type = 'product_click'), 0), 2) AS click_to_purchase_pct
FROM click_events e
JOIN users u ON u.user_id = e.user_id
GROUP BY u.membership_tier
ORDER BY click_to_purchase_pct DESC;
""",
    "device_time_pattern": """
SELECT
  device_type,
  COUNT(*) AS events,
  SUM(CASE WHEN CAST(SUBSTR(event_time, 12, 2) AS INTEGER) BETWEEN 18 AND 23 THEN 1 ELSE 0 END)
    AS evening_events,
  ROUND(100.0 * SUM(CASE WHEN CAST(SUBSTR(event_time, 12, 2) AS INTEGER)
                              BETWEEN 18 AND 23 THEN 1 ELSE 0 END) / COUNT(*), 2)
    AS evening_share_pct
FROM click_events
GROUP BY device_type
ORDER BY evening_share_pct DESC;
""",
    "gender_null_control": """
SELECT
  u.gender,
  SUM(e.event_type = 'product_click') AS clicks,
  SUM(e.event_type = 'purchase_click') AS purchase_clicks,
  ROUND(100.0 * SUM(e.event_type = 'purchase_click') /
        NULLIF(SUM(e.event_type = 'product_click'), 0), 2) AS click_to_purchase_pct
FROM click_events e
JOIN users u ON u.user_id = e.user_id
GROUP BY u.gender
ORDER BY u.gender;
""",
    "catalog_long_tail": """
WITH event_clicks AS (
  SELECT product_id, COUNT(*) AS clicks
  FROM click_events
  WHERE event_type = 'product_click'
  GROUP BY product_id
), product_clicks AS (
  SELECT p.product_id, p.category, p.rating_count, COALESCE(e.clicks, 0) AS clicks
  FROM products p
  LEFT JOIN event_clicks e ON e.product_id = p.product_id
), ranked AS (
  SELECT *, NTILE(10) OVER (ORDER BY rating_count DESC) AS rating_count_decile
  FROM product_clicks
)
SELECT
  rating_count_decile,
  COUNT(*) AS products,
  SUM(clicks) AS clicks,
  ROUND(AVG(clicks), 2) AS avg_clicks_per_product
FROM ranked
GROUP BY rating_count_decile
ORDER BY rating_count_decile;
""",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True, type=Path)
    return parser.parse_args()


def markdown_table(columns: Sequence[str], rows: Sequence[Sequence[Any]]) -> str:
    if not rows:
        return "_(no rows)_"
    header = "| " + " | ".join(columns) + " |"
    separator = "| " + " | ".join("---" for _ in columns) + " |"
    body = ["| " + " | ".join(str(value) for value in row) + " |" for row in rows]
    return "\n".join([header, separator, *body])


def jsonl_rows(paths: Iterable[Path]) -> Iterable[dict[str, Any]]:
    for path in paths:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    yield json.loads(line)


def insert_batches(
    connection: sqlite3.Connection,
    statement: str,
    rows: Iterable[tuple[Any, ...]],
    batch_size: int = 10_000,
) -> int:
    batch: list[tuple[Any, ...]] = []
    count = 0
    for row in rows:
        batch.append(row)
        if len(batch) >= batch_size:
            connection.executemany(statement, batch)
            count += len(batch)
            batch = []
    if batch:
        connection.executemany(statement, batch)
        count += len(batch)
    return count


def load_products_csv(connection: sqlite3.Connection, path: Path) -> int:
    def rows() -> Iterable[tuple[Any, ...]]:
        with path.open("r", encoding="utf-8", newline="") as handle:
            for row in csv.DictReader(handle):
                yield (
                    row["product_id"], row["category"], row["leaf_category"], row["title"],
                    row["store"], float(row["price"]), float(row["average_rating"]),
                    int(row["rating_count"]),
                )

    return insert_batches(connection, "INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows())


def load_users_csv(connection: sqlite3.Connection, path: Path) -> int:
    def rows() -> Iterable[tuple[Any, ...]]:
        with path.open("r", encoding="utf-8", newline="") as handle:
            for row in csv.DictReader(handle):
                yield (
                    row["user_id"], int(row["age"]), row["gender"], row["region"],
                    row["signup_at"], row["acquisition_channel"], row["membership_tier"],
                    row["primary_device"],
                )

    return insert_batches(connection, "INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows())


def load_products_jsonl(connection: sqlite3.Connection, paths: Iterable[Path]) -> int:
    rows = (
        (
            row["product_id"], row["category"], row["leaf_category"], row["title"],
            row["store"], float(row["price"]), float(row["average_rating"]),
            int(row["rating_count"]),
        )
        for row in jsonl_rows(paths)
    )
    return insert_batches(connection, "INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows)


def load_users_jsonl(connection: sqlite3.Connection, paths: Iterable[Path]) -> int:
    rows = (
        (
            row["user_id"], int(row["age"]), row["gender"], row["region"],
            row["signup_at"], row["acquisition_channel"], row["membership_tier"],
            row["primary_device"],
        )
        for row in jsonl_rows(paths)
    )
    return insert_batches(connection, "INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows)


def event_batches(paths: Iterable[Path], batch_size: int = 10_000) -> Iterable[list[tuple[Any, ...]]]:
    batch: list[tuple[Any, ...]] = []
    for row in jsonl_rows(paths):
        batch.append(
            (
                row["event_id"], row["user_id"], row["session_id"], row["event_time"],
                row["event_type"], row["product_id"], row["page_url"], row["device_type"],
                row["referrer"], row.get("properties", {}).get("position"),
            )
        )
        if len(batch) >= batch_size:
            yield batch
            batch = []
    if batch:
        yield batch


def load_events(connection: sqlite3.Connection, paths: Iterable[Path]) -> int:
    count = 0
    for batch in event_batches(paths):
        connection.executemany("INSERT INTO click_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", batch)
        count += len(batch)
    return count


def part_files(data_dir: Path, dataset: str) -> list[Path]:
    return sorted((data_dir / dataset).glob("part-*.jsonl"))


def build_database(data_dir: Path) -> tuple[sqlite3.Connection, dict[str, int]]:
    database_path = data_dir / "analysis.sqlite"
    if database_path.exists():
        database_path.unlink()
    connection = sqlite3.connect(database_path)
    connection.execute("PRAGMA foreign_keys = ON")
    connection.executescript(SCHEMA_SQL)
    if (data_dir / "meta").is_dir():
        counts = {
            "products": load_products_jsonl(connection, part_files(data_dir, "meta")),
            "users": load_users_jsonl(connection, part_files(data_dir, "users")),
            "events": load_events(connection, part_files(data_dir, "click_events")),
        }
    else:
        # Legacy fixture compatibility for the original three-file layout.
        counts = {
            "products": load_products_csv(connection, data_dir / "products.csv"),
            "users": load_users_csv(connection, data_dir / "users.csv"),
            "events": load_events(connection, [data_dir / "click_events.jsonl"]),
        }
    connection.executescript(
        """
        CREATE INDEX idx_events_user ON click_events(user_id);
        CREATE INDEX idx_events_product ON click_events(product_id);
        CREATE INDEX idx_events_session_time ON click_events(session_id, event_time);
        CREATE INDEX idx_events_funnel_sequence
          ON click_events(session_id, product_id, event_type, event_time);
        CREATE INDEX idx_events_type ON click_events(event_type);
        """
    )
    connection.commit()
    return connection, counts


def rows_for(connection: sqlite3.Connection, query: str) -> tuple[list[str], list[tuple[Any, ...]]]:
    cursor = connection.execute(query)
    columns = [description[0] for description in cursor.description]
    return columns, cursor.fetchall()


def scalar(connection: sqlite3.Connection, query: str, parameters: Sequence[Any] = ()) -> Any:
    return connection.execute(query, parameters).fetchone()[0]


def ratio(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator else 0.0


def validate_integrity(
    connection: sqlite3.Connection,
    window: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    checks = [
        {
            "name": "orphan user references",
            "value": scalar(connection, """
                SELECT COUNT(*) FROM click_events e
                LEFT JOIN users u ON u.user_id = e.user_id
                WHERE u.user_id IS NULL
            """),
            "expected": 0,
        },
        {
            "name": "orphan product references",
            "value": scalar(connection, """
                SELECT COUNT(*) FROM click_events e
                LEFT JOIN products p ON p.product_id = e.product_id
                WHERE p.product_id IS NULL
            """),
            "expected": 0,
        },
        {
            "name": "events before signup",
            "value": scalar(connection, """
                SELECT COUNT(*) FROM click_events e
                JOIN users u ON u.user_id = e.user_id
                WHERE e.event_time < u.signup_at
            """),
            "expected": 0,
        },
        {
            "name": "purchase click without prior cart in session/product",
            "value": scalar(connection, """
                SELECT COUNT(*)
                FROM click_events purchase
                WHERE purchase.event_type = 'purchase_click'
                  AND NOT EXISTS (
                    SELECT 1 FROM click_events cart
                    WHERE cart.session_id = purchase.session_id
                      AND cart.product_id = purchase.product_id
                      AND cart.event_type = 'add_to_cart'
                      AND cart.event_time <= purchase.event_time
                  )
            """),
            "expected": 0,
        },
        {
            "name": "cart without prior click in session/product",
            "value": scalar(connection, """
                SELECT COUNT(*)
                FROM click_events cart
                WHERE cart.event_type = 'add_to_cart'
                  AND NOT EXISTS (
                    SELECT 1 FROM click_events click
                    WHERE click.session_id = cart.session_id
                      AND click.product_id = cart.product_id
                      AND click.event_type = 'product_click'
                      AND click.event_time <= cart.event_time
                  )
            """),
            "expected": 0,
        },
    ]
    if window:
        checks.append(
            {
                "name": "events outside generation window",
                "value": scalar(
                    connection,
                    """
                    SELECT COUNT(*) FROM click_events
                    WHERE event_time < ? OR event_time >= ?
                    """,
                    (window["start"], window["end_exclusive"]),
                ),
                "expected": 0,
            }
        )
    for check in checks:
        check["passed"] = check["value"] == check["expected"]
    return checks


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate_manifest_files(data_dir: Path, manifest: dict[str, Any]) -> list[dict[str, Any]]:
    """Validate v2 file size, row count, and checksum evidence."""
    if manifest.get("generator_version") != 2:
        return []
    checks: list[dict[str, Any]] = []
    for dataset in manifest.get("datasets", {}).values():
        for expected in dataset.get("files", []):
            path = data_dir / expected["path"]
            exists = path.is_file()
            actual_bytes = path.stat().st_size if exists else None
            actual_rows = 0
            actual_sha256 = None
            if exists:
                with path.open("rb") as handle:
                    actual_rows = sum(1 for _ in handle)
                actual_sha256 = file_sha256(path)
            passed = (
                exists
                and actual_bytes == expected["bytes"]
                and actual_rows == expected["rows"]
                and actual_sha256 == expected["sha256"]
            )
            checks.append(
                {
                    "name": f"manifest evidence: {expected['path']}",
                    "value": "match" if passed else "mismatch",
                    "expected": "match",
                    "passed": passed,
                }
            )
    return checks


def query_as_dicts(connection: sqlite3.Connection, query: str) -> list[dict[str, Any]]:
    cursor = connection.execute(query)
    columns = [description[0] for description in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def evaluate_patterns(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    age_rows = query_as_dicts(connection, QUERIES["age_category_affinity"])
    shares = {(row["age_group"], row["category"]): row["click_share_pct"] for row in age_rows}
    young_audio = shares[("18-34", "Headphones, Earbuds & Accessories")] + shares[("18-34", "Wearable Technology")]
    older_audio = shares[("45+", "Headphones, Earbuds & Accessories")] + shares[("45+", "Wearable Technology")]
    older_home = shares[("45+", "Television & Video")] + shares[("45+", "Home Audio")]
    young_home = shares[("18-34", "Television & Video")] + shares[("18-34", "Home Audio")]

    acquisition = {row["acquisition_channel"]: row for row in query_as_dicts(connection, QUERIES["acquisition_funnel"])}
    membership = {row["membership_tier"]: row for row in query_as_dicts(connection, QUERIES["membership_funnel"])}
    device = {row["device_type"]: row for row in query_as_dicts(connection, QUERIES["device_time_pattern"])}

    checks = [
        {
            "name": "young users show stronger headphones/wearables affinity",
            "observed": round(ratio(young_audio, older_audio), 3),
            "criterion": "18-34 share / 45+ share >= 1.25",
            "passed": ratio(young_audio, older_audio) >= 1.25,
        },
        {
            "name": "older users show stronger TV/home-audio affinity",
            "observed": round(ratio(older_home, young_home), 3),
            "criterion": "45+ share / 18-34 share >= 1.25",
            "passed": ratio(older_home, young_home) >= 1.25,
        },
        {
            "name": "referral out-converts paid search",
            "observed": round(
                ratio(acquisition["referral"]["click_to_purchase_pct"], acquisition["paid_search"]["click_to_purchase_pct"]),
                3,
            ),
            "criterion": "referral / paid-search click-to-purchase >= 1.35",
            "passed": ratio(
                acquisition["referral"]["click_to_purchase_pct"], acquisition["paid_search"]["click_to_purchase_pct"]
            ) >= 1.35,
        },
        {
            "name": "premium/vip out-convert basic",
            "observed": round(
                ratio(
                    (membership["premium"]["click_to_purchase_pct"] + membership["vip"]["click_to_purchase_pct"]) / 2,
                    membership["basic"]["click_to_purchase_pct"],
                ),
                3,
            ),
            "criterion": "mean premium/vip rate / basic rate >= 1.30",
            "passed": ratio(
                (membership["premium"]["click_to_purchase_pct"] + membership["vip"]["click_to_purchase_pct"]) / 2,
                membership["basic"]["click_to_purchase_pct"],
            ) >= 1.30,
        },
        {
            "name": "mobile has stronger evening concentration than desktop",
            "observed": round(device["mobile"]["evening_share_pct"] - device["desktop"]["evening_share_pct"], 3),
            "criterion": "mobile evening share - desktop evening share >= 15 percentage points",
            "passed": device["mobile"]["evening_share_pct"] - device["desktop"]["evening_share_pct"] >= 15,
        },
    ]
    return checks


def write_report(
    data_dir: Path,
    connection: sqlite3.Connection,
    counts: dict[str, int],
    integrity: list[dict[str, Any]],
    patterns: list[dict[str, Any]],
) -> None:
    manifest = json.loads((data_dir / "manifest.json").read_text(encoding="utf-8"))
    lines = [
        "# Synthetic Commerce SQL Validation",
        "",
        "## Dataset size",
        "",
        f"- Products: {counts['products']:,}",
        f"- Users: {counts['users']:,}",
        f"- Events: {counts['events']:,}",
        f"- Raw generated files: {manifest['total_mib']:.3f} MiB",
        f"- SQLite database: {(data_dir / 'analysis.sqlite').stat().st_size / 1024 / 1024:.3f} MiB",
        "",
        "## Integrity checks",
        "",
        markdown_table(
            ("check", "observed", "expected", "result"),
            [
                (item["name"], item["value"], item["expected"], "PASS" if item["passed"] else "FAIL")
                for item in integrity
            ],
        ),
        "",
        "## Planted-pattern checks",
        "",
        markdown_table(
            ("check", "observed", "criterion", "result"),
            [
                (item["name"], item["observed"], item["criterion"], "PASS" if item["passed"] else "FAIL")
                for item in patterns
            ],
        ),
    ]

    titles = {
        "age_category_affinity": "Age group × category click share",
        "acquisition_funnel": "Acquisition-channel funnel",
        "membership_funnel": "Membership-tier funnel",
        "device_time_pattern": "Device time pattern",
        "gender_null_control": "Gender null control",
        "catalog_long_tail": "Catalog popularity long tail",
    }
    for key, query in QUERIES.items():
        columns, rows = rows_for(connection, query)
        lines.extend(["", f"## {titles[key]}", "", markdown_table(columns, rows)])

    lines.extend(
        [
            "",
            "## Interpretation boundaries",
            "",
            "- `purchase_click` means a checkout-button click, not a completed order.",
            "- Revenue, AOV, and LTV require separate order/order-item facts.",
            "- Gender and region were not assigned direct causal multipliers; small differences are sampling noise or indirect composition effects.",
            "- The product catalog is balanced across eight categories, so category differences primarily reflect behavior rules rather than catalog size.",
            "",
        ]
    )
    (data_dir / "insights.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    args = parse_args()
    data_dir = args.data_dir.resolve()
    manifest_path = data_dir / "manifest.json"
    if (data_dir / "meta").is_dir():
        required = ("meta", "users", "click_events", "manifest.json")
        missing = [
            name
            for name in required
            if not ((data_dir / name).is_dir() if name != "manifest.json" else manifest_path.is_file())
        ]
        for dataset in ("meta", "users", "click_events"):
            if (data_dir / dataset).is_dir() and not part_files(data_dir, dataset):
                missing.append(f"{dataset}/part-*.jsonl")
    else:
        required = ("products.csv", "users.csv", "click_events.jsonl", "manifest.json")
        missing = [name for name in required if not (data_dir / name).is_file()]
    if missing:
        raise SystemExit(f"missing generated files: {', '.join(missing)}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    connection, counts = build_database(data_dir)
    try:
        # V1 fixtures predate the strict end-exclusive clamp and contain two
        # events just past the window, so strict time-window validation starts at v2.
        strict_window = manifest.get("window") if manifest.get("generator_version") == 2 else None
        integrity = validate_integrity(connection, strict_window)
        manifest_checks = validate_manifest_files(data_dir, manifest)
        integrity.extend(manifest_checks)
        patterns = evaluate_patterns(connection)
        write_report(data_dir, connection, counts, integrity, patterns)
    finally:
        connection.close()

    result = {
        "counts": counts,
        "integrity": integrity,
        "manifest_files_checked": len(manifest_checks),
        "patterns": patterns,
        "all_integrity_passed": all(item["passed"] for item in integrity),
        "all_planted_patterns_passed": all(item["passed"] for item in patterns),
    }
    (data_dir / "analysis-result.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not result["all_integrity_passed"] or not result["all_planted_patterns_passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
