import hashlib
from pathlib import Path
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import Response
from sqlalchemy import create_engine, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.auth import login_client_address
from app.api.health import health_check
from app.core.config import Settings
from app.core.errors import ApiError
from app.models.identity import AuthSessionModel, AuthUserModel
from app.services import auth_service
from app.services.auth_service import AuthService


class OperationalAuthHardeningTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        AuthUserModel.metadata.create_all(
            bind=self.engine,
            tables=[AuthUserModel.__table__, AuthSessionModel.__table__],
        )
        self.db = Session(self.engine)
        auth_service._login_failures_by_key.clear()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()
        auth_service._login_failures_by_key.clear()

    def test_production_signup_is_disabled_by_default(self) -> None:
        production = SimpleNamespace(
            allows_header_auth_fallback=False,
            allows_public_signup=False,
            bootstrap_admin_email="admin@example.com",
            bootstrap_admin_password="strong-bootstrap-password",
            bootstrap_admin_display_name="Production Admin",
        )
        with patch.object(auth_service, "settings", production):
            service = AuthService(self.db)
            with self.assertRaises(ApiError) as raised:
                service.signup(
                    email="new.user@example.com",
                    password="not-used-password",
                    display_name="New User",
                )

        self.assertEqual(raised.exception.status_code, 403)

    def test_legacy_demo_accounts_are_disabled_and_sessions_revoked(self) -> None:
        local = SimpleNamespace(allows_header_auth_fallback=True)
        with patch.object(auth_service, "settings", local):
            local_service = AuthService(self.db)
            admin = self.db.get(AuthUserModel, "admin-user")
            assert admin is not None
            session = local_service.create_session(admin)

        production = SimpleNamespace(
            allows_header_auth_fallback=False,
            bootstrap_admin_email="owner@example.com",
            bootstrap_admin_password="strong-bootstrap-password",
            bootstrap_admin_display_name="Production Owner",
        )
        with patch.object(auth_service, "settings", production):
            AuthService(self.db)

        self.assertEqual(self.db.get(AuthUserModel, "admin-user").status, "disabled")
        self.assertEqual(self.db.get(AuthUserModel, "demo-user").status, "disabled")
        self.assertIsNone(self.db.get(AuthSessionModel, str(session["token"])))

        with (
            patch.object(auth_service, "settings", production),
            patch.object(self.db, "commit", wraps=self.db.commit) as commit,
        ):
            AuthService(self.db)
        commit.assert_not_called()

    def test_legacy_password_hash_is_upgraded_after_successful_login(self) -> None:
        password = "legacy-password"
        salt = "legacy-salt"
        legacy_hash = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            salt.encode("utf-8"),
            auth_service.LEGACY_PBKDF2_ITERATIONS,
        ).hex()
        user = AuthUserModel(
            id="legacy-user",
            email="legacy@example.com",
            display_name="Legacy User",
            password_salt=salt,
            password_hash=legacy_hash,
            role="viewer",
            groups=[],
            status="active",
            title="Analyst",
        )
        self.db.add(user)
        self.db.commit()

        local = SimpleNamespace(allows_header_auth_fallback=True)
        with patch.object(auth_service, "settings", local):
            AuthService(self.db).login(email=user.email, password=password)

        self.db.refresh(user)
        self.assertTrue(user.password_hash.startswith("pbkdf2_sha256$600000$"))
        self.assertTrue(auth_service.verify_password(password, salt, user.password_hash))

    def test_untrusted_hash_metadata_cannot_request_unbounded_work(self) -> None:
        iterations, _digest = auth_service.password_hash_parts(
            "pbkdf2_sha256$999999999999$malformed"
        )
        self.assertEqual(iterations, auth_service.LEGACY_PBKDF2_ITERATIONS)

    def test_repeated_bad_passwords_are_rate_limited(self) -> None:
        local = SimpleNamespace(allows_header_auth_fallback=True)
        with patch.object(auth_service, "settings", local):
            service = AuthService(self.db)
            for _attempt in range(auth_service.LOGIN_FAILURE_LIMIT):
                with self.assertRaises(ApiError) as raised:
                    service.login(email="missing@example.com", password="wrong-password")
                self.assertEqual(raised.exception.status_code, 401)

            with self.assertRaises(ApiError) as limited:
                service.login(email="missing@example.com", password="wrong-password")

        self.assertEqual(limited.exception.status_code, 429)

    def test_rate_limit_blocks_the_same_client_but_not_a_different_client(self) -> None:
        local = SimpleNamespace(allows_header_auth_fallback=True)
        with patch.object(auth_service, "settings", local):
            service = AuthService(self.db)
            admin = self.db.get(AuthUserModel, "admin-user")
            assert admin is not None
            first_client = auth_service.login_failure_key(admin.email, "203.0.113.10")
            second_client = auth_service.login_failure_key(admin.email, "203.0.113.11")
            for _attempt in range(auth_service.LOGIN_FAILURE_LIMIT + 1):
                with self.assertRaises(ApiError):
                    service.login(
                        email=admin.email,
                        password="wrong-password",
                        rate_limit_key=first_client,
                    )

            with self.assertRaises(ApiError) as limited:
                service.login(
                    email=admin.email,
                    password="asklake-admin",
                    rate_limit_key=first_client,
                )
            session = service.login(
                email=admin.email,
                password="asklake-admin",
                rate_limit_key=second_client,
            )

        self.assertEqual(limited.exception.status_code, 429)
        self.assertIn("token", session)
        self.assertIn(first_client, auth_service._login_failures_by_key)
        self.assertNotIn(second_client, auth_service._login_failures_by_key)

    def test_login_rate_limit_uses_the_original_forwarded_client(self) -> None:
        request = SimpleNamespace(
            headers={"x-forwarded-for": "203.0.113.20, 10.0.0.4"},
            client=SimpleNamespace(host="10.0.0.4"),
        )
        self.assertEqual(login_client_address(request), "203.0.113.20")

    def test_missing_user_still_executes_dummy_password_verification(self) -> None:
        local = SimpleNamespace(allows_header_auth_fallback=True)
        with (
            patch.object(auth_service, "settings", local),
            patch.object(auth_service, "verify_password", wraps=auth_service.verify_password) as verify,
        ):
            service = AuthService(self.db)
            with self.assertRaises(ApiError):
                service.login(email="missing@example.com", password="wrong-password")

        verify.assert_called_once_with(
            "wrong-password",
            auth_service.DUMMY_PASSWORD_SALT,
            auth_service.DUMMY_PASSWORD_HASH,
        )

    def test_signup_rolls_back_user_when_session_creation_fails(self) -> None:
        local = SimpleNamespace(allows_header_auth_fallback=True, allows_public_signup=True)
        with patch.object(auth_service, "settings", local):
            service = AuthService(self.db)
            with (
                patch.object(service, "create_session", side_effect=RuntimeError("session failed")),
                self.assertRaises(RuntimeError),
            ):
                service.signup(
                    email="transaction@example.com",
                    password="transaction-password",
                    display_name="Transaction User",
                )

        self.assertIsNone(
            self.db.scalar(select(AuthUserModel).where(AuthUserModel.email == "transaction@example.com"))
        )


