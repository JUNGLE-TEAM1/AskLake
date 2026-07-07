import json
import unittest
from types import SimpleNamespace

from app.services.airflow_client import (
    AirflowClient,
    AirflowClientConfig,
    airflow_run_is_terminal,
    airflow_run_status,
    airflow_step_status,
)


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class AirflowClientTest(unittest.TestCase):
    def test_run_status_mapping_matches_sot(self):
        for state in ["queued", "scheduled", "deferred", "up_for_retry"]:
            self.assertEqual(airflow_run_status(state), "queued")
        self.assertEqual(airflow_run_status("running"), "running")
        self.assertEqual(airflow_run_status("success"), "success")
        self.assertEqual(airflow_run_status("failed"), "failed")
        self.assertEqual(airflow_run_status("upstream_failed"), "failed")
        self.assertEqual(airflow_run_status("skipped"), "failed")
        self.assertEqual(airflow_run_status("removed"), "failed")
        self.assertEqual(airflow_run_status("surprise_state"), "running")

    def test_step_status_mapping_matches_sot(self):
        for state in ["queued", "scheduled", "deferred", "up_for_retry"]:
            self.assertEqual(airflow_step_status(state), "pending")
        self.assertEqual(airflow_step_status("running"), "running")
        self.assertEqual(airflow_step_status("success"), "success")
        self.assertEqual(airflow_step_status("failed"), "failed")
        self.assertEqual(airflow_step_status("upstream_failed"), "failed")
        self.assertEqual(airflow_step_status("skipped"), "blocked")
        self.assertEqual(airflow_step_status("removed"), "blocked")
        self.assertEqual(airflow_step_status("surprise_state"), "pending")

    def test_terminal_run_helper_uses_asklake_status(self):
        self.assertTrue(airflow_run_is_terminal("success"))
        self.assertTrue(airflow_run_is_terminal("failed"))
        self.assertFalse(airflow_run_is_terminal("queued"))
        self.assertFalse(airflow_run_is_terminal("unknown"))

    def test_missing_config_reports_required_backend_env(self):
        source = SimpleNamespace(
            airflow_api_base_url="",
            airflow_dag_id=None,
            airflow_api_token=None,
            airflow_username=None,
            airflow_password=None,
            airflow_request_timeout_seconds=10.0,
            airflow_ui_base_url=None,
        )

        self.assertEqual(
            AirflowClientConfig.missing_settings(source),
            ["AIRFLOW_API_BASE_URL", "AIRFLOW_DAG_ID"],
        )

    def test_trigger_dag_run_uses_airflow_v2_path_and_payload(self):
        calls = []

        def opener(request, timeout):
            calls.append((request, timeout))
            return FakeResponse({
                "dag_id": "asklake_etl_job",
                "dag_run_id": "run_123",
                "state": "queued",
                "conf": {"jobId": "JOB-1"},
            })

        client = AirflowClient(
            AirflowClientConfig(
                api_base_url="http://airflow.local",
                dag_id="asklake_etl_job",
                api_token="token-value",
            ),
            opener=opener,
        )

        dag_run = client.trigger_dag_run(
            dag_run_id="run_123",
            conf={"jobId": "JOB-1"},
            note="AskLake run",
        )

        request, timeout = calls[0]
        self.assertEqual(timeout, 10.0)
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.full_url, "http://airflow.local/api/v2/dags/asklake_etl_job/dagRuns")
        self.assertEqual(request.get_header("Authorization"), "Bearer token-value")
        self.assertEqual(
            json.loads(request.data.decode("utf-8")),
            {
                "dag_run_id": "run_123",
                "logical_date": None,
                "conf": {"jobId": "JOB-1"},
                "note": "AskLake run",
            },
        )
        self.assertEqual(dag_run.asklake_status, "queued")
        self.assertEqual(dag_run.dag_run_id, "run_123")

    def test_list_task_instances_maps_airflow_task_states(self):
        def opener(request, timeout=None):
            self.assertEqual(
                request.full_url,
                "http://airflow.local/api/v2/dags/asklake_etl_job/dagRuns/run_123/taskInstances?limit=100",
            )
            return FakeResponse({
                "task_instances": [
                    {"task_id": "read", "dag_id": "asklake_etl_job", "dag_run_id": "run_123", "state": "running"},
                    {"task_id": "write", "dag_id": "asklake_etl_job", "dag_run_id": "run_123", "state": "skipped"},
                ],
            })

        client = AirflowClient(
            AirflowClientConfig(api_base_url="http://airflow.local", dag_id="asklake_etl_job"),
            opener=opener,
        )

        tasks = client.list_task_instances("run_123")

        self.assertEqual([task.asklake_status for task in tasks], ["running", "blocked"])
        self.assertEqual([task.task_id for task in tasks], ["read", "write"])


if __name__ == "__main__":
    unittest.main()
