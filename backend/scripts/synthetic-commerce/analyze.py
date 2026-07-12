#!/usr/bin/env python3
"""Validate and analyze the deterministic synthetic commerce dataset."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any, Iterable, Sequence


SUPPORTED_SCHEMA_VERSION = "1.0"
CANONICAL_EVENTS_FILE = "commerce_events.jsonl"


SCHEMA_SQL = """
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS commerce_events;

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

CREATE TABLE commerce_events (
    event_id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL,
    event_source TEXT NOT NULL,
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    event_time TEXT NOT NULL,
    event_type TEXT NOT NULL,
    product_id TEXT NOT NULL,
    page_url TEXT NOT NULL,
    device_type TEXT NOT NULL,
    referrer TEXT NOT NULL,
    position INTEGER,
    checkout_id TEXT,
    order_id TEXT,
    currency TEXT,
    order_value REAL,
    item_count INTEGER,
    properties_json TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (product_id) REFERENCES products(product_id)
);
"""


SESSION_FUNNEL_CTE = """
WITH session_funnel AS (
  SELECT
    session_id,
    user_id,
    MIN(device_type) AS device_type,
    MAX(CASE WHEN event_type = 'product_impression' THEN 1 ELSE 0 END) AS impression,
    MAX(CASE WHEN event_type = 'product_click' THEN 1 ELSE 0 END) AS click,
    MAX(CASE WHEN event_type = 'add_to_cart' THEN 1 ELSE 0 END) AS cart,
    MAX(CASE WHEN event_type = 'purchase_click' THEN 1 ELSE 0 END) AS purchase_click,
    MAX(CASE WHEN event_type = 'checkout_started' THEN 1 ELSE 0 END) AS checkout_started,
    MAX(CASE WHEN event_type = 'payment_success' THEN 1 ELSE 0 END) AS payment_success,
    MAX(CASE WHEN event_type = 'order_completed' THEN 1 ELSE 0 END) AS order_completed
  FROM commerce_events
  GROUP BY session_id, user_id
)
"""


QUERIES = {
    "conversion_overview": SESSION_FUNNEL_CTE + """
SELECT
  SUM(impression) AS impression_sessions,
  SUM(click) AS click_sessions,
  SUM(cart) AS cart_sessions,
  SUM(purchase_click) AS purchase_click_sessions,
  SUM(checkout_started) AS checkout_started_sessions,
  SUM(payment_success) AS payment_success_sessions,
  SUM(order_completed) AS order_completed_sessions,
  ROUND(100.0 * SUM(order_completed) / NULLIF(SUM(impression), 0), 3)
    AS session_order_conversion_pct,
  ROUND(100.0 * SUM(checkout_started) / NULLIF(SUM(purchase_click), 0), 2)
    AS checkout_entry_pct,
  ROUND(100.0 * SUM(payment_success) / NULLIF(SUM(checkout_started), 0), 2)
    AS payment_success_pct,
  ROUND(100.0 * SUM(order_completed) / NULLIF(SUM(payment_success), 0), 2)
    AS order_confirmation_pct,
  ROUND(100.0 * SUM(order_completed) / NULLIF(SUM(cart), 0), 2)
    AS cart_to_order_pct
FROM session_funnel;
""",
    "acquisition_conversion": SESSION_FUNNEL_CTE + """
SELECT
  u.acquisition_channel,
  SUM(s.impression) AS active_sessions,
  SUM(s.purchase_click) AS purchase_click_sessions,
  SUM(s.order_completed) AS order_completed_sessions,
  ROUND(100.0 * SUM(s.purchase_click) / NULLIF(SUM(s.impression), 0), 2)
    AS purchase_click_proxy_pct,
  ROUND(100.0 * SUM(s.order_completed) / NULLIF(SUM(s.impression), 0), 2)
    AS order_conversion_pct
FROM session_funnel s
JOIN users u ON u.user_id = s.user_id
GROUP BY u.acquisition_channel
ORDER BY order_conversion_pct DESC, active_sessions DESC;
""",
    "membership_conversion": SESSION_FUNNEL_CTE + """
