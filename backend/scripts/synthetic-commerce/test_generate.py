#!/usr/bin/env python3

from __future__ import annotations

import hashlib
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


def write_source(path: Path, products_per_category: int = 4) -> None:
    with path.open("w", encoding="utf-8") as handle:
        handle.write("not-json\n")
        for category_index, category in enumerate(generate.TARGET_CATEGORIES):
            for product_index in range(products_per_category):
                row = {
                    "parent_asin": f"ASIN-{category_index:02d}-{product_index:03d}",
                    "title": f"Electronics product {category_index}-{product_index}",
                    "store": "Fixture Store",
                    "price": 25.0 + category_index + product_index * 7,
                    "average_rating": 3.8 + (product_index % 3) * 0.3,
                    "rating_number": 20 + product_index * 11,
                    "categories": ["Electronics", category, f"Leaf {category_index}"],
                }
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        # Invalid-price row must not enter the normalized product dataset.
        handle.write(
            json.dumps(
                {
                    "parent_asin": "INVALID-PRICE",
                    "title": "Invalid",
                    "store": "Fixture Store",
                    "price": None,
                    "average_rating": 4.5,
                    "rating_number": 100,
                    "categories": ["Electronics", generate.TARGET_CATEGORIES[0]],
                }
            )
            + "\n"
        )


def dataset_rows(run_dir: Path, dataset: str):
    for path in sorted((run_dir / dataset).glob("part-*.jsonl")):
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                yield json.loads(line)


