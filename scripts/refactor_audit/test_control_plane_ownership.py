from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from scripts.refactor_audit.control_plane_ownership import validate_manifest


def valid_manifest() -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "environment": "production",
        "contractOwner": "data-platform",
        "reviewBy": "2099-12-31",
        "requiredPlatforms": ["eks", "ec2-compose"],
        "requiredControlPlanes": [
            {
                "id": "continuous-runtime-sync",
                "ownerPolicy": "exactly-one",
                "entrypoints": ["backend/app/main.py::sync_runtime"],
            }
        ],
        "workloads": [
            {
                "id": "eks-web",
                "platform": "eks",
                "deploymentCell": "production-eks",
                "active": True,
                "responsibilities": ["web-api"],
                "ownsControlPlanes": [],
                "evidence": [{"kind": "operator-declared", "reference": "deployed baseline"}],
            },
            {
                "id": "ec2-owner",
                "platform": "ec2-compose",
                "deploymentCell": "production-ec2",
                "active": True,
                "responsibilities": ["continuous-control-plane"],
                "ownsControlPlanes": ["continuous-runtime-sync"],
                "evidence": [{"kind": "repository", "reference": "deploy/compose.yml::backend:"}],
            },
        ],
    }


class ControlPlaneOwnershipTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.root = Path(self.temporary.name)
        (self.root / "backend/app").mkdir(parents=True)
        (self.root / "deploy").mkdir(parents=True)
        (self.root / "backend/app/main.py").write_text("sync_runtime\n", encoding="utf-8")
        (self.root / "deploy/compose.yml").write_text("backend:\n", encoding="utf-8")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def errors_for(self, manifest: dict[str, object]) -> list[str]:
        return validate_manifest(manifest, root=self.root)

    def test_accepts_exactly_one_owner(self) -> None:
        self.assertEqual(self.errors_for(valid_manifest()), [])

    def test_rejects_duplicate_active_owners(self) -> None:
        manifest = valid_manifest()
        manifest["workloads"][0]["ownsControlPlanes"] = ["continuous-runtime-sync"]  # type: ignore[index]

        errors = self.errors_for(manifest)

        self.assertIn("control plane continuous-runtime-sync requires exactly one active owner; found 2", errors)

    def test_rejects_missing_owner(self) -> None:
        manifest = valid_manifest()
        manifest["workloads"][1]["ownsControlPlanes"] = []  # type: ignore[index]

        errors = self.errors_for(manifest)

        self.assertIn("control plane continuous-runtime-sync requires exactly one active owner; found 0", errors)

    def test_rejects_inactive_workload_claim(self) -> None:
        manifest = valid_manifest()
        manifest["workloads"][1]["active"] = False  # type: ignore[index]

        errors = self.errors_for(manifest)

        self.assertTrue(any("inactive but still claims" in error for error in errors))
        self.assertTrue(any("required active platforms are missing" in error for error in errors))

    def test_rejects_unknown_control_plane(self) -> None:
        manifest = valid_manifest()
        manifest["workloads"][1]["ownsControlPlanes"] = ["misspelled-owner"]  # type: ignore[index]

        errors = self.errors_for(manifest)

        self.assertTrue(any("claims unknown control plane" in error for error in errors))

    def test_rejects_missing_repository_evidence(self) -> None:
        manifest = deepcopy(valid_manifest())
        manifest["workloads"][1]["evidence"] = [  # type: ignore[index]
            {"kind": "repository", "reference": "deploy/missing.yml::backend:"}
        ]

        errors = self.errors_for(manifest)

        self.assertTrue(any("repository file does not exist" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
