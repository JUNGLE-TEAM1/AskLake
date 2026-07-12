#!/usr/bin/env python3
"""Load the canonical synthetic-commerce fixture into a PostgreSQL source schema."""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
from pathlib import Path
from typing import Any

import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb


BACKEND_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DATA_DIR = BACKEND_DIR / "fixtures" / "synthetic-commerce"
DEFAULT_SCHEMA = "synthetic_commerce"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    parser.add_argument(
        "--database-url",
        default=os.environ.get(
            "ASKLAKE_SOURCE_POSTGRES_URL",
            "postgresql://asklake:asklake@127.0.0.1:15432/asklake_sources",
        ),
    )
    parser.add_argument("--schema", default=os.environ.get("ASKLAKE_SYNTHETIC_COMMERCE_SCHEMA", DEFAULT_SCHEMA))
    return parser.parse_args()


def require_schema_name(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", value):
        raise SystemExit(f"invalid schema name: {value}")
    return value


def create_schema(cursor: psycopg.Cursor[Any], schema_name: str) -> None:
    schema = sql.Identifier(schema_name)
    cursor.execute(sql.SQL("CREATE SCHEMA IF NOT EXISTS {}").format(schema))
    cursor.execute(
        sql.SQL(
            """
            CREATE TABLE IF NOT EXISTS {}.products (
              product_id text PRIMARY KEY,
              category text NOT NULL,
              leaf_category text NOT NULL,
              title text NOT NULL,
              store text NOT NULL,
              price numeric(14, 2) NOT NULL CHECK (price > 0),
              average_rating numeric(4, 2) NOT NULL,
              rating_count integer NOT NULL CHECK (rating_count >= 0)
            );

            CREATE TABLE IF NOT EXISTS {}.users (
              user_id text PRIMARY KEY,
              age integer NOT NULL CHECK (age BETWEEN 0 AND 120),
              gender text NOT NULL,
              region text NOT NULL,
              signup_at timestamptz NOT NULL,
              acquisition_channel text NOT NULL,
              membership_tier text NOT NULL,
              primary_device text NOT NULL
            );

            CREATE TABLE IF NOT EXISTS {}.commerce_events (
              event_id text PRIMARY KEY,
              schema_version text NOT NULL,
              event_source text NOT NULL,
              user_id text NOT NULL REFERENCES {}.users(user_id),
              session_id text NOT NULL,
              event_time timestamptz NOT NULL,
              event_type text NOT NULL CHECK (event_type IN (
                'product_impression', 'product_click', 'add_to_cart', 'purchase_click',
                'checkout_started', 'payment_success', 'order_completed'
              )),
              product_id text NOT NULL REFERENCES {}.products(product_id),
              page_url text NOT NULL,
              device_type text NOT NULL,
              referrer text NOT NULL,
              position integer,
              checkout_id text,
              order_id text,
              currency text,
              order_value numeric(14, 2),
              item_count integer,
              properties jsonb NOT NULL,
              CHECK (order_value IS NULL OR order_value > 0),
              CHECK (item_count IS NULL OR item_count > 0),
              CHECK ((event_type = 'order_completed') = (order_id IS NOT NULL))
            );
            """
        ).format(schema, schema, schema, schema, schema)
    )
    cursor.execute(
        sql.SQL(
            """
            CREATE INDEX IF NOT EXISTS commerce_events_event_time_idx ON {}.commerce_events(event_time);
            CREATE INDEX IF NOT EXISTS commerce_events_event_type_idx ON {}.commerce_events(event_type);
            CREATE INDEX IF NOT EXISTS commerce_events_session_idx ON {}.commerce_events(session_id, event_time);
            CREATE INDEX IF NOT EXISTS commerce_events_user_idx ON {}.commerce_events(user_id, event_time);
            CREATE INDEX IF NOT EXISTS commerce_events_product_idx ON {}.commerce_events(product_id, event_time);
            CREATE INDEX IF NOT EXISTS commerce_events_checkout_idx ON {}.commerce_events(checkout_id) WHERE checkout_id IS NOT NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS commerce_events_order_idx ON {}.commerce_events(order_id) WHERE order_id IS NOT NULL;
            """
        ).format(schema, schema, schema, schema, schema, schema, schema)
    )


def reset_tables(cursor: psycopg.Cursor[Any], schema_name: str) -> None:
    schema = sql.Identifier(schema_name)
    cursor.execute(
        sql.SQL("TRUNCATE TABLE {}.commerce_events, {}.users, {}.products").format(
            schema, schema, schema
        )
    )


def copy_csv_table(
    cursor: psycopg.Cursor[Any],
    schema_name: str,
    table_name: str,
    columns: tuple[str, ...],
    source_path: Path,
) -> int:
    with source_path.open("r", encoding="utf-8", newline="") as source:
        row_count = sum(1 for _ in csv.DictReader(source))
    statement = sql.SQL("COPY {}.{} ({}) FROM STDIN WITH (FORMAT CSV, HEADER TRUE)").format(
        sql.Identifier(schema_name),
        sql.Identifier(table_name),
        sql.SQL(", ").join(sql.Identifier(column) for column in columns),
    )
    with cursor.copy(statement) as copy:
        with source_path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                copy.write(chunk)
    return row_count


def copy_commerce_events(
    cursor: psycopg.Cursor[Any], schema_name: str, source_path: Path
) -> int:
    columns = (
        "event_id",
        "schema_version",
        "event_source",
        "user_id",
        "session_id",
        "event_time",
        "event_type",
        "product_id",
        "page_url",
        "device_type",
        "referrer",
        "position",
        "checkout_id",
        "order_id",
        "currency",
        "order_value",
        "item_count",
        "properties",
    )
    statement = sql.SQL("COPY {}.{} ({}) FROM STDIN").format(
        sql.Identifier(schema_name),
        sql.Identifier("commerce_events"),
        sql.SQL(", ").join(sql.Identifier(column) for column in columns),
    )
    row_count = 0
    with cursor.copy(statement) as copy:
        with source_path.open("r", encoding="utf-8") as source:
            for line_number, line in enumerate(source, start=1):
                if not line.strip():
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError as error:
                    raise ValueError(f"malformed commerce event at line {line_number}: {error}") from error
                properties = event.get("properties") or {}
                copy.write_row(
                    (
                        event["event_id"],
                        event["schema_version"],
                        event["event_source"],
                        event["user_id"],
                        event["session_id"],
                        event["event_time"],
                        event["event_type"],
                        event["product_id"],
                        event["page_url"],
                        event["device_type"],
                        event["referrer"],
                        properties.get("position"),
                        properties.get("checkout_id"),
                        properties.get("order_id"),
                        properties.get("currency"),
                        properties.get("order_value"),
                        properties.get("item_count"),
                        Jsonb(properties),
                    )
                )
                row_count += 1
    return row_count


def create_analysis_views(cursor: psycopg.Cursor[Any], schema_name: str) -> None:
    schema = sql.Identifier(schema_name)
    cursor.execute(
        sql.SQL(
            """
            CREATE OR REPLACE VIEW {}.session_funnel AS
            SELECT
              session_id,
              min(user_id) AS user_id,
              min(device_type) AS device_type,
              min(event_time) AS session_started_at,
              max(event_time) AS session_ended_at,
              bool_or(event_type = 'product_impression') AS product_impression,
              bool_or(event_type = 'product_click') AS product_click,
              bool_or(event_type = 'add_to_cart') AS add_to_cart,
              bool_or(event_type = 'purchase_click') AS purchase_click,
              bool_or(event_type = 'checkout_started') AS checkout_started,
              bool_or(event_type = 'payment_success') AS payment_success,
              bool_or(event_type = 'order_completed') AS order_completed,
              coalesce(sum(order_value) FILTER (WHERE event_type = 'order_completed'), 0) AS completed_order_value
            FROM {}.commerce_events
            GROUP BY session_id;

            CREATE OR REPLACE VIEW {}.order_facts AS
            SELECT
              e.order_id,
              e.checkout_id,
              e.event_time AS ordered_at,
              e.session_id,
              e.user_id,
              u.age,
              u.gender,
              u.region,
              u.acquisition_channel,
              u.membership_tier,
              u.primary_device,
              e.product_id,
              p.category,
              p.leaf_category,
              p.title AS product_title,
              p.store,
              p.price AS product_price,
              e.currency,
              e.order_value,
              e.item_count
            FROM {}.commerce_events e
            JOIN {}.users u ON u.user_id = e.user_id
            JOIN {}.products p ON p.product_id = e.product_id
            WHERE e.event_type = 'order_completed';
            """
        ).format(schema, schema, schema, schema, schema, schema)
    )


def scalar(cursor: psycopg.Cursor[Any], statement: sql.Composed | str) -> Any:
    cursor.execute(statement)
    row = cursor.fetchone()
    return row[0] if row else None


def validate_loaded_data(
    cursor: psycopg.Cursor[Any], schema_name: str, manifest: dict[str, Any]
) -> dict[str, Any]:
    schema = sql.Identifier(schema_name)
    products = scalar(cursor, sql.SQL("SELECT count(*) FROM {}.products").format(schema))
    users = scalar(cursor, sql.SQL("SELECT count(*) FROM {}.users").format(schema))
    events = scalar(cursor, sql.SQL("SELECT count(*) FROM {}.commerce_events").format(schema))
    completed_orders = scalar(
        cursor,
        sql.SQL("SELECT count(*) FROM {}.commerce_events WHERE event_type = 'order_completed'").format(schema),
    )
    order_facts = scalar(cursor, sql.SQL("SELECT count(*) FROM {}.order_facts").format(schema))
    cursor.execute(
        sql.SQL(
            """
            SELECT round(
              100.0 * count(*) FILTER (WHERE order_completed)
              / nullif(count(*) FILTER (WHERE product_impression), 0),
              3
            )
            FROM {}.session_funnel
            """
        ).format(schema)
    )
    conversion = cursor.fetchone()[0]

    expected = manifest["counts"]
    expected_event_types = expected["event_type_counts"]
    checks = {
        "products": (products, expected["products"]),
        "users": (users, expected["users"]),
        "events": (events, expected["event_count"]),
        "completed_orders": (completed_orders, expected_event_types["order_completed"]),
        "order_facts": (order_facts, expected_event_types["order_completed"]),
    }
    failures = [name for name, (actual, wanted) in checks.items() if actual != wanted]
    if failures:
        raise RuntimeError(f"loaded row counts do not match manifest: {failures}")
    expected_conversion = float(expected["order_completed_session_conversion_pct"])
    if abs(float(conversion) - expected_conversion) > 0.001:
        raise RuntimeError(
            f"session conversion mismatch: actual={conversion}, expected={expected_conversion}"
        )
    return {
        "completedOrders": completed_orders,
        "events": events,
        "orderFacts": order_facts,
        "products": products,
        "schema": schema_name,
        "sessionOrderConversionPct": float(conversion),
        "users": users,
    }


def main() -> None:
    args = parse_args()
    schema_name = require_schema_name(args.schema)
    data_dir = args.data_dir.resolve()
    required = ("products.csv", "users.csv", "commerce_events.jsonl", "manifest.json")
    missing = [name for name in required if not (data_dir / name).is_file()]
    if missing:
        raise SystemExit(f"missing synthetic-commerce files: {', '.join(missing)}")
    manifest = json.loads((data_dir / "manifest.json").read_text(encoding="utf-8"))

    with psycopg.connect(args.database_url) as connection:
        with connection.cursor() as cursor:
            create_schema(cursor, schema_name)
            reset_tables(cursor, schema_name)
            product_count = copy_csv_table(
                cursor,
                schema_name,
                "products",
                (
                    "product_id",
                    "category",
                    "leaf_category",
                    "title",
                    "store",
                    "price",
                    "average_rating",
                    "rating_count",
                ),
                data_dir / "products.csv",
            )
            user_count = copy_csv_table(
                cursor,
                schema_name,
                "users",
                (
                    "user_id",
                    "age",
                    "gender",
                    "region",
                    "signup_at",
                    "acquisition_channel",
                    "membership_tier",
                    "primary_device",
                ),
                data_dir / "users.csv",
            )
            event_count = copy_commerce_events(
                cursor, schema_name, data_dir / "commerce_events.jsonl"
            )
            create_analysis_views(cursor, schema_name)
            summary = validate_loaded_data(cursor, schema_name, manifest)
            summary["copied"] = {
                "commerceEvents": event_count,
                "products": product_count,
                "users": user_count,
            }
    print(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
