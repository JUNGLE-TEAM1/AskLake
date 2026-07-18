from __future__ import annotations

from copy import deepcopy
import unittest

from scripts.refactor_audit.legacy_removal_evidence import validate_documents


def valid_register() -> dict[str, object]:
    return {
        "entries": [
            {"id": "path.one", "owner": "owner-one", "reachability": "production"},
            {"id": "path.two", "owner": "owner-two", "reachability": "production"},
            {"id": "dev.only", "owner": "developer", "reachability": "development_only"},
        ]
    }


def blocked_entry(path_id: str, owner: str) -> dict[str, object]:
    return {
        "pathId": path_id,
        "owner": owner,
        "observation": {
            "status": "not_started",
            "windowStart": None,
            "windowEnd": None,
            "observedCalls": None,
            "evidence": [],
        },
        "approval": {
            "status": "not_requested",
            "reviewedAt": None,
            "reviewedBy": None,
            "reference": None,
        },
    }


def valid_manifest() -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "environment": "production",
        "minimumZeroCallDays": 30,
        "paths": [blocked_entry("path.one", "owner-one"), blocked_entry("path.two", "owner-two")],
    }


def completed_observation(*, calls: int, end: str = "2026-01-31") -> dict[str, object]:
    return {
        "status": "passed",
        "windowStart": "2026-01-01",
        "windowEnd": end,
        "observedCalls": calls,
        "evidence": [{"kind": "log-query", "reference": "logs://compatibility/path.one"}],
    }


def approved_review() -> dict[str, object]:
    return {
        "status": "approved",
        "reviewedAt": "2026-02-01",
        "reviewedBy": "release-owner",
        "reference": "release://legacy/path.one",
    }


class LegacyRemovalEvidenceTests(unittest.TestCase):
    def test_accepts_complete_blocked_inventory_without_eligibility(self) -> None:
        errors, eligible, production_count = validate_documents(valid_manifest(), valid_register())

        self.assertEqual(errors, [])
        self.assertEqual(eligible, [])
        self.assertEqual(production_count, 2)

    def test_rejects_missing_unknown_and_duplicate_paths(self) -> None:
        manifest = valid_manifest()
        manifest["paths"] = [  # type: ignore[index]
            blocked_entry("path.one", "owner-one"),
            blocked_entry("path.one", "owner-one"),
            blocked_entry("unknown", "unknown-owner"),
        ]

        errors, _, _ = validate_documents(manifest, valid_register())

        self.assertTrue(any("duplicate evidence path" in error for error in errors))
        self.assertTrue(any("not production-registered" in error for error in errors))
        self.assertTrue(any("missing removal evidence" in error for error in errors))

    def test_rejects_approval_before_observation_passes(self) -> None:
        manifest = valid_manifest()
        manifest["paths"][0]["approval"] = approved_review()  # type: ignore[index]

        errors, eligible, _ = validate_documents(manifest, valid_register())

        self.assertTrue(any("cannot be approved" in error for error in errors))
        self.assertEqual(eligible, [])

    def test_rejects_short_zero_call_window(self) -> None:
        manifest = valid_manifest()
        manifest["paths"][0]["observation"] = completed_observation(calls=0, end="2026-01-30")  # type: ignore[index]
        manifest["paths"][0]["approval"] = approved_review()  # type: ignore[index]

        errors, eligible, _ = validate_documents(manifest, valid_register())

        self.assertTrue(any("at least 30 days" in error for error in errors))
        self.assertEqual(eligible, [])

    def test_rejects_nonzero_calls_claimed_as_passed(self) -> None:
        manifest = valid_manifest()
        manifest["paths"][0]["observation"] = completed_observation(calls=1)  # type: ignore[index]
        manifest["paths"][0]["approval"] = approved_review()  # type: ignore[index]

        errors, eligible, _ = validate_documents(manifest, valid_register())

        self.assertTrue(any("requires zero observed calls" in error for error in errors))
        self.assertEqual(eligible, [])

    def test_accepts_thirty_day_zero_call_evidence_and_approval(self) -> None:
        manifest = deepcopy(valid_manifest())
        manifest["paths"][0]["observation"] = completed_observation(calls=0)  # type: ignore[index]
        manifest["paths"][0]["approval"] = approved_review()  # type: ignore[index]

        errors, eligible, _ = validate_documents(manifest, valid_register())

        self.assertEqual(errors, [])
        self.assertEqual(eligible, ["path.one"])


if __name__ == "__main__":
    unittest.main()
