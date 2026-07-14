from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).with_name("convert_click_log_to_kafka_jsonl.py")
SPEC = importlib.util.spec_from_file_location("convert_click_log_to_kafka_jsonl", MODULE_PATH)
assert SPEC and SPEC.loader
converter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(converter)


class ClickLogKafkaConversionTests(unittest.TestCase):
    def test_converts_click_log_to_standard_replay_records(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "click-events.log"
            target = root / "click-events.kafka.jsonl"
            source.write_text(
                "2026-06-12T14:21:32+09:00 EVT-000000001 USR-000001 SES-00000001 "
                "product_click B07WMTD66B /dp/B07WMTD66B mobile email 2\n",
                encoding="utf-8",
            )

            result = converter.convert_click_log(source, target, progress_every=0)
            record = json.loads(target.read_text(encoding="utf-8"))

            self.assertEqual(result["rows"], 1)
            self.assertEqual(record["event_id"], "EVT-000000001")
            self.assertEqual(record["offset"], 1)
            self.assertEqual(record["created_at"], "2026-06-12T14:21:32+09:00")
            self.assertEqual(record["review"], "product_click")
            self.assertEqual(record["raw"]["user_id"], "USR-000001")
            self.assertEqual(record["raw"]["position"], 2)

    def test_rejects_rows_with_the_wrong_field_count(self) -> None:
        with self.assertRaisesRegex(ValueError, "expected 10"):
            converter.parse_click_log_line("too few fields", 7, "click-events-log")


if __name__ == "__main__":
    unittest.main()
