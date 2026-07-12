import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.core.auth_context import get_actor_context
from app.core.config import Settings
from app.core.errors import ApiError
from app.main import create_app
from app.models.identity import AuthSessionModel, AuthUserModel
from app.services import auth_service
from app.services.auth_service import AuthService, verify_password


class ActorContextProductionTests(unittest.TestCase):
    def test_production_protected_route_rejects_spoofed_headers_without_a_session(self) -> None:
        with patch("app.core.auth_context.settings", SimpleNamespace(allows_header_auth_fallback=False)):
            response = TestClient(create_app()).get(
                "/api/admin/users",
                headers={"X-AskLake-User": "Spoofed Admin", "X-AskLake-Role": "admin"},
            )

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "UNAUTHORIZED")

    def test_production_rejects_etl_create_without_a_session(self) -> None:
        with patch("app.core.auth_context.settings", SimpleNamespace(allows_header_auth_fallback=False)):
            response = TestClient(create_app()).post(
                "/api/etl/jobs",
                headers={"X-AskLake-User": "Spoofed Admin", "X-AskLake-Role": "admin"},
                json={},
            )

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "UNAUTHORIZED")

    def test_production_rejects_invalid_session_even_with_admin_headers(self) -> None:
        with (
            patch("app.core.auth_context.settings", SimpleNamespace(allows_header_auth_fallback=False)),
            patch("app.core.auth_context.load_session_actor", return_value=None),
        ):
            with self.assertRaises(ApiError) as raised:
                get_actor_context(
                    actor_name="Spoofed Admin",
                    actor_role="admin",
                    session_token="invalid-session",
                    db=object(),
                )

        self.assertEqual(raised.exception.status_code, 401)

    def test_production_uses_a_valid_session_instead_of_headers(self) -> None:
        session_actor = {
            "id": "authenticated-user",
            "name": "Authenticated User",
            "email": "authenticated@example.com",
            "role": "viewer",
            "groups": ["analytics"],
            "title": "Analyst",
        }
        with (
            patch("app.core.auth_context.settings", SimpleNamespace(allows_header_auth_fallback=False)),
            patch("app.core.auth_context.load_session_actor", return_value=session_actor),
        ):
            actor = get_actor_context(
                actor_name="Spoofed Admin",
                actor_role="admin",
                session_token="valid-session",
                db=object(),
            )

        self.assertEqual(actor.name, "Authenticated User")
        self.assertEqual(actor.role, "viewer")

    def test_local_mode_keeps_header_fallback(self) -> None:
        with patch("app.core.auth_context.settings", SimpleNamespace(allows_header_auth_fallback=True)):
            actor = get_actor_context(actor_name="Smoke User", actor_role="admin", db=None)

        self.assertEqual(actor.name, "Smoke User")
        self.assertTrue(actor.is_admin)


class BootstrapAdminTests(unittest.TestCase):
    def test_secure_environment_requires_bootstrap_admin(self) -> None:
        with self.assertRaises(ValueError):
            Settings(app_env="production")

    def test_secure_environment_rejects_bootstrap_placeholders(self) -> None:
        with self.assertRaises(ValueError):
            Settings(
                app_env="production",
                bootstrap_admin_email="replace-with-admin-email@example.invalid",
                bootstrap_admin_password="replace-with-a-unique-bootstrap-password",
            )

    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        AuthUserModel.metadata.create_all(
            bind=self.engine,
            tables=[AuthUserModel.__table__, AuthSessionModel.__table__],
        )
        self.db = Session(self.engine)

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_secure_environment_creates_only_configured_bootstrap_admin_once(self) -> None:
        initial_settings = SimpleNamespace(
            allows_header_auth_fallback=False,
            bootstrap_admin_email="admin@example.com",
            bootstrap_admin_password="initial-password",
            bootstrap_admin_display_name="Production Admin",
        )
        changed_password_settings = SimpleNamespace(
            allows_header_auth_fallback=False,
            bootstrap_admin_email="admin@example.com",
            bootstrap_admin_password="changed-password",
            bootstrap_admin_display_name="Changed Name",
        )

        with patch.object(auth_service, "settings", initial_settings):
            AuthService(self.db)

        admin = self.db.scalar(select(AuthUserModel).where(AuthUserModel.email == "admin@example.com"))
        self.assertIsNotNone(admin)
        assert admin is not None
        self.assertEqual(admin.role, "admin")
        self.assertTrue(verify_password("initial-password", admin.password_salt, admin.password_hash))
        self.assertIsNone(self.db.get(AuthUserModel, "admin-user"))
        self.assertIsNone(self.db.get(AuthUserModel, "demo-user"))

        with patch.object(auth_service, "settings", changed_password_settings):
            AuthService(self.db)

        self.db.refresh(admin)
        self.assertEqual(admin.display_name, "Production Admin")
        self.assertTrue(verify_password("initial-password", admin.password_salt, admin.password_hash))
        self.assertFalse(verify_password("changed-password", admin.password_salt, admin.password_hash))


if __name__ == "__main__":
    unittest.main()
