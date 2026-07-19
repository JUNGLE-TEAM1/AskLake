from __future__ import annotations

from io import BytesIO
import json
import unittest
from urllib.error import HTTPError

from app.services.airflow_client import AirflowClient, AirflowClientConfig


class JsonResponse:
    def __init__(self, payload: dict) -> None:
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps(self.payload).encode()


class AirflowClientApiTests(unittest.TestCase):
    def test_get_dag_run_recovers_airflow3_detail_404_from_exact_collection(self) -> None:
        calls = []

        def opener(request, **_options):
            calls.append(request.full_url)
            if len(calls) == 1:
                raise HTTPError(
                    request.full_url,
                    404,
                    "not found",
                    {},
                    BytesIO(b'{"detail":"not found"}'),
                )
            return JsonResponse(
                {
                    "dag_runs": [
                        {
                            "dag_id": "asklake_etl_job",
                            "dag_run_id": "run-target",
                            "state": "success",
                        }
                    ],
                    "total_entries": 1,
                }
            )

        client = AirflowClient(
            AirflowClientConfig(
                api_base_url="http://airflow.invalid/api/v2",
                dag_id="asklake_etl_job",
            ),
            opener=opener,
        )

        run = client.get_dag_run("run-target")

        self.assertEqual(run.dag_run_id, "run-target")
        self.assertEqual(run.asklake_status, "success")
        self.assertEqual(len(calls), 2)
        self.assertIn("limit=100", calls[1])


if __name__ == "__main__":
    unittest.main()
