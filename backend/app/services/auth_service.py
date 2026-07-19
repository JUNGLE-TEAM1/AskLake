from datetime import datetime, timedelta, timezone
import hashlib
import secrets
from threading import Lock
from types import SimpleNamespace
from typing import Any

from fastapi import status
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import ApiError
from app.models.base import Base
from app.models.identity import AuthSessionModel, AuthUserModel
from app.repositories.governance_repository import blocked_principal_for_actor
from app.schemas.common import ErrorCode

SESSION_COOKIE_NAME = "asklake_session"
SESSION_TTL_DAYS = 7
LEGACY_PBKDF2_ITERATIONS = 120_000
PBKDF2_ITERATIONS = 600_000
MAX_PBKDF2_ITERATIONS = 1_200_000
PASSWORD_HASH_SCHEME = "pbkdf2_sha256"
LOGIN_FAILURE_LIMIT = 5
LOGIN_FAILURE_WINDOW = timedelta(minutes=15)
DUMMY_PASSWORD_SALT = "asklake-dummy-auth-salt-v1"

_login_failure_lock = Lock()
_login_failures_by_key: dict[str, list[datetime]] = {}

DEMO_AUTH_USERS = [
    {
        "id": "admin-user",
        "email": "admin.user@asklake.local",
        "display_name": "Admin User",
        "password": "asklake-admin",
        "role": "admin",
        "groups": [],
        "title": "Platform Admin",
    },
    {
        "id": "demo-user",
        "email": "demo.user@asklake.local",
        "display_name": "Demo User",
        "password": "asklake-demo",
        "role": "viewer",
        "groups": ["analytics"],
        "title": "Data Viewer",
    },
]


