import unittest
from unittest.mock import Mock, patch

from fastapi import Response

from app.api import sql as sql_api
from app.core.auth_context import ActorContext
from app.schemas.sql import QueryRunRequest
from app.schemas.trino import QueryRunSubmitRequest


class QueryRouteCompatibilityTests(unittest.TestCase):
    def test_omitted_mode_preserves_duckdb_preview_default(self) -> None:
        request = QueryRunSubmitRequest.model_validate({
            "datasetId": "dataset-1",
            "query": "SELECT * FROM dataset_1",
        })
        service = Mock()
        expected_response = object()
        service.create_query_run.return_value = expected_response
        trino_service = Mock()
        actor = ActorContext(name="compatibility-user", role="admin")

        self.assertIsNone(request.mode)

        with patch.object(sql_api.settings, "trino_enabled", False):
            response = sql_api.create_query_run(
                request=request,
                service=service,
                trino_service=trino_service,
                actor=actor,
                response=Response(),
            )

        self.assertIs(response, expected_response)
        trino_service.submit.assert_not_called()
        compatibility_request, called_actor = service.create_query_run.call_args.args
        self.assertIsInstance(compatibility_request, QueryRunRequest)
        self.assertEqual(compatibility_request.mode, "preview")
        self.assertIs(called_actor, actor)


if __name__ == "__main__":
    unittest.main()
