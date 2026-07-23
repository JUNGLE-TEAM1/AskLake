from types import SimpleNamespace
import unittest
from unittest.mock import patch

from pydantic import ValidationError

from app.core.config import Settings
from app.core.errors import ApiError
from app.repositories.etl_repository import public_sql_recipe
from app.services import auth_service, etl_service


class TrinoProductionHardeningTests(unittest.TestCase):
    def test_disabled_production_does_not_require_trino_secrets(self) -> None:
        settings = Settings(
            _env_file=None,
            app_env="production",
            backend_cors_origins=["https://asklake.test"],
            bootstrap_admin_email="admin@asklake.test",
            bootstrap_admin_password="a-production-password",
            trino_enabled=False,
        )

        self.assertFalse(settings.trino_enabled)

    def test_enabled_production_rejects_local_trino_defaults(self) -> None:
        with self.assertRaises(ValidationError):
            Settings(
                _env_file=None,
                app_env="production",
                backend_cors_origins=["https://asklake.test"],
                bootstrap_admin_email="admin@asklake.test",
                bootstrap_admin_password="a-production-password",
                trino_enabled=True,
                trino_base_url="https://trino:8443",
            )

    def test_enabled_production_accepts_distinct_non_placeholder_secrets(self) -> None:
        settings = Settings(
            _env_file=None,
            app_env="production",
            backend_cors_origins=["https://asklake.test"],
            bootstrap_admin_email="admin@asklake.test",
            bootstrap_admin_password="a-production-password",
            trino_enabled=True,
            trino_base_url="https://trino:8443",
            trino_auth_username="asklake-api",
            trino_auth_password="query-password-123",
            trino_materializer_username="asklake-materializer",
            trino_materializer_password="materializer-password-123",
            trino_tls_ca_file="/run/secrets/trino-ca.pem",
            trino_result_storage_bucket="asklake-prod-query-results",
            trino_result_cursor_secret="cursor-secret-123456789012345678901234",
            trino_query_confirmation_secret="confirmation-secret-12345678901234567890",
        )

        self.assertTrue(settings.trino_enabled)

    def test_public_recipe_removes_legacy_identity_snapshot(self) -> None:
        recipe = public_sql_recipe(
            {
                "query": "SELECT 1",
                "runAs": {
                    "id": "user-1",
                    "email": "stale@example.test",
                    "groups": ["stale"],
                    "role": "admin",
                },
            }
        )

        self.assertEqual(recipe, {"query": "SELECT 1", "runAsUserId": "user-1"})

    def test_scheduled_actor_uses_current_auth_record(self) -> None:
        job = SimpleNamespace(
            sql_recipe={"runAsUserId": "user-1"},
            created_by="Original User",
            owner="Original User",
        )
        current_actor = {
            "id": "user-1",
            "name": "Current User",
            "email": "current@example.test",
            "role": "viewer",
            "groups": ["current-group"],
            "title": "Analyst",
        }

        with patch.object(etl_service, "load_active_actor_by_user_id", return_value=current_actor):
            actor = etl_service.trino_sql_job_run_as_actor(SimpleNamespace(), job)

        self.assertEqual(actor.role, "viewer")
        self.assertEqual(actor.groups, ("current-group",))
        self.assertEqual(actor.email, "current@example.test")

    def test_inactive_scheduled_actor_fails_closed(self) -> None:
        job = SimpleNamespace(
            sql_recipe={"runAsUserId": "disabled-user"},
            created_by="Disabled User",
            owner="Disabled User",
        )
        with patch.object(etl_service, "load_active_actor_by_user_id", return_value=None):
            with patch.object(etl_service, "settings", SimpleNamespace(allows_header_auth_fallback=False)):
                with self.assertRaises(ApiError) as raised:
                    etl_service.trino_sql_job_run_as_actor(SimpleNamespace(), job)

        self.assertEqual(raised.exception.status_code, 403)

    def test_local_header_actor_keeps_id_but_drops_stale_privileges(self) -> None:
        job = SimpleNamespace(
            sql_recipe={
                "runAsUserId": "header-user",
                "runAs": {"id": "header-user", "role": "admin", "groups": ["stale-admins"]},
            },
            created_by="Header User",
            owner="Header User",
        )
        with patch.object(etl_service, "load_active_actor_by_user_id", return_value=None):
            with patch.object(etl_service, "settings", SimpleNamespace(allows_header_auth_fallback=True)):
                actor = etl_service.trino_sql_job_run_as_actor(SimpleNamespace(), job)

        self.assertEqual(actor.id, "header-user")
        self.assertEqual(actor.role, "viewer")
        self.assertEqual(actor.groups, ())

    def test_local_legacy_actor_does_not_reuse_admin_snapshot(self) -> None:
        job = SimpleNamespace(
            sql_recipe={"runAs": {"role": "admin", "groups": ["stale-admins"]}},
            created_by="Legacy User",
            owner="Legacy User",
        )
        with patch.object(etl_service, "settings", SimpleNamespace(allows_header_auth_fallback=True)):
            actor = etl_service.trino_sql_job_run_as_actor(SimpleNamespace(), job)

        self.assertEqual(actor.role, "viewer")
        self.assertEqual(actor.groups, ())

    def test_auth_lookup_rejects_disabled_and_blocked_users(self) -> None:
        user = SimpleNamespace(
            id="user-1",
            email="user@example.test",
            display_name="User",
            role="editor",
            groups=["analytics"],
            status="disabled",
            title="Analyst",
        )
        db = SimpleNamespace(get=lambda _model, _user_id: user)
        self.assertIsNone(auth_service.load_active_actor_by_user_id(db, user.id))

        user.status = "active"
        with patch.object(auth_service, "blocked_principal_for_actor", return_value=object()):
            self.assertIsNone(auth_service.load_active_actor_by_user_id(db, user.id))


if __name__ == "__main__":
    unittest.main()
