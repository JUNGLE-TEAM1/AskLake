#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
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
            with output.open("r", encoding="utf-8") as handle:
                for line in handle:
                    event = json.loads(line)
                    self.assertIn(event["user_id"], user_ids)
                    self.assertIn(event["product_id"], product_ids)
                    self.assertNotIn(event["event_id"], event_ids)
                    event_ids.add(event["event_id"])
                    events_by_session[event["session_id"]].append(event)

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


if __name__ == "__main__":
    unittest.main()
