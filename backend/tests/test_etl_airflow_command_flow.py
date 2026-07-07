from pathlib import Path
import unittest


BACKEND_DIR = Path(__file__).resolve().parents[1]


class ETLAirflowCommandFlowContractTests(unittest.TestCase):
    def test_run_and_retry_submit_to_airflow_instead_of_spark(self) -> None:
        source = (BACKEND_DIR / "app/services/etl_service.py").read_text()
        run_retry_branch = source.split('if command in {"run", "retry"}:', 1)[1].split('elif command == "cancel":', 1)[0]

        self.assertIn("submit_airflow_job_run(job, command)", run_retry_branch)
        self.assertIn("dag_steps_from_airflow_submit", run_retry_branch)
        self.assertNotIn("run_spark_job", run_retry_branch)
        self.assertNotIn("finalize_job_from_spark_result", run_retry_branch)

    def test_airflow_submit_payload_and_metadata_helpers_exist(self) -> None:
        source = (BACKEND_DIR / "app/services/etl_service.py").read_text()

        self.assertIn("def submit_airflow_job_run", source)
        self.assertIn("trigger_dag_run(", source)
        self.assertIn("def airflow_dag_run_conf", source)
        self.assertIn('"job": job_payload_for_spark(job)', source)
        self.assertIn("def run_from_airflow_submit", source)
        self.assertIn("airflow_dag_run_id=dag_run.dag_run_id", source)
        self.assertIn("last_synced_at=submitted_at", source)
        self.assertIn("def dag_steps_from_airflow_submit", source)
        self.assertIn('"airflow-submit"', source)

    def test_duplicate_run_and_retry_are_guarded_while_running(self) -> None:
        source = (BACKEND_DIR / "app/services/etl_service.py").read_text()

        self.assertIn('if command in {"run", "retry"} and job.status == "running":', source)
        self.assertIn("ErrorCode.CONFLICT", source)

    def test_cancel_message_names_deferred_interrupt_scope(self) -> None:
        source = (BACKEND_DIR / "app/services/etl_service.py").read_text()

        self.assertIn("취소 요청됨 · Airflow/Spark 중단은 후속 범위", source)
        self.assertIn("Airflow/Spark interrupt deferred.", source)


if __name__ == "__main__":
    unittest.main()