def generated_file_bytes(run_dir: Path, manifest: dict) -> dict[str, bytes]:
    return {
        item["path"]: (run_dir / item["path"]).read_bytes()
        for item in manifest["files"]
    }


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

    def test_events_keep_referential_time_and_funnel_order(self) -> None:
        profiles = generate.generate_users(120, 5678, self.start, self.end)
        products = sample_products()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "events.jsonl"
            stats = generate.generate_events(profiles, products, output, 5678, self.start, self.end)
            self.assertGreater(stats["event_count"], 0)

            user_ids = {profile.public["user_id"] for profile in profiles}
            product_ids = {product.product_id for product in products}
            signup_by_user = {
                profile.public["user_id"]: datetime.fromisoformat(profile.public["signup_at"])
                for profile in profiles
            }
            events_by_session: dict[str, list[dict]] = defaultdict(list)
            event_ids = set()
            with output.open("r", encoding="utf-8") as handle:
                for line in handle:
                    event = json.loads(line)
                    timestamp = datetime.fromisoformat(event["event_time"])
                    self.assertIn(event["user_id"], user_ids)
                    self.assertIn(event["product_id"], product_ids)
                    self.assertGreaterEqual(timestamp, self.start)
                    self.assertGreaterEqual(timestamp, signup_by_user[event["user_id"]])
                    self.assertLess(timestamp, self.end)
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

    def test_part_writer_caps_files_and_records_manifest_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory) / "run"
            run_dir.mkdir()
            writer = generate.JsonlPartWriter(run_dir, "rows", 96)
            for index in range(20):
                writer.write({"id": index, "value": "x" * 22})
            writer.close()
            entry = writer.manifest_entry()

            self.assertGreater(entry["file_count"], 1)
            self.assertEqual(entry["rows"], 20)
            self.assertEqual(entry["bytes"], sum(item["bytes"] for item in entry["files"]))
            for item in entry["files"]:
                path = run_dir / item["path"]
                self.assertLessEqual(path.stat().st_size, 96)
                self.assertEqual(item["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
                self.assertEqual(item["rows"], len(path.read_text(encoding="utf-8").splitlines()))

    def test_target_sized_dataset_is_split_deterministic_and_fk_valid(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "meta_Electronics.jsonl"
            write_source(source)
            arguments = {
                "source": source,
                "run_id": "target-test",
                "product_count": 16,
                "target_total_size_mb": 0.35,
                "max_file_size_mb": 0.06,
                "seed": 314159,
                "start_date": "2026-06-01",
                "days": 7,
            }

            first = generate.generate_dataset(output_dir=root / "first", **arguments)
            second = generate.generate_dataset(output_dir=root / "second", **arguments)
            first_dir = root / "first" / "target-test"
            second_dir = root / "second" / "target-test"

            self.assertEqual(first, second)
            self.assertEqual(
                generated_file_bytes(first_dir, first),
                generated_file_bytes(second_dir, second),
            )
            self.assertEqual(first["generator_version"], 3)
            self.assertEqual(
                first["behavior_profile"]["category_purchase_intent"]["applied_stage"],
                "cart_to_purchase_click",
            )
            self.assertEqual(
                set(first["behavior_profile"]["date_profiles"]),
                {"weekend_campaign", "payday_promotion"},
            )
            self.assertEqual(set(first["datasets"]), {"meta", "users", "click_events"})
            self.assertEqual(first["resolved_counts"]["products"], 16)
            self.assertGreater(first["resolved_counts"]["users"], 0)
            self.assertGreater(first["datasets"]["click_events"]["file_count"], 1)
            self.assertLess(abs(first["sizing"]["target_size_error_pct"]), 20.0)

            maximum = round(0.06 * generate.MEBIBYTE)
            for dataset in first["datasets"].values():
                self.assertEqual(dataset["rows"], sum(item["rows"] for item in dataset["files"]))
                self.assertEqual(dataset["bytes"], sum(item["bytes"] for item in dataset["files"]))
                for item in dataset["files"]:
                    path = first_dir / item["path"]
                    self.assertEqual(item["bytes"], path.stat().st_size)
                    self.assertLessEqual(item["bytes"], maximum)
                    self.assertEqual(item["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())

            meta_rows = list(dataset_rows(first_dir, "meta"))
            user_rows = list(dataset_rows(first_dir, "users"))
            event_rows = list(dataset_rows(first_dir, "click_events"))
            self.assertEqual(len(meta_rows), first["resolved_counts"]["products"])
            self.assertEqual(len(user_rows), first["resolved_counts"]["users"])
            self.assertEqual(len(event_rows), first["resolved_counts"]["click_events"])

            product_ids = {row["product_id"] for row in meta_rows}
            users = {row["user_id"]: row for row in user_rows}
            window_start = datetime.fromisoformat(first["window"]["start"])
            window_end = datetime.fromisoformat(first["window"]["end_exclusive"])
            for event in event_rows:
                timestamp = datetime.fromisoformat(event["event_time"])
                self.assertIn(event["product_id"], product_ids)
                self.assertIn(event["user_id"], users)
                self.assertGreaterEqual(timestamp, datetime.fromisoformat(users[event["user_id"]]["signup_at"]))
                self.assertGreaterEqual(timestamp, window_start)
                self.assertLess(timestamp, window_end)

            connection, loaded_counts = analyze.build_database(first_dir)
            try:
                integrity = analyze.validate_integrity(connection, first["window"])
            finally:
                connection.close()
            self.assertEqual(loaded_counts["products"], first["resolved_counts"]["products"])
            self.assertEqual(loaded_counts["users"], first["resolved_counts"]["users"])
            self.assertEqual(loaded_counts["events"], first["resolved_counts"]["click_events"])
            self.assertTrue(all(check["passed"] for check in integrity))
            self.assertTrue(
                all(check["passed"] for check in analyze.validate_manifest_files(first_dir, first))
            )

    def test_fixed_user_mode_and_invalid_size_combination(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.jsonl"
            write_source(source)
            manifest = generate.generate_dataset(
                source=source,
                output_dir=root / "fixed",
                run_id="fixed-test",
                product_count=8,
                user_count=25,
                max_file_size_mb=0.5,
                seed=9,
                days=3,
            )
            self.assertEqual(manifest["sizing"]["mode"], "fixed_users")
            self.assertEqual(manifest["resolved_counts"]["users"], 25)

            with self.assertRaisesRegex(ValueError, "cannot be combined"):
                generate.generate_dataset(
                    source=source,
                    output_dir=root / "invalid",
                    run_id="invalid-test",
                    product_count=8,
                    user_count=25,
                    target_total_size_mb=1,
                )


if __name__ == "__main__":
    unittest.main()