class AuthService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def signup(self, *, email: str, password: str, display_name: str) -> dict[str, Any]:
        if not settings.allows_public_signup:
            raise ApiError(
                ErrorCode.FORBIDDEN,
                "Public account signup is disabled. Contact an AskLake administrator.",
                status.HTTP_403_FORBIDDEN,
            )
        normalized_email = normalize_email(email)
        if "@" not in normalized_email or "." not in normalized_email.rsplit("@", 1)[-1]:
            raise ApiError(
                ErrorCode.VALIDATION_ERROR,
                "올바른 이메일 형식을 입력해주세요.",
                status.HTTP_400_BAD_REQUEST,
            )
        existing = self.db.scalar(select(AuthUserModel).where(AuthUserModel.email == normalized_email))
        if existing is not None:
            raise ApiError(
                ErrorCode.CONFLICT,
                "이미 가입된 이메일입니다.",
                status.HTTP_409_CONFLICT,
            )
        user = AuthUserModel(
            id=unique_user_id(display_name),
            email=normalized_email,
            display_name=display_name.strip(),
            password_salt=secrets.token_hex(16),
            password_hash="",
            role="viewer",
            groups=["analytics"],
            status="active",
            title="AskLake User",
        )
        user.password_hash = hash_password(password, user.password_salt)
        try:
            self.db.add(user)
            self.db.flush()
            session = self.create_session(user, commit=False)
            self.db.commit()
            self.db.refresh(user)
            return session
        except Exception:
            self.db.rollback()
            raise

    def login(
        self,
        *,
        email: str,
        password: str,
        rate_limit_key: str | None = None,
    ) -> dict[str, Any]:
        normalized_email = normalize_email(email)
        failure_key = rate_limit_key or normalized_email
        if is_login_rate_limited(failure_key):
            raise login_rate_limited_error()
        user = self.db.scalar(select(AuthUserModel).where(AuthUserModel.email == normalized_email))
        password_valid = verify_password(
            password,
            user.password_salt if user is not None else DUMMY_PASSWORD_SALT,
            user.password_hash if user is not None else DUMMY_PASSWORD_HASH,
        )
        if user is None or not password_valid:
            if record_login_failure(failure_key):
                raise login_rate_limited_error()
            raise ApiError(
                ErrorCode.UNAUTHORIZED,
                "이메일 또는 비밀번호를 확인해주세요.",
                status.HTTP_401_UNAUTHORIZED,
            )
        if user.status != "active":
            raise ApiError(
                ErrorCode.FORBIDDEN,
                "비활성화된 계정입니다.",
                status.HTTP_403_FORBIDDEN,
            )
        blocked_principal = blocked_principal_for_actor(self.db, user_actor_namespace(user))
        if blocked_principal is not None:
            raise ApiError(
                ErrorCode.FORBIDDEN,
                "계정 접근이 제한되었습니다. 관리자에게 문의하세요.",
                status.HTTP_403_FORBIDDEN,
                {"principalType": blocked_principal.principal_type, "principalId": blocked_principal.principal_id},
            )
        clear_login_failures(failure_key)
        if password_needs_rehash(user.password_hash):
            user.password_hash = hash_password(password, user.password_salt)
        user.last_active_at = now_utc()
        try:
            session = self.create_session(user, commit=False)
            self.db.commit()
            return session
        except Exception:
            self.db.rollback()
            raise

    def create_session(self, user: AuthUserModel, *, commit: bool = True) -> dict[str, Any]:
        token = secrets.token_urlsafe(48)
        expires_at = now_utc() + timedelta(days=SESSION_TTL_DAYS)
        session = AuthSessionModel(
            token=token,
            user_id=user.id,
            expires_at=expires_at,
            user_snapshot=user_to_actor(user),
        )
        self.db.add(session)
        if commit:
            self.db.commit()
        return {
            "token": token,
            "expires_at": expires_at,
            "actor": user_to_actor(user),
        }

    def logout(self, token: str | None) -> None:
        if not token:
            return
        self.db.execute(delete(AuthSessionModel).where(AuthSessionModel.token == token))
        self.db.commit()

    def actor_for_session(self, token: str | None) -> dict[str, Any] | None:
        if not token:
            return None
        session = self.db.get(AuthSessionModel, token)
        if session is None:
            return None
        if session.expires_at <= now_utc():
            self.db.delete(session)
            self.db.commit()
            return None
        user = self.db.get(AuthUserModel, session.user_id)
        if user is None or user.status != "active":
            return None
        if blocked_principal_for_actor(self.db, user_actor_namespace(user)) is not None:
            return None
        return user_to_actor(user)

    def _ensure_tables(self) -> None:
        Base.metadata.create_all(bind=self.db.get_bind(), tables=[AuthUserModel.__table__, AuthSessionModel.__table__])

    def _ensure_demo_users(self, *, preserve_existing_status: bool = False) -> None:
        changed = False
        for item in DEMO_AUTH_USERS:
            existing = self.db.get(AuthUserModel, item["id"])
            if existing is not None:
                changed = sync_demo_user(
                    existing,
                    item,
                    preserve_existing_status=preserve_existing_status,
                ) or changed
                continue
            salt = secrets.token_hex(16)
            self.db.add(
                AuthUserModel(
                    id=str(item["id"]),
                    email=str(item["email"]),
                    display_name=str(item["display_name"]),
                    password_salt=salt,
                    password_hash=hash_password(str(item["password"]), salt),
                    role=str(item["role"]),
                    groups=list(item["groups"]),
                    status="active",
                    title=str(item["title"]),
                )
            )
            changed = True
        if changed:
            self.db.commit()

    def _disable_legacy_demo_users(self) -> None:
        demo_ids = [str(item["id"]) for item in DEMO_AUTH_USERS]
        demo_emails = [str(item["email"]) for item in DEMO_AUTH_USERS]
        users = list(self.db.scalars(
            select(AuthUserModel).where(
                AuthUserModel.id.in_(demo_ids) | AuthUserModel.email.in_(demo_emails)
            )
        ))
        if not users:
            return
        user_ids = [user.id for user in users]
        changed = False
        for user in users:
            if user.status != "disabled":
                user.status = "disabled"
                changed = True
        deleted = self.db.execute(delete(AuthSessionModel).where(AuthSessionModel.user_id.in_(user_ids)))
        if changed or int(getattr(deleted, "rowcount", 0) or 0) > 0:
            self.db.commit()

    def _ensure_bootstrap_admin(self) -> None:
        email = settings.bootstrap_admin_email
        password = settings.bootstrap_admin_password
        if not email or not password:
            return

        normalized_email = normalize_email(email)
        existing = self.db.scalar(select(AuthUserModel).where(AuthUserModel.email == normalized_email))
        if existing is not None:
            if existing.role != "admin" or existing.status != "active":
                raise RuntimeError(
                    "BOOTSTRAP_ADMIN_EMAIL is already assigned to a non-active administrator account. "
                    "Choose another bootstrap email or promote the account explicitly before deployment."
                )
            return

        salt = secrets.token_hex(16)
        self.db.add(
            AuthUserModel(
                id=unique_user_id("bootstrap-admin"),
                email=normalized_email,
                display_name=settings.bootstrap_admin_display_name.strip() or "AskLake Administrator",
                password_salt=salt,
                password_hash=hash_password(password, salt),
                role="admin",
                groups=[],
                status="active",
                title="Platform Admin",
            )
        )
        self.db.commit()


def initialize_auth(db: Session) -> None:
    service = AuthService(db)
    try:
        service._ensure_tables()
        if settings.allows_header_auth_fallback:
            service._ensure_demo_users()
        elif getattr(settings, "auth_legacy_demo_users_enabled", False):
            service._ensure_demo_users()
            service._ensure_bootstrap_admin()
        else:
            service._disable_legacy_demo_users()
            service._ensure_bootstrap_admin()
    except Exception:
        db.rollback()
        raise


def load_session_actor(db: Session, token: str | None) -> dict[str, Any] | None:
    return AuthService(db).actor_for_session(token)