SELECT
  u.membership_tier,
  SUM(s.impression) AS active_sessions,
  SUM(s.purchase_click) AS purchase_click_sessions,
  SUM(s.order_completed) AS order_completed_sessions,
  ROUND(100.0 * SUM(s.purchase_click) / NULLIF(SUM(s.impression), 0), 2)
    AS purchase_click_proxy_pct,
  ROUND(100.0 * SUM(s.order_completed) / NULLIF(SUM(s.impression), 0), 2)
    AS order_conversion_pct
FROM session_funnel s
JOIN users u ON u.user_id = s.user_id
GROUP BY u.membership_tier
ORDER BY order_conversion_pct DESC, active_sessions DESC;
""",
    "device_conversion": SESSION_FUNNEL_CTE + """
SELECT
  device_type,
  SUM(impression) AS active_sessions,
  SUM(checkout_started) AS checkout_started_sessions,
  SUM(payment_success) AS payment_success_sessions,
  SUM(order_completed) AS order_completed_sessions,
  ROUND(100.0 * SUM(order_completed) / NULLIF(SUM(impression), 0), 2)
    AS order_conversion_pct,
  ROUND(100.0 * (SUM(checkout_started) - SUM(order_completed)) /
        NULLIF(SUM(checkout_started), 0), 2) AS checkout_dropoff_pct
FROM session_funnel
GROUP BY device_type
ORDER BY order_conversion_pct DESC;
""",
    "revenue_overview": """
SELECT
  COUNT(*) AS completed_orders,
  ROUND(SUM(order_value), 2) AS gross_order_value,
  ROUND(AVG(order_value), 2) AS average_order_value,
  ROUND(MIN(order_value), 2) AS minimum_order_value,
  ROUND(MAX(order_value), 2) AS maximum_order_value
FROM commerce_events
WHERE event_type = 'order_completed';
""",
    "category_order_performance": """
WITH category_sessions AS (
  SELECT
    p.category,
    e.session_id,
    MAX(CASE WHEN e.event_type = 'product_impression' THEN 1 ELSE 0 END) AS impression,
    MAX(CASE WHEN e.event_type = 'order_completed' THEN 1 ELSE 0 END) AS order_completed,
    SUM(CASE WHEN e.event_type = 'order_completed' THEN e.order_value ELSE 0 END) AS order_value
  FROM commerce_events e
  JOIN products p ON p.product_id = e.product_id
  GROUP BY p.category, e.session_id
)
SELECT
  category,
  SUM(impression) AS impression_sessions,
  SUM(order_completed) AS order_completed_sessions,
  ROUND(100.0 * SUM(order_completed) / NULLIF(SUM(impression), 0), 2)
    AS order_conversion_pct,
  ROUND(SUM(order_value), 2) AS gross_order_value
FROM category_sessions
GROUP BY category
ORDER BY order_conversion_pct DESC, gross_order_value DESC;
""",
    "age_category_affinity": """
