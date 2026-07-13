import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import Response
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.api import auth as auth_api
from app.core.auth_context import get_actor_context
from app.core.config import Settings
from app.core.errors import ApiError
from app.api.demo_hydration import require_local_demo_mode
from app.api.harness import require_local_harness_mode
from app.main import create_app
from app import main as main_module
from app.models.identity import AuthSessionModel, AuthUserModel
from app.services import auth_service
from app.services.auth_service import initialize_auth, verify_password


class ActorContextProductionTests(unittest.TestCase):
    def test_production_protected_route_rejects_spoofed_headers_without_a_session(self) -> None:
        with patch("app.core.auth_context.settings", SimpleNamespace(allows_header_auth_fallback=False)):
            response = TestClient(create_app()).get(
                "/api/admin/users",
                headers={"X-AskLake-User": "Spoofed Admin", "X-AskLake-Role": "admin"},
            )

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "UNAUTHORIZED")

    def test_production_disables_demo_and_harness_routes(self) -> None:
        production = SimpleNamespace(allows_header_auth_fallback=False)
        for module_path, guard in (
            ("app.api.demo_hydration.settings", require_local_demo_mode),
            ("app.api.harness.settings", require_local_harness_mode),
        ):
            with patch(module_path, production):
                with self.assertRaises(ApiError) as raised:
                    guard()
            self.assertEqual(raised.exception.status_code, 404)

    def test_production_does_not_allow_arbitrary_localhost_cors_origins(self) -> None:
        production = SimpleNamespace(
            allows_header_auth_fallback=False,
            api_prefix="/api",
            app_name="AskLake test",
            backend_cors_origins=[],
        )
        with patch.object(main_module, "settings", production):
            app = main_module.create_app()

        cors = next(middleware for middleware in app.user_middleware if middleware.cls.__name__ == "CORSMiddleware")
        self.assertIsNone(cors.kwargs["allow_origin_regex"])

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


class SessionCookieHardeningTests(unittest.TestCase):
    def _cookie_headers(self, configured_settings: Settings) -> tuple[str, str]:
        issued = Response()
        deleted = Response()
        with patch.object(auth_api, "settings", configured_settings):
            auth_api.issue_session_cookie(issued, "session-token")
            auth_api.delete_session_cookie(deleted)
        return issued.headers["set-cookie"], deleted.headers["set-cookie"]

    def _assert_aligned_cookie_options(self, headers: tuple[str, str], *, secure: bool) -> None:
        for header in headers:
            with self.subTest(header=header):
                self.assertIn("asklake_session=", header)
                self.assertIn("; HttpOnly", header)
                self.assertIn("; Path=/", header)
                self.assertIn("; SameSite=lax", header)
                if secure:
                    self.assertIn("; Secure", header)
                else:
                    self.assertNotIn("; Secure", header)

    def test_fail_closed_issue_and_delete_cookie_headers_are_secure_and_aligned(self) -> None:
        for app_env in ("production", "staging"):
            with self.subTest(app_env=app_env):
                configured = Settings(
                    app_env=app_env,
                    bootstrap_admin_email="owner@example.com",
                    bootstrap_admin_password="strong-bootstrap-password",
                    backend_cors_origins=[],
                    _env_file=None,
                )
                issued, deleted = self._cookie_headers(configured)

                self._assert_aligned_cookie_options((issued, deleted), secure=True)
                self.assertIn("Max-Age=604800", issued)
                self.assertIn("Max-Age=0", deleted)

    def test_local_and_test_cookie_headers_are_not_secure_and_remain_aligned(self) -> None:
        for app_env in ("local", "test"):
            with self.subTest(app_env=app_env):
                configured = Settings(
                    app_env=app_env,
                    bootstrap_admin_email=None,
                    bootstrap_admin_password=None,
                    backend_cors_origins=[],
                    _env_file=None,
                )
                self._assert_aligned_cookie_options(
                    self._cookie_headers(configured),
                    secure=False,
                )


class AuthStartupTests(unittest.TestCase):
    def test_lifespan_initializes_auth_before_serving_requests(self) -> None:
        state = {"initialized": False}
        startup_db = object()

        def mark_initialized(db: object) -> None:
            state["initialized"] = db is startup_db

        app = create_app()

        @app.get("/startup-state")
        def startup_state() -> dict[str, bool]:
            return state

        with (
            patch.object(main_module, "SessionLocal") as session_factory,
            patch.object(main_module, "initialize_auth", side_effect=mark_initialized) as initializer,
            patch.object(main_module, "sync_active_kafka_continuous_runtimes"),
        ):
            session_factory.return_value.__enter__.return_value = startup_db
            with TestClient(app) as client:
                response = client.get("/startup-state")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"initialized": True})
        session_factory.assert_called_once_with()
        initializer.assert_called_once_with(startup_db)
        session_factory.return_value.__exit__.assert_called_once()

    def test_lifespan_propagates_auth_initialization_conflicts(self) -> None:
        with (
            patch.object(main_module, "SessionLocal") as session_factory,
            patch.object(
                main_module,
                "initialize_auth",
                side_effect=RuntimeError("bootstrap identity conflict"),
            ),
        ):
            session_factory.return_value.__enter__.return_value = object()
            with self.assertRaisesRegex(RuntimeError, "bootstrap identity conflict"):
                with TestClient(create_app()):
                    pass


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
            initialize_auth(self.db)

        admin = self.db.scalar(select(AuthUserModel).where(AuthUserModel.email == "admin@example.com"))
        self.assertIsNotNone(admin)
        assert admin is not None
        self.assertEqual(admin.role, "admin")
        self.assertTrue(verify_password("initial-password", admin.password_salt, admin.password_hash))
        self.assertIsNone(self.db.get(AuthUserModel, "admin-user"))
        self.assertIsNone(self.db.get(AuthUserModel, "demo-user"))

        with patch.object(auth_service, "settings", changed_password_settings):
            initialize_auth(self.db)

        self.db.refresh(admin)
        self.assertEqual(admin.display_name, "Production Admin")
        self.assertTrue(verify_password("initial-password", admin.password_salt, admin.password_hash))
        self.assertFalse(verify_password("changed-password", admin.password_salt, admin.password_hash))

    def test_secure_environment_rejects_existing_non_admin_bootstrap_identity(self) -> None:
        salt = "viewer-salt"
        self.db.add(AuthUserModel(
            id="existing-viewer",
            email="admin@example.com",
            display_name="Existing Viewer",
            password_salt=salt,
            password_hash=auth_service.hash_password("viewer-password", salt),
            role="viewer",
            groups=["analytics"],
            status="active",
            title="Data Viewer",
        ))
        self.db.commit()
        production_settings = SimpleNamespace(
            allows_header_auth_fallback=False,
            bootstrap_admin_email="admin@example.com",
            bootstrap_admin_password="bootstrap-password",
            bootstrap_admin_display_name="Production Admin",
        )

        with patch.object(auth_service, "settings", production_settings):
            with self.assertRaisesRegex(RuntimeError, "non-active administrator"):
                initialize_auth(self.db)


if __name__ == "__main__":
    unittest.main()
