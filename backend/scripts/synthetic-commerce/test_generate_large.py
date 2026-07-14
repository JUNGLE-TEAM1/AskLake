#!/usr/bin/env python3

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_DIR = Path(__file__).parent


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPT_DIR / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


large = load_module("synthetic_generate_large", "generate_large.py")
validator = load_module("synthetic_validate_large", "validate_large.py")


def write_source(path: Path, products_per_category: int = 4) -> None:
    with path.open("w", encoding="utf-8") as handle:
        handle.write("not-json\n")
        for category_index, category in enumerate(large.core.TARGET_CATEGORIES):
            for product_index in range(products_per_category):
                handle.write(
                    json.dumps(
                        {
                            "parent_asin": f"P-{category_index:02d}-{product_index:03d}",
                            "title": f"Product {category_index}-{product_index}",
                            "store": "Synthetic",
                            "price": 10.123 + product_index * 20.017,
                            "average_rating": 3.54 + (product_index % 3) * 0.47,
                            "rating_number": 10 + product_index,
                            "categories": ["Electronics", category, f"Leaf {category_index}"],
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
        handle.write(json.dumps({"parent_asin": "missing-fields", "categories": ["Electronics"]}) + "\n")


def arguments(
    source: Path | None,
    output: Path,
    *,
    resume: bool = False,
    stop_after: int = 0,
) -> argparse.Namespace:
    return argparse.Namespace(
        source=source,
        output_dir=output,
        products=16,
        product_catalog=None,
        click_product_pool=None,
        seed=20260713,
        start_date="2026-06-01",
        days=30,
        tier=["small=80kb", "large=180kb"],
        checkpoint_every_users=1,
        max_users=500,
        resume=resume,
        force=False,
        skip_disk_check=True,
        stop_after_users=stop_after,
    )


def write_v2_inputs(catalog_path: Path, pool_path: Path) -> tuple[set[str], int, int]:
    catalog_rows = []
    pool_rows = []
    behavior_ids: set[str] = set()
    for category_index, category in enumerate(large.core.TARGET_CATEGORIES):
        for product_index in range(2):
            row = {
                "product_id": f"V2-{category_index:02d}-{product_index:02d}",
                "main_category": "Electronics",
                "category": category,
                "leaf_category": f"Leaf {category_index}",
                "title": f"V2 Product {category_index}-{product_index}",
                "store": None if product_index == 0 else "Synthetic",
                "price": 10.0 + product_index * 20.0,
                "average_rating": 4.0 + product_index * 0.2,
                "rating_count": 10 + product_index,
            }
            catalog_rows.append(row)
            pool_rows.append(row)
            behavior_ids.add(row["product_id"])
    unsupported = {
        "product_id": "V2-UNSUPPORTED",
        "main_category": "Electronics",
        "category": "Accessories & Supplies",
        "leaf_category": "Misc",
        "title": "Valid but unsupported behavior category",
        "store": "Synthetic",
        "price": 25.0,
        "average_rating": 4.2,
        "rating_count": 20,
    }
    catalog_rows.append(unsupported)
    pool_rows.append(unsupported)
    catalog_rows.append(
        {
            "product_id": "V2-CATALOG-ONLY",
            "main_category": None,
            "category": "All Electronics",
            "leaf_category": "All Electronics",
            "title": None,
            "store": None,
            "price": None,
            "average_rating": 4.0,
            "rating_count": 0,
        }
    )
    for path, rows in ((catalog_path, catalog_rows), (pool_path, pool_rows)):
        with path.open("w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
    return behavior_ids, len(catalog_rows), len(pool_rows)


def v2_arguments(
    catalog: Path,
    pool: Path,
    output: Path,
    *,
    resume: bool = False,
    stop_after: int = 0,
) -> argparse.Namespace:
    args = arguments(None, output, resume=resume, stop_after=stop_after)
    args.product_catalog = catalog
    args.click_product_pool = pool
    return args


class LargeGeneratorTests(unittest.TestCase):
    def test_byte_size_and_tier_parsing(self) -> None:
        self.assertEqual(large.parse_byte_size("1gb"), 1_000_000_000)
        self.assertEqual(large.parse_byte_size("2.5mb"), 2_500_000)
        self.assertEqual(large.parse_tiers(["b=20kb", "a=10kb"]), [("a", 10_000), ("b", 20_000)])

    def test_precomputed_popularity_choice_matches_legacy_choice(self) -> None:
        products = [
            large.core.Product(
                product_id=f"P-{index}",
                category=large.core.TARGET_CATEGORIES[0],
                leaf_category="Leaf",
                title=f"Product {index}",
                store="Synthetic",
                price=10.0 + index,
                average_rating=4.0,
                rating_count=10 + index,
            )
            for index in range(100)
        ]
        weights = [large.core.product_popularity_weight(product) for product in products]
        cumulative = []
        total = 0.0
        for weight in weights:
            total += weight
            cumulative.append(total)
        legacy_rng = large.random.Random(20260714)
        optimized_rng = large.random.Random(20260714)

        legacy = [
            large.core.choose_product(legacy_rng, products, weights) for _ in range(1000)
        ]
        optimized = [
            large.choose_product_large(optimized_rng, products, cumulative)
            for _ in range(1000)
        ]

        self.assertEqual(optimized, legacy)

    def test_generation_and_streaming_validation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "meta.jsonl"
            output = root / "output"
            write_source(source)
            manifest = large.run_generation(arguments(source, output))
            self.assertEqual(manifest["status"], "complete")
            self.assertEqual(manifest["product_selection"]["invalid_json_rows"], 1)
            self.assertEqual(
                manifest["product_selection"]["unsupported_or_missing_category_rows"],
                1,
            )
            self.assertEqual(manifest["product_selection"]["selected_rows"], 16)
            self.assertGreaterEqual(manifest["tiers"]["small"]["actual_total_bytes"], 80_000)
            self.assertGreaterEqual(manifest["tiers"]["large"]["actual_total_bytes"], 180_000)
            for filename in ("users", "click_events"):
                small = (output / f"{filename}_small.jsonl").read_bytes()
                big = (output / f"{filename}_large.jsonl").read_bytes()
                self.assertTrue(big.startswith(small))
            result = validator.validate(output, [], verify_hashes=True)
            self.assertEqual(result["status"], "pass")
            self.assertGreater(result["tiers"]["large"]["counts"]["events"], 0)

    def test_v2_full_catalog_and_click_pool_generation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            catalog = root / "full-products.jsonl"
            pool = root / "click-product-pool.jsonl"
            output = root / "output"
            behavior_ids, catalog_rows, pool_rows = write_v2_inputs(catalog, pool)

            manifest = large.run_generation(v2_arguments(catalog, pool, output))

            self.assertEqual((output / "products.jsonl").read_bytes(), catalog.read_bytes())
            selection = manifest["product_selection"]
            self.assertEqual(selection["mode"], "preextracted-v2")
            self.assertEqual(selection["catalog_rows"], catalog_rows)
            self.assertEqual(selection["click_pool_rows"], pool_rows)
            self.assertEqual(selection["behavior_product_rows"], len(behavior_ids))
            self.assertEqual(selection["unsupported_behavior_category_rows"], 1)
            checkpoint = json.loads((output / "checkpoint.json").read_text(encoding="utf-8"))
            config = checkpoint["configuration"]
            self.assertEqual(config["product_mode"], "preextracted-v2")
            self.assertEqual(len(config["product_catalog"]["sha256"]), 64)
            self.assertEqual(len(config["click_product_pool"]["sha256"]), 64)
            event_ids = {
                json.loads(line)["product_id"]
                for line in (output / "click_events_large.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
            }
            self.assertTrue(event_ids)
            self.assertTrue(event_ids.issubset(behavior_ids))
            result = validator.validate(output, [], verify_hashes=True)
            self.assertEqual(result["status"], "pass")

    def test_v2_checkpoint_resume_matches_clean_generation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            catalog = root / "full-products.jsonl"
            pool = root / "click-product-pool.jsonl"
            resumed = root / "resumed"
            clean = root / "clean"
            write_v2_inputs(catalog, pool)
            with self.assertRaises(large.GenerationPaused):
                large.run_generation(v2_arguments(catalog, pool, resumed, stop_after=3))
            resumed_manifest = large.run_generation(
                v2_arguments(catalog, pool, resumed, resume=True)
            )
            clean_manifest = large.run_generation(v2_arguments(catalog, pool, clean))
            for label in ("small", "large"):
                for filename in (
                    "products.jsonl",
                    f"users_{label}.jsonl",
                    f"click_events_{label}.jsonl",
                ):
                    self.assertEqual(
                        resumed_manifest["tiers"][label]["files"][filename]["sha256"],
                        clean_manifest["tiers"][label]["files"][filename]["sha256"],
                    )

    def test_v2_force_preserves_catalog_when_input_is_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            catalog = output / "products.jsonl"
            pool = output / "click_product_pool.jsonl"
            write_v2_inputs(catalog, pool)
            before = catalog.read_bytes()
            (output / "users_stale.jsonl").write_text("stale\n", encoding="utf-8")
            args = v2_arguments(catalog, pool, output)
            args.force = True

            large.run_generation(args)

            self.assertEqual(catalog.read_bytes(), before)
            self.assertFalse((output / "users_stale.jsonl").exists())

    def test_v2_rejects_click_product_absent_from_catalog(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            catalog = root / "full-products.jsonl"
            pool = root / "click-product-pool.jsonl"
            output = root / "output"
            write_v2_inputs(catalog, pool)
            rows = pool.read_text(encoding="utf-8").splitlines()
            row = json.loads(rows[0])
            row["product_id"] = "NOT-IN-CATALOG"
            rows[0] = json.dumps(row, ensure_ascii=False, separators=(",", ":"))
            pool.write_text("\n".join(rows) + "\n", encoding="utf-8")

            with self.assertRaisesRegex(RuntimeError, "absent from catalog"):
                large.run_generation(v2_arguments(catalog, pool, output))

    def test_checkpoint_resume_matches_clean_generation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "meta.jsonl"
            resumed = root / "resumed"
            clean = root / "clean"
            write_source(source)
            with self.assertRaises(large.GenerationPaused):
                large.run_generation(arguments(source, resumed, stop_after=3))
            for path in resumed.glob("*.jsonl"):
                if path.name != "products.jsonl":
                    with path.open("ab") as handle:
                        handle.write(b'{"uncommitted":')
            resumed_manifest = large.run_generation(arguments(source, resumed, resume=True))
            clean_manifest = large.run_generation(arguments(source, clean))
            for label in ("small", "large"):
                for filename in (
                    "products.jsonl",
                    f"users_{label}.jsonl",
                    f"click_events_{label}.jsonl",
                ):
                    self.assertEqual(
                        resumed_manifest["tiers"][label]["files"][filename]["sha256"],
                        clean_manifest["tiers"][label]["files"][filename]["sha256"],
                    )

    def test_validator_rejects_unknown_product_reference(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "meta.jsonl"
            output = root / "output"
            write_source(source)
            large.run_generation(arguments(source, output))
            events_path = output / "click_events_small.jsonl"
            lines = events_path.read_text(encoding="utf-8").splitlines()
            event = json.loads(lines[0])
            event["product_id"] = "NOT-A-PRODUCT"
            lines[0] = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
            events_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(validator.ValidationFailure, "unknown product"):
                validator.validate(output, ["small"], verify_hashes=False)

    def test_resume_rejects_file_shorter_than_checkpoint(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "meta.jsonl"
            output = root / "output"
            write_source(source)
            with self.assertRaises(large.GenerationPaused):
                large.run_generation(arguments(source, output, stop_after=3))
            events_path = output / "click_events_small.jsonl"
            events_path.write_bytes(events_path.read_bytes()[:-1])

            with self.assertRaisesRegex(RuntimeError, "shorter than checkpoint"):
                large.run_generation(arguments(source, output, resume=True))

    def test_resume_rejects_same_size_product_tamper(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "meta.jsonl"
            output = root / "output"
            write_source(source)
            with self.assertRaises(large.GenerationPaused):
                large.run_generation(arguments(source, output, stop_after=3))
            products_path = output / "products.jsonl"
            payload = products_path.read_bytes()
            marker = b'"price":10.12'
            self.assertIn(marker, payload)
            products_path.write_bytes(payload.replace(marker, b'"price":90.12', 1))

            with self.assertRaisesRegex(RuntimeError, "checksum does not match"):
                large.run_generation(arguments(source, output, resume=True))

    def test_rejects_tier_smaller_than_products_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "meta.jsonl"
            output = root / "output"
            write_source(source)
            args = arguments(source, output)
            args.tier = ["tiny=1kb"]

            with self.assertRaisesRegex(RuntimeError, "must exceed products.jsonl"):
                large.run_generation(args)

    def test_exact_duplicate_product_ids_are_counted_once(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "meta.jsonl"
            output = root / "output"
            write_source(source)
            duplicate = {
                "parent_asin": "P-00-000",
                "title": "Duplicate across category",
                "store": "Synthetic",
                "price": 50.25,
                "average_rating": 4.2,
                "rating_number": 20,
                "categories": [
                    "Electronics",
                    large.core.TARGET_CATEGORIES[1],
                    "Duplicate Leaf",
                ],
            }
            with source.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(duplicate) + "\n")

            manifest = large.run_generation(arguments(source, output))
            self.assertEqual(
                manifest["product_selection"]["duplicate_product_id_rows"], 1
            )
            product_ids = [
                json.loads(line)["product_id"]
                for line in (output / "products.jsonl").read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual(len(product_ids), len(set(product_ids)))

    def test_validator_rejects_manifest_byte_and_overshoot_tamper(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "meta.jsonl"
            output = root / "output"
            write_source(source)
            manifest = large.run_generation(arguments(source, output))
            manifest_path = output / "manifest.json"
            users_name = "users_small.jsonl"
            manifest["tiers"]["small"]["files"][users_name]["bytes"] += 1
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(validator.ValidationFailure, "file byte mismatch"):
                validator.validate(output, ["small"], verify_hashes=False)

            manifest["tiers"]["small"]["files"][users_name]["bytes"] -= 1
            manifest["tiers"]["small"]["overshoot_bytes"] += 1
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(validator.ValidationFailure, "overshoot mismatch"):
                validator.validate(output, ["small"], verify_hashes=False)

    def test_force_removes_stale_tiers_from_previous_configuration(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "meta.jsonl"
            output = root / "output"
            output.mkdir()
            stale_users = output / "users_old-tier.jsonl"
            stale_events = output / "click_events_old-tier.jsonl"
            stale_users.write_text("stale\n", encoding="utf-8")
            stale_events.write_text("stale\n", encoding="utf-8")
            write_source(source)
            args = arguments(source, output)
            args.force = True

            large.run_generation(args)

            self.assertFalse(stale_users.exists())
            self.assertFalse(stale_events.exists())


if __name__ == "__main__":
    unittest.main()
