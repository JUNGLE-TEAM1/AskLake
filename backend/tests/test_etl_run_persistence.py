from pathlib import Path
import unittest


BACKEND_DIR = Path(__file__).resolve().parents[1]
AIRFLOW_RUN_FIELDS = (
    "airflow_dag_id",
    "airflow_dag_run_id",
    "airflow_run_url",
    "airflow_state",
    "last_synced_at",
    "sync_error",
    "task_states",
)


class ETLRunPersistenceContractTests(unittest.TestCase):
    def test_airflow_run_fields_are_persisted_and_returned(self) -> None:
        model_source = (BACKEND_DIR / "app/models/etl.py").read_text()
        schema_source = (BACKEND_DIR / "app/schemas/etl.py").read_text()
        repository_source = (BACKEND_DIR / "app/repositories/etl_repository.py").read_text()

        for field in AIRFLOW_RUN_FIELDS:
            self.assertIn(f"{field}: Mapped[", model_source)
            self.assertIn(f"{field}: ", schema_source)
            self.assertIn(f'"{field}":', repository_source)
            self.assertIn(f"{field}=run.{field}", repository_source)

    def test_task_states_are_documented_as_optional_run_metadata(self) -> None:
        contract_source = (BACKEND_DIR.parent / "docs/api-contract.md").read_text()
        sot_source = (BACKEND_DIR.parent / "docs/airflow-orchestration-sot.md").read_text()

        self.assertIn("taskStates?: Record<string, unknown>;", contract_source)
        self.assertIn("task state snapshots", sot_source)


if __name__ == "__main__":
    unittest.main()
