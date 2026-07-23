from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from scripts.refactor_audit.quality_gate import compare


def baseline_with(exception: dict[str, object]) -> dict[str, object]:
    return {
        "fileLimit": 5,
        "functionLimit": 100,
        "oversizedFiles": {},
        "oversizedPythonFunctions": {},
        "oversizedJavascriptFunctions": {},
        "importCycles": {"python": [], "javascript": []},
        "exceptions": [exception],
    }


def exact_file_exception(maximum: int, expires_at: str = "2099-01-01") -> dict[str, object]:
    return {
        "id": "temporary-large-file",
        "owner": "data-platform",
        "reason": "Split the exact integration file before the exception expires.",
        "expiresAt": expires_at,
        "oversizedFiles": {"backend/app/large.py": maximum},
    }


class QualityGateExceptionTests(unittest.TestCase):
    def compare_large_file(
        self,
        exception: dict[str, object],
        *,
        line_count: int = 6,
    ) -> list[str]:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "backend/app/large.py"
            source.parent.mkdir(parents=True)
            source.write_text("value = 1\n" * line_count, encoding="utf-8")
            with patch(
                "scripts.refactor_audit.quality_gate.changed_files",
                return_value=set(),
            ):
                return compare(root, baseline_with(exception), "origin/dev")

    def test_exact_unexpired_exception_allows_only_its_ceiling(self) -> None:
        self.assertEqual(self.compare_large_file(exact_file_exception(6)), [])

    def test_growth_above_exception_ceiling_still_fails(self) -> None:
        failures = self.compare_large_file(exact_file_exception(6), line_count=7)
        self.assertIn(
            "quality gate exception ceiling must equal current size: oversizedFiles::backend/app/large.py (6 != 7)",
            failures,
        )
        self.assertIn(
            "new file exceeds 5 lines: backend/app/large.py (7)",
            failures,
        )

    def test_exception_cannot_reserve_unused_growth_headroom(self) -> None:
        failures = self.compare_large_file(exact_file_exception(7))
        self.assertIn(
            "quality gate exception ceiling must equal current size: oversizedFiles::backend/app/large.py (7 != 6)",
            failures,
        )
        self.assertIn(
            "new file exceeds 5 lines: backend/app/large.py (6)",
            failures,
        )

    def test_expired_exception_fails_and_does_not_suppress_debt(self) -> None:
        failures = self.compare_large_file(
            exact_file_exception(6, expires_at="2000-01-01")
        )
        self.assertIn(
            "expired quality gate exception: temporary-large-file",
            failures,
        )
        self.assertIn(
            "new file exceeds 5 lines: backend/app/large.py (6)",
            failures,
        )

    def test_exception_requires_complete_metadata(self) -> None:
        exception = exact_file_exception(6)
        exception.pop("owner")
        failures = self.compare_large_file(exception)
        self.assertIn(
            "quality gate exception requires id, owner, reason, and expiresAt",
            failures,
        )
        self.assertIn(
            "new file exceeds 5 lines: backend/app/large.py (6)",
            failures,
        )


if __name__ == "__main__":
    unittest.main()
