from pathlib import Path
import unittest

from app.main import app


BACKEND_ROOT = Path(__file__).resolve().parents[1]


class DashboardJobBindingRemovalTests(unittest.TestCase):
    def test_openapi_does_not_expose_binding_routes_or_schemas(self) -> None:
        document = app.openapi()
        paths = document.get("paths", {})
        schemas = document.get("components", {}).get("schemas", {})

        self.assertFalse(any(path.startswith("/api/dashboard-job-bindings") for path in paths))
        self.assertFalse(any("DashboardJobBinding" in name for name in schemas))
        self.assertFalse(any("DashboardBindingDelivery" in name for name in schemas))

    def test_runtime_and_assistant_do_not_read_legacy_binding_state(self) -> None:
        sources = "\n".join(
            (BACKEND_ROOT / relative_path).read_text(encoding="utf-8")
            for relative_path in (
                "app/services/dashboard_runtime_service.py",
                "app/services/dashboard_assistant_context.py",
                "app/continuous_worker.py",
                "app/migrations/metadata_schema.py",
            )
        )

        for retired_symbol in (
            "DashboardJobBindingRepository",
            "_managed_widget_dataset_id",
            "process_dashboard_binding_deliveries",
            "ensure_dashboard_job_binding_schema",
        ):
            self.assertNotIn(retired_symbol, sources)

    def test_binding_runtime_modules_are_removed(self) -> None:
        for relative_path in (
            "app/api/dashboard_job_bindings.py",
            "app/models/dashboard_job_binding.py",
            "app/repositories/dashboard_job_binding_repository.py",
            "app/services/dashboard_job_binding_service.py",
            "app/services/dashboard_binding_delivery_worker.py",
        ):
            self.assertFalse((BACKEND_ROOT / relative_path).exists(), relative_path)


if __name__ == "__main__":
    unittest.main()
