import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "verify-production-job-e2e.py"
SPEC = importlib.util.spec_from_file_location("asklake_production_job_e2e", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
smoke = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = smoke
SPEC.loader.exec_module(smoke)


class RawSmokeClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    def put_object(self, **kwargs):
        self.calls.append(("put", kwargs))

    def delete_object(self, **kwargs):
        self.calls.append(("delete", kwargs))


class ProductionJobE2EContractTests(unittest.TestCase):
    def test_raw_fixture_lifecycle_probe_writes_then_removes_the_scoped_key(self) -> None:
        client = RawSmokeClient()
        resources = smoke.SmokeResources(
            suffix="run",
            source_key="asklake-production-smoke/run/generic.jsonl",
            probe_key="asklake-production-smoke/run/_permission-probe",
        )

        with (
            patch("app.services.etl_service.build_catalog_s3_client", return_value=client),
            patch.object(smoke, "raw_bucket", return_value="asklake-raw"),
        ):
            smoke.probe_raw_fixture_lifecycle(resources)

        self.assertEqual(
            client.calls,
            [
                ("put", {"Bucket": "asklake-raw", "Key": "asklake-production-smoke/run/_permission-probe", "Body": b"", "ContentType": "application/octet-stream"}),
                ("delete", {"Bucket": "asklake-raw", "Key": "asklake-production-smoke/run/_permission-probe"}),
            ],
        )
        self.assertFalse(resources.probe_fixture_written)

    def test_raw_fixture_lifecycle_probe_explains_required_scoped_permissions(self) -> None:
        class FailingClient:
            def put_object(self, **_kwargs):
                raise RuntimeError("AccessDenied")

        with (
            patch("app.services.etl_service.build_catalog_s3_client", return_value=FailingClient()),
            patch.object(smoke, "raw_bucket", return_value="asklake-raw"),
            self.assertRaisesRegex(RuntimeError, "PutObject/DeleteObject probe failed.*asklake-production-smoke/\\*"),
        ):
            smoke.probe_raw_fixture_lifecycle(
                smoke.SmokeResources(
                    suffix="run",
                    source_key="asklake-production-smoke/run/generic.jsonl",
                    probe_key="asklake-production-smoke/run/_permission-probe",
                )
            )

    def test_failed_continuous_runtime_is_terminal_and_is_not_stopped_again(self) -> None:
        self.assertFalse(smoke.continuous_stop_required("failed"))
        self.assertFalse(smoke.continuous_stop_required("stopped"))
        self.assertTrue(smoke.continuous_stop_required("running"))
        self.assertTrue(smoke.continuous_stop_required("stopping"))


if __name__ == "__main__":
    unittest.main()
