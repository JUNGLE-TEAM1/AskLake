from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))
import etl_e2e_recovery as harness  # noqa: E402


class EtlE2eRecoveryHarnessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.registry = harness.load_registry(harness.default_registry_path())

    def test_failure_matrix_contains_every_release_risk(self) -> None:
        identifiers = {scenario["id"] for scenario in self.registry["scenarios"]}
        required = {
            "vertical-happy-path",
            "duplicate-submit-refresh-edit",
            "clean-boot",
            "compose-host-reboot",
            "docker-stack-restart",
            "backend-restart",
            "spark-worker-restart",
            "duplicate-start",
            "db-commit-process-death",
            "submission-response-loss",
            "report-missing",
            "report-corrupt",
            "report-permission-denied",
            "output-verification-failure",
            "manifest-write-failure",
            "catalog-timeout-after-manifest",
            "dashboard-timeout-after-catalog",
            "stale-worker-report",
            "reconcile-idempotent-convergence",
            "pause-maintenance-race",
            "partition-growth",
            "checkpoint-schema-mismatch",
            "frontend-two-tab-reversed-polling",
            "old-backend-rollback",
        }
        self.assertEqual(required - identifiers, set())

    def test_each_scenario_has_an_eligible_check_at_its_minimum_profile(self) -> None:
        checks = self.registry["checks"]
        for scenario in self.registry["scenarios"]:
            eligible = [
                check_id for check_id in scenario["checks"]
                if harness.included(checks[check_id]["minimumProfile"], scenario["minimumProfile"])
            ]
            with self.subTest(scenario=scenario["id"]):
                self.assertTrue(eligible)

    def test_profiles_are_cumulative_without_duplicate_check_execution(self) -> None:
        pr = harness.selected_check_ids(self.registry, "pr")
        release = harness.selected_check_ids(self.registry, "release")
        nightly = harness.selected_check_ids(self.registry, "nightly")
        self.assertEqual(len(nightly), len(set(nightly)))
        self.assertLess(set(pr), set(release))
        self.assertLess(set(release), set(nightly))

    def test_pr_checks_do_not_depend_on_posix_shell_assignment(self) -> None:
        backward = self.registry["checks"]["backward-compatibility"]
        self.assertEqual(backward["command"][0], "{python}")
        self.assertEqual(backward["environment"]["PYTHONPATH"], ".")

    def test_nightly_requires_an_explicit_loopback_isolated_environment(self) -> None:
        with self.assertRaisesRegex(ValueError, "ISOLATED_ENV"):
            harness.guard_isolated_profile("nightly", {})
        with self.assertRaisesRegex(ValueError, "loopback"):
            harness.guard_isolated_profile("nightly", {
                "ASKLAKE_E2E_ISOLATED_ENV": "true",
                "ASKLAKE_CONTINUOUS_E2E_BASE_URL": "https://production.example.com",
            })
        harness.guard_isolated_profile("nightly", {
            "ASKLAKE_E2E_ISOLATED_ENV": "true",
            "ASKLAKE_CONTINUOUS_E2E_BASE_URL": "http://127.0.0.1:8080",
        })

    def test_check_environment_removes_static_cloud_credentials(self) -> None:
        with patch.dict(os.environ, {
            "AWS_SECRET_ACCESS_KEY": "do-not-copy",
            "MINIO_SECRET_KEY": "do-not-copy",
            "SAFE_VALUE": "kept",
        }, clear=True):
            environment = harness.safe_environment({}, "e2e-test")
        self.assertNotIn("AWS_SECRET_ACCESS_KEY", environment)
        self.assertNotIn("MINIO_SECRET_KEY", environment)
        self.assertEqual(environment["SAFE_VALUE"], "kept")
        self.assertEqual(environment["ASKLAKE_FASTAPI_PYTHON"], sys.executable)
        self.assertEqual(environment["ASKLAKE_CORRELATION_ID"], "e2e-test")

    def test_command_resolves_platform_launcher(self) -> None:
        with patch("etl_e2e_recovery.shutil.which", return_value="C:/tools/npm.cmd"):
            command = harness.resolved_command({"command": ["npm", "run", "test"]})
        self.assertEqual(command, ["C:/tools/npm.cmd", "run", "test"])

    def test_check_decodes_utf8_output_independent_of_host_locale(self) -> None:
        result = harness.run_check(
            "utf8-output",
            {
                "command": [
                    "{python}", "-c",
                    "import sys; sys.stdout.buffer.write('✓ 한글'.encode('utf-8'))",
                ],
                "cwd": "backend",
                "timeoutSeconds": 10,
            },
            "e2e-test",
            False,
        )
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["stdout"], "✓ 한글")

    def test_dry_run_writes_json_junit_and_human_summary(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            report, paths = harness.execute("pr", self.registry, Path(directory), True)
            self.assertEqual(report["status"], "planned")
            self.assertTrue(all(check["status"] == "planned" for check in report["checks"]))
            for path in paths.values():
                self.assertTrue(Path(path).is_file())
            payload = json.loads(Path(paths["json"]).read_text(encoding="utf-8"))
            self.assertEqual(payload["correlationId"], report["correlationId"])
            self.assertIn("testsuite", Path(paths["junit"]).read_text(encoding="utf-8"))
            self.assertIn("vertical-happy-path", Path(paths["summary"]).read_text(encoding="utf-8"))

    def test_output_redaction_hides_key_value_secrets(self) -> None:
        value = harness.redact("token=abc password: hunter2 access_key = xyz")
        self.assertNotIn("abc", value)
        self.assertNotIn("hunter2", value)
        self.assertNotIn("xyz", value)
        self.assertEqual(value.count("[REDACTED]"), 3)


if __name__ == "__main__":
    unittest.main()
