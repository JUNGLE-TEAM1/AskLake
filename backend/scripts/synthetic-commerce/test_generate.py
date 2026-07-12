#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
import sqlite3
import sys
import tempfile
import unittest
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("generate.py")
SPEC = importlib.util.spec_from_file_location("synthetic_generate", MODULE_PATH)
assert SPEC and SPEC.loader
generate = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = generate
SPEC.loader.exec_module(generate)

ANALYZE_MODULE_PATH = Path(__file__).with_name("analyze.py")
ANALYZE_SPEC = importlib.util.spec_from_file_location("synthetic_analyze", ANALYZE_MODULE_PATH)
assert ANALYZE_SPEC and ANALYZE_SPEC.loader
analyze = importlib.util.module_from_spec(ANALYZE_SPEC)
sys.modules[ANALYZE_SPEC.name] = analyze
ANALYZE_SPEC.loader.exec_module(analyze)


def sample_products() -> list:
    products = []
    for category_index, category in enumerate(generate.TARGET_CATEGORIES):
        for product_index in range(10):
            products.append(
                generate.Product(
                    product_id=f"P-{category_index:02d}-{product_index:03d}",
                    category=category,
                    leaf_category=f"leaf-{category_index}",
                    title=f"Product {category_index}-{product_index}",
                    store="Synthetic",
                    price=20.0 + product_index * 10,
                    average_rating=3.5 + (product_index % 4) * 0.4,
                    rating_count=10 + product_index * 20,
                    price_percentile=product_index / 9,
                )
            )
    return products


class GeneratorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.start = datetime(2026, 6, 1, tzinfo=generate.KST)
        self.end = self.start + timedelta(days=30)

    def test_user_generation_is_deterministic_and_hides_traits(self) -> None:
        first = generate.generate_users(100, 1234, self.start, self.end)
        second = generate.generate_users(100, 1234, self.start, self.end)
        self.assertEqual([profile.public for profile in first], [profile.public for profile in second])
        self.assertEqual(
            [profile.category_weights for profile in first],
            [profile.category_weights for profile in second],
        )
        self.assertEqual(set(first[0].public), set(generate.USER_COLUMNS))
        self.assertNotIn("activity_tier", first[0].public)
        self.assertAlmostEqual(sum(first[0].category_weights.values()), 1.0)

    def test_events_keep_referential_and_funnel_order(self) -> None:
        profiles = generate.generate_users(120, 5678, self.start, self.end)
        products = sample_products()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "events.jsonl"
            stats = generate.generate_events(profiles, products, output, 5678, self.start, self.end)
            self.assertGreater(stats["event_count"], 0)

            user_ids = {profile.public["user_id"] for profile in profiles}
            product_ids = {product.product_id for product in products}
            events_by_session: dict[str, list[dict]] = defaultdict(list)
            event_ids = set()
            checkout_events: dict[str, list[dict]] = defaultdict(list)
            with output.open("r", encoding="utf-8") as handle:
                for line in handle:
                    event = json.loads(line)
                    self.assertIn(event["user_id"], user_ids)
                    self.assertIn(event["product_id"], product_ids)
                    self.assertNotIn(event["event_id"], event_ids)
                    self.assertEqual(event["schema_version"], generate.EVENT_SCHEMA_VERSION)
                    self.assertEqual(
                        event["event_source"], generate.EVENT_SOURCE_BY_TYPE[event["event_type"]]
                    )
                    self.assertLess(datetime.fromisoformat(event["event_time"]), self.end)
                    event_ids.add(event["event_id"])
                    events_by_session[event["session_id"]].append(event)
                    checkout_id = event["properties"].get("checkout_id")
                    if checkout_id:
                        checkout_events[checkout_id].append(event)

            for events in events_by_session.values():
                timestamps = [datetime.fromisoformat(event["event_time"]) for event in events]
                self.assertEqual(timestamps, sorted(timestamps))
                prior_by_product: dict[str, set[str]] = defaultdict(set)
                for event in events:
                    event_type = event["event_type"]
                    product_id = event["product_id"]
                    if event_type == "add_to_cart":
                        self.assertIn("product_click", prior_by_product[product_id])
                    if event_type == "purchase_click":
                        self.assertIn("add_to_cart", prior_by_product[product_id])
                    prior_by_product[product_id].add(event_type)

            self.assertGreater(stats["event_type_counts"]["order_completed"], 0)
            expected_sources = {
                "purchase_click": "web_client",
                "checkout_started": "checkout_service",
                "payment_success": "payment_service",
                "order_completed": "order_service",
            }
            expected_prefixes = {
                "purchase_click": ["purchase_click"],
                "checkout_started": ["purchase_click", "checkout_started"],
                "payment_success": ["purchase_click", "checkout_started", "payment_success"],
                "order_completed": [
                    "purchase_click", "checkout_started", "payment_success", "order_completed",
                ],
            }
            for checkout_id, events in checkout_events.items():
                event_types = [event["event_type"] for event in events]
                self.assertEqual(event_types, expected_prefixes[event_types[-1]])
                shared = {
                    (
                        event["session_id"], event["product_id"],
                        event["properties"]["currency"], event["properties"]["order_value"],
                        event["properties"]["item_count"],
                    )
                    for event in events
                }
                self.assertEqual(len(shared), 1)
                for event in events:
                    self.assertEqual(event["event_source"], expected_sources[event["event_type"]])
                    self.assertEqual(event["properties"]["checkout_id"], checkout_id)
                    if event["event_type"] == "order_completed":
                        self.assertIsNotNone(event["properties"]["order_id"])
                    else:
                        self.assertIsNone(event["properties"]["order_id"])

    def test_default_seed_has_target_order_conversion_and_is_deterministic(self) -> None:
        profiles = generate.generate_users(3000, 20260711, self.start, self.end)
        products = sample_products()
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / "first.jsonl"
            second = Path(directory) / "second.jsonl"
            first_stats = generate.generate_events(
                profiles, products, first, 20260711, self.start, self.end
            )
            second_stats = generate.generate_events(
                profiles, products, second, 20260711, self.start, self.end
            )
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(first_stats, second_stats)
            self.assertGreaterEqual(first_stats["order_completed_session_conversion_pct"], 1.0)
            self.assertLessEqual(first_stats["order_completed_session_conversion_pct"], 3.0)

    def test_analyzer_rejects_malformed_and_unsupported_events(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            path.write_text("{broken\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "malformed JSON"):
                list(analyze.event_batches(path))

            path.write_text(
                json.dumps(
                    {
                        "event_id": "EVT-1",
                        "schema_version": "99.0",
                        "event_source": "web_client",
                        "user_id": "USR-1",
                        "session_id": "SES-1",
                        "event_time": self.start.isoformat(),
                        "event_type": "product_impression",
                        "product_id": "P-1",
                        "page_url": "/",
                        "device_type": "mobile",
                        "referrer": "direct",
                        "properties": {"position": 1},
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "unsupported schema_version"):
                list(analyze.event_batches(path))

    def test_analyzer_rejects_duplicate_event_id(self) -> None:
        event = {
            "event_id": "EVT-1",
            "schema_version": generate.EVENT_SCHEMA_VERSION,
            "event_source": "web_client",
            "user_id": "USR-1",
            "session_id": "SES-1",
            "event_time": self.start.isoformat(),
            "event_type": "product_impression",
            "product_id": "P-1",
            "page_url": "/",
            "device_type": "mobile",
            "referrer": "direct",
            "properties": {"position": 1},
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            line = json.dumps(event) + "\n"
            path.write_text(line + line, encoding="utf-8")
            connection = sqlite3.connect(":memory:")
            connection.executescript(analyze.SCHEMA_SQL)
            try:
                with self.assertRaises(sqlite3.IntegrityError):
                    analyze.load_events(connection, path)
            finally:
                connection.close()


if __name__ == "__main__":
    unittest.main()
