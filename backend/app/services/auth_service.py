from datetime import datetime, timedelta, timezone
import hashlib
import secrets
from types import SimpleNamespace
from typing import Any

from fastapi import status
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.errors import ApiError
from app.models.base import Base
from app.models.identity import AuthSessionModel, AuthUserModel
from app.repositories.governance_repository import blocked_principal_for_actor
from app.schemas.common import ErrorCode

SESSION_COOKIE_NAME = "asklake_session"
SESSION_TTL_DAYS = 7

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
        self._ensure_tables()
        self._ensure_demo_users()

    def signup(self, *, email: str, password: str, display_name: str) -> dict[str, Any]:
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
        self.db.add(user)
        self.db.commit()
        self.db.refresh(user)
        return self.create_session(user)

    def login(self, *, email: str, password: str) -> dict[str, Any]:
        user = self.db.scalar(select(AuthUserModel).where(AuthUserModel.email == normalize_email(email)))
        if user is None or not verify_password(password, user.password_salt, user.password_hash):
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
        user.last_active_at = now_utc()
        session = self.create_session(user)
        self.db.commit()
        return session

    def create_session(self, user: AuthUserModel) -> dict[str, Any]:
        token = secrets.token_urlsafe(48)
        expires_at = now_utc() + timedelta(days=SESSION_TTL_DAYS)
        session = AuthSessionModel(
            token=token,
            user_id=user.id,
            expires_at=expires_at,
            user_snapshot=user_to_actor(user),
        )
        self.db.add(session)
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

    def _ensure_demo_users(self) -> None:
        changed = False
        for item in DEMO_AUTH_USERS:
            existing = self.db.get(AuthUserModel, item["id"])
            if existing is not None:
                changed = sync_demo_user(existing, item) or changed
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


def load_session_actor(db: Session, token: str | None) -> dict[str, Any] | None:
    return AuthService(db).actor_for_session(token)


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


def sync_demo_user(user: AuthUserModel, item: dict[str, Any]) -> bool:
    changed = False
    updates = {
        "email": str(item["email"]),
        "display_name": str(item["display_name"]),
        "role": str(item["role"]),
        "groups": list(item["groups"]),
        "status": "active",
        "title": str(item["title"]),
    }
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
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000)
    return digest.hex()


def verify_password(password: str, salt: str, expected_hash: str) -> bool:
    return secrets.compare_digest(hash_password(password, salt), expected_hash)


def now_utc() -> datetime:
    return datetime.now(timezone.utc)
