from __future__ import annotations

import importlib.util
import hashlib
import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).with_name("generate_realtime.py")
SPEC = importlib.util.spec_from_file_location("synthetic_generate_realtime", MODULE_PATH)
assert SPEC and SPEC.loader
realtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(realtime)


CATEGORY_PROFILE = {
    "Computers & Accessories": {"group": "medium", "multiplier": 1.0},
    "Camera & Photo": {"group": "medium", "multiplier": 1.0},
    "Television & Video": {"group": "low", "multiplier": 0.7},
    "Headphones, Earbuds & Accessories": {"group": "high", "multiplier": 1.3},
    "Home Audio": {"group": "medium", "multiplier": 1.0},
    "Car & Vehicle Electronics": {"group": "low", "multiplier": 0.7},
    "Portable Audio & Video": {"group": "low", "multiplier": 0.7},
    "Wearable Technology": {"group": "high", "multiplier": 1.3},
}


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows),
        encoding="utf-8",
    )


def evidence(path: Path, relative_path: str) -> dict:
    return {
        "path": relative_path,
        "rows": len(path.read_text(encoding="utf-8").splitlines()),
        "bytes": path.stat().st_size,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def write_baseline(root: Path) -> Path:
    baseline = root / "baseline"
    meta_path = baseline / "meta" / "part-00000.jsonl"
    users_path = baseline / "users" / "part-00000.jsonl"
    events_path = baseline / "click_events" / "part-00000.jsonl"
    products = [
        {
            "product_id": f"P-{index:02d}",
            "category": category,
            "leaf_category": category,
            "title": category,
            "store": "Synthetic",
            "price": 100.0,
            "average_rating": 4.2,
            "rating_count": 100,
        }
        for index, category in enumerate(CATEGORY_PROFILE)
    ]
    users = [
        {
            "user_id": f"USR-{index:06d}",
            "age": 30,
            "gender": "unknown",
            "region": "SEOUL",
            "signup_at": "2026-01-01T00:00:00+09:00",
            "acquisition_channel": "organic",
            "membership_tier": "basic",
            "primary_device": "mobile",
        }
        for index in range(1, 21)
    ]
    write_jsonl(meta_path, products)
    write_jsonl(users_path, users)
    write_jsonl(events_path, [{"event_id": "baseline-evidence"}])

    manifest = {
        "generator_version": 3,
        "run_id": "baseline-v3",
        "behavior_profile": {
            "category_purchase_intent": {"categories": CATEGORY_PROFILE},
        },
        "datasets": {
            "meta": {"files": [evidence(meta_path, "meta/part-00000.jsonl")]},
            "users": {"files": [evidence(users_path, "users/part-00000.jsonl")]},
            "click_events": {
                "files": [evidence(events_path, "click_events/part-00000.jsonl")]
            },
        },
    }
    (baseline / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    category_metrics = []
    for category, profile in CATEGORY_PROFILE.items():
        rate = {"high": 8.0, "medium": 6.0, "low": 4.5}[profile["group"]]
        category_metrics.append(
            {"category": category, "click_to_purchase_pct": rate}
        )
    (baseline / "analysis-result.json").write_text(
        json.dumps(
            {
                "all_integrity_passed": True,
                "all_planted_patterns_passed": True,
                "category_metrics": category_metrics,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return baseline


class RealtimeGeneratorTests(unittest.TestCase):
    def test_fixture_is_deterministic_bounded_and_meets_baseline_thresholds(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline = write_baseline(root)
            arguments = {
                "baseline_dir": baseline,
                "run_id": "demo-20260701",
                "anchor_at": "2026-07-01T12:00:00+09:00",
                "seed": 42,
                "clicks_per_category": 1_000,
            }
            first = realtime.generate_realtime_fixture(output_dir=root / "first", **arguments)
            second = realtime.generate_realtime_fixture(output_dir=root / "second", **arguments)
            first_dir = root / "first" / arguments["run_id"]
            second_dir = root / "second" / arguments["run_id"]

            self.assertEqual(first, second)
            for item in first["files"]:
                self.assertEqual(
                    (first_dir / item["path"]).read_bytes(),
                    (second_dir / item["path"]).read_bytes(),
                )
            self.assertTrue(all(item["passed"] for item in first["threshold_checks"]))
            self.assertEqual(first["replay_boundary"]["mode"], "bounded_one_shot")
            self.assertIn("demo-20260701", first["replay_boundary"]["topic"])
            self.assertTrue(realtime.validate_fixture(first_dir)["all_passed"])

            window_start = datetime.fromisoformat(first["window"]["start"])
            window_end = datetime.fromisoformat(first["window"]["end_exclusive"])
            funnel_by_session: dict[str, list[str]] = defaultdict(list)
            log_lines = (first_dir / "click-events.log").read_text(encoding="utf-8").splitlines()
            kafka_lines = (first_dir / "click-events.kafka.jsonl").read_text(
                encoding="utf-8"
            ).splitlines()
            self.assertEqual(len(log_lines), len(kafka_lines))
            for offset, (log_line, kafka_line) in enumerate(zip(log_lines, kafka_lines), start=1):
                values = log_line.split()
                self.assertEqual(len(values), len(realtime.FIELD_NAMES))
                raw = dict(zip(realtime.FIELD_NAMES, values))
                event_time = datetime.fromisoformat(raw["event_time"])
                self.assertGreaterEqual(event_time, window_start)
                self.assertLess(event_time, window_end)
                funnel_by_session[raw["session_id"]].append(raw["event_type"])
                envelope = json.loads(kafka_line)
                self.assertEqual(envelope["offset"], offset)
                self.assertEqual(envelope["raw"]["event_id"], raw["event_id"])

            expected_order = {
                "product_impression": 0,
                "product_click": 1,
                "add_to_cart": 2,
                "purchase_click": 3,
            }
            for event_types in funnel_by_session.values():
                self.assertEqual(
                    [expected_order[item] for item in event_types],
                    sorted(expected_order[item] for item in event_types),
                )

    def test_requires_timezone_and_minimum_samples(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            baseline = write_baseline(Path(directory))
            with self.assertRaisesRegex(ValueError, "explicit UTC offset"):
                realtime.generate_realtime_fixture(
                    baseline_dir=baseline,
                    output_dir=Path(directory) / "out",
                    run_id="bad-anchor",
                    anchor_at="2026-07-01T12:00:00",
                )
            with self.assertRaisesRegex(ValueError, "at least 500"):
                realtime.generate_realtime_fixture(
                    baseline_dir=baseline,
                    output_dir=Path(directory) / "out",
                    run_id="too-small",
                    anchor_at="2026-07-01T12:00:00+09:00",
                    clicks_per_category=499,
                )


if __name__ == "__main__":
    unittest.main()
