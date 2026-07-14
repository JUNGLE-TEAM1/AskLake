#!/usr/bin/env python3

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("extract_products_full.py")
SPEC = importlib.util.spec_from_file_location("synthetic_extract_products_full", MODULE_PATH)
assert SPEC and SPEC.loader
extractor = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = extractor
SPEC.loader.exec_module(extractor)


def args(source: Path, output: Path, force: bool = False) -> argparse.Namespace:
    return argparse.Namespace(
        source=source,
        output_dir=output,
        commit_every=2,
        progress_every=0,
        force=force,
    )


class FullProductExtractorTests(unittest.TestCase):
    def write_source(self, path: Path) -> None:
        rows = [
            {
                "parent_asin": "P-MISSING",
                "title": "Kept without behavioral fields",
                "main_category": "All Electronics",
                "categories": ["Electronics", "Accessories & Supplies"],
                "price": None,
                "average_rating": None,
                "rating_number": None,
            },
            {
                "parent_asin": "P-ELIGIBLE",
                "title": "Eligible original",
                "store": "",
                "main_category": "All Electronics",
                "categories": ["Electronics", "Unlisted Category", "Leaf"],
                "price": "$12.34",
                "average_rating": 4.5,
                "rating_number": 20,
            },
            {
                "parent_asin": "P-ELIGIBLE",
                "title": "Eligible more complete",
                "store": "Store",
                "main_category": "All Electronics",
                "categories": ["Electronics", "Unlisted Category", "Leaf"],
                "price": 12.34,
                "average_rating": 4.5,
                "rating_number": 20,
            },
            {"parent_asin": "", "title": "No identity"},
        ]
        with path.open("w", encoding="utf-8") as handle:
            handle.write("not-json\n")
            for row in rows:
                handle.write(json.dumps(row) + "\n")

    def test_full_catalog_preserves_nulls_and_separates_click_pool(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.jsonl"
            output = root / "output"
            self.write_source(source)

            profile = extractor.run_extraction(args(source, output))
            products = [
                json.loads(line)
                for line in (output / extractor.PRODUCTS_NAME)
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            click_pool = [
                json.loads(line)
                for line in (output / extractor.CLICK_POOL_NAME)
                .read_text(encoding="utf-8")
                .splitlines()
            ]

        self.assertEqual(profile["scan"]["source_rows"], 5)
        self.assertEqual(profile["scan"]["invalid_json_rows"], 1)
        self.assertEqual(profile["scan"]["missing_product_id_rows"], 1)
        self.assertEqual(profile["scan"]["duplicate_product_id_rows"], 1)
        self.assertEqual(profile["scan"]["duplicate_replacements"], 1)
        self.assertEqual(len(products), 2)
        self.assertEqual(len(click_pool), 1)
        self.assertIsNone(products[1]["price"])
        self.assertEqual(click_pool[0]["category"], "Unlisted Category")
        self.assertEqual(click_pool[0]["title"], "Eligible more complete")

    def test_force_replaces_previous_outputs_deterministically(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.jsonl"
            output = root / "output"
            self.write_source(source)
            first = extractor.run_extraction(args(source, output))
            second = extractor.run_extraction(args(source, output, force=True))

        for name in (extractor.PRODUCTS_NAME, extractor.CLICK_POOL_NAME):
            self.assertEqual(
                first["files"][name]["sha256"], second["files"][name]["sha256"]
            )


if __name__ == "__main__":
    unittest.main()