def load_active_actor_by_user_id(db: Session, user_id: str | None) -> dict[str, Any] | None:
    """Resolve a durable execution identity from the current auth record.

    Scheduled work must not reuse the role/group snapshot captured when a Job
    was created.  Returning ``None`` for deleted, disabled, or governance-
    blocked users makes callers fail closed before executing stored work.
    """
    normalized_user_id = str(user_id or "").strip()
    if not normalized_user_id:
        return None
    user = db.get(AuthUserModel, normalized_user_id)
    if user is None or user.status != "active":
        return None
    if blocked_principal_for_actor(db, user_actor_namespace(user)) is not None:
        return None
    return user_to_actor(user)


def user_to_actor(user: AuthUserModel) -> dict[str, Any]:
    return {
        "id": user.id,
        "name": user.display_name,
        "email": user.email,
        "role": user.role,
        "groups": list(user.groups or []),
        "title": user.title,
    }


def user_actor_namespace(user: AuthUserModel) -> SimpleNamespace:
    return SimpleNamespace(
        id=user.id,
        email=user.email,
        name=user.display_name,
        groups=tuple(user.groups or []),
    )


def sync_demo_user(
    user: AuthUserModel,
    item: dict[str, Any],
    *,
    preserve_existing_status: bool = False,
) -> bool:
    changed = False
    updates = {
        "email": str(item["email"]),
        "display_name": str(item["display_name"]),
        "role": str(item["role"]),
        "groups": list(item["groups"]),
        "title": str(item["title"]),
    }
    if not preserve_existing_status:
        updates["status"] = "active"
    for field, value in updates.items():
        if getattr(user, field) != value:
            setattr(user, field, value)
            changed = True
    return changed


def normalize_email(email: str) -> str:
    return email.strip().casefold()


def unique_user_id(display_name: str) -> str:
    base = "".join(character.lower() if character.isalnum() else "-" for character in display_name.strip())
    base = "-".join(part for part in base.split("-") if part) or "user"
    return f"{base}-{secrets.token_hex(4)}"


def hash_password(password: str, salt: str) -> str:
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt.encode("utf-8"),
        PBKDF2_ITERATIONS,
    )
    return f"{PASSWORD_HASH_SCHEME}${PBKDF2_ITERATIONS}${digest.hex()}"


def verify_password(password: str, salt: str, expected_hash: str) -> bool:
    iterations, expected_digest = password_hash_parts(expected_hash)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt.encode("utf-8"),
        iterations,
    ).hex()
    return secrets.compare_digest(digest, expected_digest)


def password_hash_parts(value: str) -> tuple[int, str]:
    parts = value.split("$", 2)
    if len(parts) == 3 and parts[0] == PASSWORD_HASH_SCHEME and parts[1].isdigit():
        iterations = int(parts[1])
        if 0 < iterations <= MAX_PBKDF2_ITERATIONS and parts[2]:
            return iterations, parts[2]
    return LEGACY_PBKDF2_ITERATIONS, value


def password_needs_rehash(value: str) -> bool:
    iterations, _digest = password_hash_parts(value)
    return not value.startswith(f"{PASSWORD_HASH_SCHEME}$") or iterations < PBKDF2_ITERATIONS


def login_failure_key(email: str, client_address: str | None) -> str:
    normalized_address = (client_address or "unknown").strip().casefold() or "unknown"
    return f"{normalize_email(email)}|{normalized_address}"


def is_login_rate_limited(key: str) -> bool:
    now = now_utc()
    with _login_failure_lock:
        prune_login_failures(now)
        return len(_login_failures_by_key.get(key, [])) > LOGIN_FAILURE_LIMIT


def record_login_failure(key: str) -> bool:
    now = now_utc()
    with _login_failure_lock:
        prune_login_failures(now)
        failures = _login_failures_by_key.setdefault(key, [])
        failures.append(now)
        return len(failures) > LOGIN_FAILURE_LIMIT


def clear_login_failures(key: str) -> None:
    with _login_failure_lock:
        _login_failures_by_key.pop(key, None)


def prune_login_failures(now: datetime) -> None:
    cutoff = now - LOGIN_FAILURE_WINDOW
    for key, failures in list(_login_failures_by_key.items()):
        active = [failure for failure in failures if failure >= cutoff]
        if active:
            _login_failures_by_key[key] = active
        else:
            _login_failures_by_key.pop(key, None)


def login_rate_limited_error() -> ApiError:
    return ApiError(
        ErrorCode.RATE_LIMITED,
        "Too many failed login attempts. Try again later.",
        status.HTTP_429_TOO_MANY_REQUESTS,
        {"retryAfterSeconds": int(LOGIN_FAILURE_WINDOW.total_seconds())},
    )


DUMMY_PASSWORD_HASH = hash_password("not-a-real-password", DUMMY_PASSWORD_SALT)


def now_utc() -> datetime:
    return datetime.now(timezone.utc)
