import os
from pathlib import Path
import unittest
from unittest.mock import patch

from pydantic import ValidationError

from app.core.config import Settings


class ContinuousRuntimeSyncConfigTests(unittest.TestCase):
    def test_checked_in_env_examples_use_one_second(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        for relative_path in ("backend/.env.example", "deploy/.env.example"):
            with self.subTest(relative_path=relative_path):
                contents = (repository_root / relative_path).read_text(encoding="utf-8")
                self.assertIn("CONTINUOUS_RUNTIME_SYNC_INTERVAL_SECONDS=1\n", contents)

    def test_default_interval_is_one_second(self) -> None:
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("CONTINUOUS_RUNTIME_SYNC_INTERVAL_SECONDS", None)
            settings = Settings(_env_file=None)

        self.assertEqual(settings.continuous_runtime_sync_interval_seconds, 1.0)

    def test_environment_can_override_interval_within_supported_range(self) -> None:
        with patch.dict(
            os.environ,
            {"CONTINUOUS_RUNTIME_SYNC_INTERVAL_SECONDS": "2.5"},
            clear=False,
        ):
            settings = Settings(_env_file=None)

        self.assertEqual(settings.continuous_runtime_sync_interval_seconds, 2.5)

    def test_interval_below_one_second_is_rejected(self) -> None:
        with patch.dict(
            os.environ,
            {"CONTINUOUS_RUNTIME_SYNC_INTERVAL_SECONDS": "0.5"},
            clear=False,
        ):
            with self.assertRaises(ValidationError):
                Settings(_env_file=None)


if __name__ == "__main__":
    unittest.main()