WITH clicks AS (
  SELECT
    CASE
      WHEN u.age BETWEEN 18 AND 34 THEN '18-34'
      WHEN u.age BETWEEN 35 AND 44 THEN '35-44'
      ELSE '45+'
    END AS age_group,
    p.category
  FROM commerce_events e
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
    "device_time_pattern": """
SELECT
  device_type,
  COUNT(*) AS events,
  SUM(CASE WHEN CAST(SUBSTR(event_time, 12, 2) AS INTEGER) BETWEEN 18 AND 23
           THEN 1 ELSE 0 END) AS evening_events,
  ROUND(100.0 * SUM(CASE WHEN CAST(SUBSTR(event_time, 12, 2) AS INTEGER)
                              BETWEEN 18 AND 23 THEN 1 ELSE 0 END) / COUNT(*), 2)
    AS evening_share_pct
FROM commerce_events
GROUP BY device_type
ORDER BY evening_share_pct DESC;
""",
    "event_id_uniqueness": """
SELECT
  COUNT(*) AS total_events,
  COUNT(DISTINCT event_id) AS unique_event_ids,
  COUNT(*) - COUNT(DISTINCT event_id) AS duplicate_event_ids
FROM commerce_events;
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


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_products(connection: sqlite3.Connection, path: Path) -> int:
    rows = []
    with path.open("r", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            rows.append(
                (
                    row["product_id"], row["category"], row["leaf_category"], row["title"],
                    row["store"], float(row["price"]), float(row["average_rating"]),
                    int(row["rating_count"]),
                )
            )
    connection.executemany("INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows)
    return len(rows)


def load_users(connection: sqlite3.Connection, path: Path) -> int:
    rows = []
    with path.open("r", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            rows.append(
                (
                    row["user_id"], int(row["age"]), row["gender"], row["region"],
                    row["signup_at"], row["acquisition_channel"], row["membership_tier"],
                    row["primary_device"],
                )
            )
    connection.executemany("INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows)
    return len(rows)


def event_batches(path: Path, batch_size: int = 10_000) -> Iterable[list[tuple[Any, ...]]]:
    required = {
        "event_id", "schema_version", "event_source", "user_id", "session_id",
        "event_time", "event_type", "product_id", "page_url", "device_type",
        "referrer", "properties",
    }
    batch: list[tuple[Any, ...]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"malformed JSON at line {line_number}: {error.msg}") from error
            if not isinstance(row, dict):
                raise ValueError(f"event line {line_number} must be a JSON object")
            missing = sorted(required - set(row))
            if missing:
                raise ValueError(f"event line {line_number} missing required keys: {', '.join(missing)}")
            if row["schema_version"] != SUPPORTED_SCHEMA_VERSION:
                raise ValueError(
                    f"unsupported schema_version at line {line_number}: {row['schema_version']}"
                )
            properties = row["properties"]
            if not isinstance(properties, dict):
                raise ValueError(f"event line {line_number} properties must be an object")
            batch.append(
                (
                    row["event_id"], row["schema_version"], row["event_source"],
                    row["user_id"], row["session_id"], row["event_time"], row["event_type"],
                    row["product_id"], row["page_url"], row["device_type"], row["referrer"],
                    properties.get("position"), properties.get("checkout_id"),
                    properties.get("order_id"), properties.get("currency"),
                    properties.get("order_value"), properties.get("item_count"),
                    json.dumps(properties, ensure_ascii=False, sort_keys=True),
                )
            )
            if len(batch) >= batch_size:
                yield batch
                batch = []
    if batch:
        yield batch


def load_events(connection: sqlite3.Connection, path: Path) -> int:
    count = 0
    placeholders = ", ".join("?" for _ in range(18))
    for batch in event_batches(path):
        connection.executemany(f"INSERT INTO commerce_events VALUES ({placeholders})", batch)
        count += len(batch)
    return count


def build_database(data_dir: Path) -> tuple[sqlite3.Connection, dict[str, int]]:
    database_path = data_dir / "analysis.sqlite"
    if database_path.exists():
        database_path.unlink()
    connection = sqlite3.connect(database_path)
    connection.execute("PRAGMA foreign_keys = ON")
    connection.executescript(SCHEMA_SQL)
    counts = {
        "products": load_products(connection, data_dir / "products.csv"),
        "users": load_users(connection, data_dir / "users.csv"),
        "events": load_events(connection, data_dir / CANONICAL_EVENTS_FILE),
    }
    connection.executescript(
        """
        CREATE INDEX idx_events_user ON commerce_events(user_id);
        CREATE INDEX idx_events_product ON commerce_events(product_id);
        CREATE INDEX idx_events_session_time ON commerce_events(session_id, event_time);
        CREATE INDEX idx_events_checkout_time ON commerce_events(checkout_id, event_time);
        CREATE INDEX idx_events_type ON commerce_events(event_type);
        """
    )
    connection.commit()
    return connection, counts


def rows_for(connection: sqlite3.Connection, query: str) -> tuple[list[str], list[tuple[Any, ...]]]:
    cursor = connection.execute(query)
    columns = [description[0] for description in cursor.description]
    return columns, cursor.fetchall()


def query_as_dicts(connection: sqlite3.Connection, query: str) -> list[dict[str, Any]]:
    cursor = connection.execute(query)
    columns = [description[0] for description in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def scalar(connection: sqlite3.Connection, query: str, parameters: Sequence[Any] = ()) -> Any:
    return connection.execute(query, parameters).fetchone()[0]


def check(name: str, observed: Any, criterion: str, passed: bool) -> dict[str, Any]:
    return {"name": name, "observed": observed, "criterion": criterion, "passed": passed}


def validate_integrity(
    connection: sqlite3.Connection,
    data_dir: Path,
    manifest: dict[str, Any],
    counts: dict[str, int],
) -> list[dict[str, Any]]:
    events_path = data_dir / CANONICAL_EVENTS_FILE
    checks = [
        check(
            "manifest commerce event hash",
            sha256_file(events_path),
            manifest["files"][CANONICAL_EVENTS_FILE]["sha256"],
            sha256_file(events_path) == manifest["files"][CANONICAL_EVENTS_FILE]["sha256"],
        ),
        check(
            "manifest row counts",
            counts,
            "products/users/events equal manifest counts",
            counts["products"] == manifest["counts"]["products"]
            and counts["users"] == manifest["counts"]["users"]
            and counts["events"] == manifest["counts"]["event_count"],
        ),
        check(
            "event_id uniqueness",
            scalar(connection, "SELECT COUNT(*) - COUNT(DISTINCT event_id) FROM commerce_events"),
            "0 duplicates",
            scalar(connection, "SELECT COUNT(*) - COUNT(DISTINCT event_id) FROM commerce_events") == 0,
        ),
        check(
            "events before user signup",
            scalar(connection, """
                SELECT COUNT(*) FROM commerce_events e
                JOIN users u ON u.user_id = e.user_id
                WHERE e.event_time < u.signup_at
            """),
            "0 events",
            scalar(connection, """
                SELECT COUNT(*) FROM commerce_events e
                JOIN users u ON u.user_id = e.user_id
                WHERE e.event_time < u.signup_at
            """) == 0,
        ),
        check(
            "events outside manifest window",
            scalar(
                connection,
                "SELECT COUNT(*) FROM commerce_events WHERE event_time >= ?",
                (manifest["window"]["end_exclusive"],),
            ),
            "0 events",
            scalar(
                connection,
                "SELECT COUNT(*) FROM commerce_events WHERE event_time >= ?",
                (manifest["window"]["end_exclusive"],),
            ) == 0,
        ),
        check(
            "event source mapping",
            scalar(connection, """
                SELECT COUNT(*) FROM commerce_events
                WHERE event_source <> CASE event_type
                  WHEN 'product_impression' THEN 'web_client'
                  WHEN 'product_click' THEN 'web_client'
                  WHEN 'add_to_cart' THEN 'web_client'
                  WHEN 'purchase_click' THEN 'web_client'
                  WHEN 'checkout_started' THEN 'checkout_service'
                  WHEN 'payment_success' THEN 'payment_service'
                  WHEN 'order_completed' THEN 'order_service'
                  ELSE '__unsupported__' END
            """),
            "0 mismatches",
            scalar(connection, """
                SELECT COUNT(*) FROM commerce_events
                WHERE event_source <> CASE event_type
                  WHEN 'product_impression' THEN 'web_client'
                  WHEN 'product_click' THEN 'web_client'
                  WHEN 'add_to_cart' THEN 'web_client'
                  WHEN 'purchase_click' THEN 'web_client'
                  WHEN 'checkout_started' THEN 'checkout_service'
                  WHEN 'payment_success' THEN 'payment_service'
                  WHEN 'order_completed' THEN 'order_service'
                  ELSE '__unsupported__' END
            """) == 0,
        ),
        check(
            "purchase funnel required properties",
            scalar(connection, """
                SELECT COUNT(*) FROM commerce_events
                WHERE event_type IN ('purchase_click','checkout_started','payment_success','order_completed')
                  AND (checkout_id IS NULL OR TRIM(checkout_id) = '' OR currency <> 'USD'
                       OR order_value IS NULL OR typeof(order_value) NOT IN ('real','integer')
                       OR order_value <= 0 OR item_count IS NULL
                       OR typeof(item_count) <> 'integer' OR item_count <> 1)
            """),
            "0 invalid events",
            scalar(connection, """
                SELECT COUNT(*) FROM commerce_events
                WHERE event_type IN ('purchase_click','checkout_started','payment_success','order_completed')
                  AND (checkout_id IS NULL OR TRIM(checkout_id) = '' OR currency <> 'USD'
                       OR order_value IS NULL OR typeof(order_value) NOT IN ('real','integer')
                       OR order_value <= 0 OR item_count IS NULL
                       OR typeof(item_count) <> 'integer' OR item_count <> 1)
            """) == 0,
        ),
        check(
            "order_id nullability",
            scalar(connection, """
                SELECT COUNT(*) FROM commerce_events
                WHERE (event_type = 'order_completed' AND (order_id IS NULL OR TRIM(order_id) = ''))
                   OR (event_type <> 'order_completed' AND order_id IS NOT NULL)
            """),
            "order_id only exists on completed orders",
            scalar(connection, """
                SELECT COUNT(*) FROM commerce_events
                WHERE (event_type = 'order_completed' AND (order_id IS NULL OR TRIM(order_id) = ''))
                   OR (event_type <> 'order_completed' AND order_id IS NOT NULL)
            """) == 0,
        ),
        check(
            "checkout identity stays in one session",
            scalar(connection, """
                SELECT COUNT(*) FROM (
                  SELECT checkout_id FROM commerce_events
                  WHERE checkout_id IS NOT NULL
                  GROUP BY checkout_id HAVING COUNT(DISTINCT session_id) > 1
                )
            """),
            "0 mixed checkout IDs",
            scalar(connection, """
                SELECT COUNT(*) FROM (
                  SELECT checkout_id FROM commerce_events
                  WHERE checkout_id IS NOT NULL
                  GROUP BY checkout_id HAVING COUNT(DISTINCT session_id) > 1
                )
            """) == 0,
        ),
        check(
            "checkout properties stay consistent",
            scalar(connection, """
                SELECT COUNT(*) FROM (
                  SELECT checkout_id FROM commerce_events
                  WHERE checkout_id IS NOT NULL
                  GROUP BY checkout_id
                  HAVING COUNT(DISTINCT currency) > 1
                     OR COUNT(DISTINCT order_value) > 1
                     OR COUNT(DISTINCT item_count) > 1
                )
            """),
            "0 inconsistent checkouts",
            scalar(connection, """
                SELECT COUNT(*) FROM (
                  SELECT checkout_id FROM commerce_events
                  WHERE checkout_id IS NOT NULL
                  GROUP BY checkout_id
                  HAVING COUNT(DISTINCT currency) > 1
                     OR COUNT(DISTINCT order_value) > 1
                     OR COUNT(DISTINCT item_count) > 1
                )
            """) == 0,
        ),
        check(
            "order_id uniqueness",
            scalar(connection, """
                SELECT COUNT(*) FROM (
                  SELECT order_id FROM commerce_events
                  WHERE order_id IS NOT NULL
                  GROUP BY order_id HAVING COUNT(*) > 1
                )
            """),
            "0 duplicate order IDs",
            scalar(connection, """
                SELECT COUNT(*) FROM (
                  SELECT order_id FROM commerce_events
                  WHERE order_id IS NOT NULL
                  GROUP BY order_id HAVING COUNT(*) > 1
                )
            """) == 0,
        ),
    ]

    predecessor_rules = (
        ("add_to_cart", "product_click", False),
        ("purchase_click", "add_to_cart", False),
        ("checkout_started", "purchase_click", True),
        ("payment_success", "checkout_started", True),
        ("order_completed", "payment_success", True),
    )
    for event_type, predecessor, require_checkout in predecessor_rules:
        checkout_clause = "AND previous.checkout_id = current.checkout_id" if require_checkout else ""
        query = f"""
            SELECT COUNT(*) FROM commerce_events current
            WHERE current.event_type = ?
              AND NOT EXISTS (
                SELECT 1 FROM commerce_events previous
                WHERE previous.session_id = current.session_id
                  AND previous.product_id = current.product_id
                  AND previous.event_type = ?
                  AND previous.event_time < current.event_time
                  {checkout_clause}
              )
        """
        violations = scalar(connection, query, (event_type, predecessor))
        checks.append(
            check(
                f"{event_type} has prior {predecessor}",
                violations,
                "0 missing predecessors",
                violations == 0,
            )
        )
    return checks


def validate_funnel(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    event_counts = {
        row[0]: row[1]
        for row in connection.execute(
            "SELECT event_type, COUNT(*) FROM commerce_events GROUP BY event_type"
        )
    }
    session_counts = {
        row[0]: row[1]
        for row in connection.execute(
            "SELECT event_type, COUNT(DISTINCT session_id) FROM commerce_events GROUP BY event_type"
        )
    }
    order = (
        "product_impression", "product_click", "add_to_cart", "purchase_click",
        "checkout_started", "payment_success", "order_completed",
    )
    event_monotonic = all(event_counts.get(right, 0) <= event_counts.get(left, 0) for left, right in zip(order, order[1:]))
    session_monotonic = all(session_counts.get(right, 0) <= session_counts.get(left, 0) for left, right in zip(order, order[1:]))
    impression_sessions = session_counts.get("product_impression", 0)
    completed_sessions = session_counts.get("order_completed", 0)
    conversion = 100.0 * completed_sessions / impression_sessions if impression_sessions else 0.0
    return [
        check("event funnel is monotonic", event_counts, "every stage <= previous stage", event_monotonic),
        check("session funnel is monotonic", session_counts, "every stage <= previous stage", session_monotonic),
        check(
            "session order conversion",
            round(conversion, 3),
            "between 1.0% and 3.0%",
            1.0 <= conversion <= 3.0,
        ),
    ]


def ratio(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator else 0.0


def evaluate_patterns(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    age_rows = query_as_dicts(connection, QUERIES["age_category_affinity"])
    shares = {(row["age_group"], row["category"]): row["click_share_pct"] for row in age_rows}
    young_audio = shares[("18-34", "Headphones, Earbuds & Accessories")] + shares[("18-34", "Wearable Technology")]
    older_audio = shares[("45+", "Headphones, Earbuds & Accessories")] + shares[("45+", "Wearable Technology")]
    older_home = shares[("45+", "Television & Video")] + shares[("45+", "Home Audio")]
    young_home = shares[("18-34", "Television & Video")] + shares[("18-34", "Home Audio")]

    acquisition = {
        row["acquisition_channel"]: row
        for row in query_as_dicts(connection, QUERIES["acquisition_conversion"])
    }
    membership = {
        row["membership_tier"]: row
        for row in query_as_dicts(connection, QUERIES["membership_conversion"])
    }
    device = {
        row["device_type"]: row
        for row in query_as_dicts(connection, QUERIES["device_time_pattern"])
    }
    premium_vip_rate = 100.0 * (
        membership["premium"]["order_completed_sessions"]
        + membership["vip"]["order_completed_sessions"]
    ) / (
        membership["premium"]["active_sessions"] + membership["vip"]["active_sessions"]
    )
    checks = [
        check(
            "young users favor headphones and wearables",
            round(ratio(young_audio, older_audio), 3),
            "18-34 share / 45+ share >= 1.25",
            ratio(young_audio, older_audio) >= 1.25,
        ),
        check(
            "older users favor TV and home audio",
            round(ratio(older_home, young_home), 3),
            "45+ share / 18-34 share >= 1.25",
            ratio(older_home, young_home) >= 1.25,
        ),
        check(
            "referral order conversion beats paid search",
            round(
                ratio(
                    acquisition["referral"]["order_conversion_pct"],
                    acquisition["paid_search"]["order_conversion_pct"],
                ),
                3,
            ),
            "referral / paid-search order conversion >= 1.05",
            ratio(
                acquisition["referral"]["order_conversion_pct"],
                acquisition["paid_search"]["order_conversion_pct"],
            ) >= 1.05,
        ),
        check(
            "premium and VIP order conversion beats basic",
            round(ratio(premium_vip_rate, membership["basic"]["order_conversion_pct"]), 3),
            "premium+VIP / basic order conversion >= 1.15",
            ratio(premium_vip_rate, membership["basic"]["order_conversion_pct"]) >= 1.15,
        ),
        check(
            "mobile events concentrate in the evening",
            round(device["mobile"]["evening_share_pct"] - device["desktop"]["evening_share_pct"], 3),
            "mobile - desktop evening share >= 15 percentage points",
            device["mobile"]["evening_share_pct"] - device["desktop"]["evening_share_pct"] >= 15,
        ),
    ]
    return checks


def build_headline_insights(connection: sqlite3.Connection) -> dict[str, Any]:
    overview = query_as_dicts(connection, QUERIES["conversion_overview"])[0]
    revenue = query_as_dicts(connection, QUERIES["revenue_overview"])[0]
    acquisition = {
        row["acquisition_channel"]: row
        for row in query_as_dicts(connection, QUERIES["acquisition_conversion"])
    }
    membership = {
        row["membership_tier"]: row
        for row in query_as_dicts(connection, QUERIES["membership_conversion"])
    }
    category = query_as_dicts(connection, QUERIES["category_order_performance"])
    premium_vip_rate = 100.0 * (
        membership["premium"]["order_completed_sessions"]
        + membership["vip"]["order_completed_sessions"]
    ) / (
        membership["premium"]["active_sessions"] + membership["vip"]["active_sessions"]
    )
    return {
        "session_order_conversion_pct": overview["session_order_conversion_pct"],
        "checkout_entry_pct": overview["checkout_entry_pct"],
        "payment_success_pct": overview["payment_success_pct"],
        "order_confirmation_pct": overview["order_confirmation_pct"],
        "completed_orders": revenue["completed_orders"],
        "gross_order_value": revenue["gross_order_value"],
        "average_order_value": revenue["average_order_value"],
        "referral_order_conversion_pct": acquisition["referral"]["order_conversion_pct"],
        "paid_search_order_conversion_pct": acquisition["paid_search"]["order_conversion_pct"],
        "premium_vip_order_conversion_pct": round(premium_vip_rate, 2),
        "basic_order_conversion_pct": membership["basic"]["order_conversion_pct"],
        "highest_converting_category": category[0],
    }


def write_report(
    data_dir: Path,
    connection: sqlite3.Connection,
    counts: dict[str, int],
    integrity: list[dict[str, Any]],
    funnel: list[dict[str, Any]],
    patterns: list[dict[str, Any]],
    headline: dict[str, Any],
) -> None:
    manifest = json.loads((data_dir / "manifest.json").read_text(encoding="utf-8"))
    lines = [
        "# Synthetic Commerce Analysis",
        "",
        "## Headline insights",
        "",
        f"- Session order conversion: {headline['session_order_conversion_pct']:.3f}%",
        f"- Checkout entry / payment success / order confirmation: "
        f"{headline['checkout_entry_pct']:.2f}% / {headline['payment_success_pct']:.2f}% / "
        f"{headline['order_confirmation_pct']:.2f}%",
        f"- Completed orders: {headline['completed_orders']:,}",
        f"- Gross order value / average order value: "
        f"USD {headline['gross_order_value']:,.2f} / USD {headline['average_order_value']:,.2f}",
        f"- Referral versus paid-search order conversion: "
        f"{headline['referral_order_conversion_pct']:.2f}% / "
        f"{headline['paid_search_order_conversion_pct']:.2f}%",
        f"- Premium+VIP versus basic order conversion: "
        f"{headline['premium_vip_order_conversion_pct']:.2f}% / "
        f"{headline['basic_order_conversion_pct']:.2f}%",
        f"- Highest-converting category: "
        f"{headline['highest_converting_category']['category']} "
        f"({headline['highest_converting_category']['order_conversion_pct']:.2f}%)",
        "",
        "## Dataset size",
        "",
        f"- Products: {counts['products']:,}",
        f"- Users: {counts['users']:,}",
        f"- Events: {counts['events']:,}",
        f"- Raw generated files: {manifest['total_mib']:.3f} MiB",
        f"- SQLite database: {(data_dir / 'analysis.sqlite').stat().st_size / 1024 / 1024:.3f} MiB",
    ]

    for title, checks in (
        ("Integrity checks", integrity),
        ("Funnel checks", funnel),
        ("Planted-pattern checks", patterns),
    ):
        lines.extend(
            [
                "",
                f"## {title}",
                "",
                markdown_table(
                    ("check", "observed", "criterion", "result"),
                    [
                        (
                            item["name"], item["observed"], item["criterion"],
                            "PASS" if item["passed"] else "FAIL",
                        )
                        for item in checks
                    ],
                ),
            ]
        )

    titles = {
        "conversion_overview": "Session conversion overview",
        "acquisition_conversion": "Acquisition channel conversion",
        "membership_conversion": "Membership tier conversion",
        "device_conversion": "Device conversion and checkout drop-off",
        "revenue_overview": "Completed-order value",
        "category_order_performance": "Category order performance",
        "age_category_affinity": "Age group and category click affinity",
        "device_time_pattern": "Device time pattern",
        "event_id_uniqueness": "Event ID uniqueness",
    }
    for key, query in QUERIES.items():
        columns, rows = rows_for(connection, query)
        lines.extend(["", f"## {titles[key]}", "", markdown_table(columns, rows)])

    lines.extend(
        [
            "",
            "## Interpretation boundaries",
            "",
            "- `purchase_click` is a checkout-button proxy, not a completed purchase.",
            "- Purchase conversion and order value use only `order_completed` server events.",
            "- V1 models one product and one item per order; multi-item baskets, refunds, and cancellations are excluded.",
            "- Segment differences are deterministic planted signals for SQL validation, not causal business conclusions.",
            "",
        ]
    )
    (data_dir / "insights.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    args = parse_args()
    data_dir = args.data_dir.resolve()
    required = ("products.csv", "users.csv", CANONICAL_EVENTS_FILE, "manifest.json")
    missing = [name for name in required if not (data_dir / name).is_file()]
    if missing:
        raise SystemExit(f"missing generated files: {', '.join(missing)}")

    manifest = json.loads((data_dir / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("event_schema_version") != SUPPORTED_SCHEMA_VERSION:
        raise SystemExit(
            f"unsupported manifest event_schema_version: {manifest.get('event_schema_version')}"
        )

    try:
        connection, counts = build_database(data_dir)
    except (ValueError, sqlite3.IntegrityError) as error:
        raise SystemExit(f"analysis input error: {error}") from error

    try:
        integrity = validate_integrity(connection, data_dir, manifest, counts)
        funnel = validate_funnel(connection)
        patterns = evaluate_patterns(connection)
        headline = build_headline_insights(connection)
        query_results = {key: query_as_dicts(connection, query) for key, query in QUERIES.items()}
        write_report(data_dir, connection, counts, integrity, funnel, patterns, headline)
    finally:
        connection.close()

    result = {
        "counts": counts,
        "headline_insights": headline,
        "integrity": integrity,
        "funnel": funnel,
        "patterns": patterns,
        "queries": query_results,
        "all_integrity_passed": all(item["passed"] for item in integrity),
        "all_funnel_checks_passed": all(item["passed"] for item in funnel),
        "all_planted_patterns_passed": all(item["passed"] for item in patterns),
    }
    (data_dir / "analysis-result.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not (
        result["all_integrity_passed"]
        and result["all_funnel_checks_passed"]
        and result["all_planted_patterns_passed"]
    ):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