class ProductionConfigurationHardeningTests(unittest.TestCase):
    def test_production_rejects_wildcard_or_insecure_cors_origins(self) -> None:
        for origins in (["*"], ["http://app.example.com"]):
            with self.subTest(origins=origins):
                with self.assertRaises(ValueError):
                    Settings(
                        app_env="production",
                        bootstrap_admin_email="owner@example.com",
                        bootstrap_admin_password="strong-bootstrap-password",
                        backend_cors_origins=origins,
                    )

    def test_production_rejects_known_demo_bootstrap_credentials(self) -> None:
        with self.assertRaises(ValueError):
            Settings(
                app_env="production",
                bootstrap_admin_email="admin.user@asklake.local",
                bootstrap_admin_password="asklake-admin",
                backend_cors_origins=[],
            )

    def test_production_requires_valid_admin_email_and_long_password(self) -> None:
        for email, password in (
            ("invalid-email", "strong-bootstrap-password"),
            ("owner@example.com", "too-short"),
        ):
            with self.subTest(email=email):
                with self.assertRaises(ValueError):
                    Settings(
                        app_env="production",
                        bootstrap_admin_email=email,
                        bootstrap_admin_password=password,
                        backend_cors_origins=[],
                    )

    def test_cors_origin_trailing_slash_is_normalized(self) -> None:
        configured = Settings(
            app_env="production",
            bootstrap_admin_email="owner@example.com",
            bootstrap_admin_password="strong-bootstrap-password",
            backend_cors_origins=["https://app.example.com/"],
        )
        self.assertEqual(configured.backend_cors_origins, ["https://app.example.com"])

    def test_health_returns_503_when_database_probe_fails(self) -> None:
        response = Response()
        with patch("app.api.health.SessionLocal", side_effect=SQLAlchemyError("db down")):
            payload = health_check(response)

        self.assertFalse(payload.ok)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(payload.status_code, 503)

    def test_production_proxy_sets_baseline_browser_security_headers(self) -> None:
        caddyfile = (Path(__file__).resolve().parents[2] / "deploy" / "Caddyfile").read_text(encoding="utf-8")
        for header in (
            "Content-Security-Policy",
            "Permissions-Policy",
            "Referrer-Policy",
            "Strict-Transport-Security",
            "X-Content-Type-Options",
            "X-Frame-Options",
        ):
            with self.subTest(header=header):
                self.assertIn(header, caddyfile)
        self.assertIn("https://fonts.googleapis.com", caddyfile)
        self.assertIn("https://www.youtube.com", caddyfile)


if __name__ == "__main__":
    unittest.main()
