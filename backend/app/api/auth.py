from typing import Annotated, Any

from fastapi import APIRouter, Cookie, Depends, Request, Response, status
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, get_actor_context
from app.core.config import settings
from app.core.database import get_db
from app.core.errors import ApiError
from app.domain.audit import AuditTargetType
from app.repositories.audit_repository import safe_record_audit_event
from app.schemas.auth import AuthSessionResponse, AuthUserResponse, LoginRequest, LogoutResponse, SignupRequest
from app.services.auth_service import (
    SESSION_COOKIE_NAME,
    SESSION_TTL_DAYS,
    AuthService,
    login_failure_key,
)
from app.services.identity_service import IdentityService

router = APIRouter(prefix="/auth", tags=["auth"])

SESSION_COOKIE_PATH = "/"
SESSION_COOKIE_SAMESITE = "lax"


def get_auth_service(db: Annotated[Session, Depends(get_db)]) -> AuthService:
    return AuthService(db)


def session_cookie_options() -> dict[str, Any]:
    return {
        "httponly": True,
        "path": SESSION_COOKIE_PATH,
        "samesite": SESSION_COOKIE_SAMESITE,
        "secure": settings.uses_secure_session_cookie,
    }


def issue_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        max_age=SESSION_TTL_DAYS * 24 * 60 * 60,
        **session_cookie_options(),
    )


def delete_session_cookie(response: Response) -> None:
    response.delete_cookie(
        key=SESSION_COOKIE_NAME,
        **session_cookie_options(),
    )


@router.post("/signup", response_model=AuthUserResponse, status_code=status.HTTP_201_CREATED)
def signup(
    payload: SignupRequest,
    response: Response,
    service: Annotated[AuthService, Depends(get_auth_service)],
    db: Annotated[Session, Depends(get_db)],
) -> AuthUserResponse:
    session = service.signup(email=payload.email, password=payload.password, display_name=payload.display_name)
    issue_session_cookie(response, str(session["token"]))
    actor = actor_context_from_session(session)
    return AuthUserResponse(user=IdentityService(db).get_current_user(actor))


@router.post("/login", response_model=AuthUserResponse)
def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    service: Annotated[AuthService, Depends(get_auth_service)],
    db: Annotated[Session, Depends(get_db)],
) -> AuthUserResponse:
    try:
        session = service.login(
            email=payload.email,
            password=payload.password,
            rate_limit_key=login_failure_key(
                payload.email,
                login_client_address(request),
            ),
        )
    except ApiError as exc:
        if exc.status_code != status.HTTP_429_TOO_MANY_REQUESTS:
            safe_record_audit_event(
                db,
                action="auth.login.failed",
                actor=ActorContext(name=payload.email, role="anonymous", email=payload.email),
                api_path="/api/auth/login",
                http_method="POST",
                metadata={"email": payload.email},
                result="forbidden" if exc.status_code == status.HTTP_403_FORBIDDEN else "failed",
                status_code=exc.status_code,
                target_id=payload.email,
                target_type=AuditTargetType.AUTH,
            )
        raise
    issue_session_cookie(response, str(session["token"]))
    actor = actor_context_from_session(session)
    safe_record_audit_event(
        db,
        action="auth.login.succeeded",
        actor=actor,
        api_path="/api/auth/login",
        http_method="POST",
        metadata={"email": payload.email},
        result="success",
        status_code=status.HTTP_200_OK,
        target_id=actor.id or actor.email or actor.name,
        target_name=actor.name,
        target_type=AuditTargetType.AUTH,
    )
    return AuthUserResponse(user=IdentityService(db).get_current_user(actor))


def login_client_address(request: Request) -> str | None:
    forwarded_for = request.headers.get("x-forwarded-for", "")
    if forwarded_for:
        return forwarded_for.split(",", 1)[0].strip() or None
    return request.client.host if request.client is not None else None


@router.get("/session", response_model=AuthSessionResponse)
def get_session(
    service: Annotated[AuthService, Depends(get_auth_service)],
    db: Annotated[Session, Depends(get_db)],
    session_token: Annotated[str | None, Cookie(alias=SESSION_COOKIE_NAME)] = None,
) -> AuthSessionResponse:
    session_actor = service.actor_for_session(session_token)
    if session_actor is None:
        return AuthSessionResponse(
            authenticated=False,
            public_signup_enabled=settings.allows_public_signup,
            user=None,
        )
    actor = ActorContext(
        name=str(session_actor.get("name") or "demo-user"),
        role=str(session_actor.get("role") or "viewer"),
        groups=tuple(str(group) for group in session_actor.get("groups") or []),
        id=str(session_actor.get("id") or "") or None,
        email=str(session_actor.get("email") or "") or None,
        title=str(session_actor.get("title") or "") or None,
    )
    return AuthSessionResponse(
        authenticated=True,
        public_signup_enabled=settings.allows_public_signup,
        user=IdentityService(db).get_current_user(actor),
    )


@router.post("/logout", response_model=LogoutResponse)
def logout(
    response: Response,
    service: Annotated[AuthService, Depends(get_auth_service)],
    db: Annotated[Session, Depends(get_db)],
    session_token: Annotated[str | None, Cookie(alias=SESSION_COOKIE_NAME)] = None,
) -> LogoutResponse:
    session_actor = service.actor_for_session(session_token)
    actor = (
        ActorContext(
            name=str(session_actor.get("name") or "demo-user"),
            role=str(session_actor.get("role") or "viewer"),
            groups=tuple(str(group) for group in session_actor.get("groups") or []),
            id=str(session_actor.get("id") or "") or None,
            email=str(session_actor.get("email") or "") or None,
            title=str(session_actor.get("title") or "") or None,
        )
        if session_actor is not None
        else ActorContext(name="anonymous", role="anonymous")
    )
    service.logout(session_token)
    safe_record_audit_event(
        db,
        action="auth.logout.succeeded",
        actor=actor,
        api_path="/api/auth/logout",
        http_method="POST",
        metadata={"email": actor.email},
        result="success",
        status_code=status.HTTP_200_OK,
        target_id=actor.id or actor.email or actor.name,
        target_name=actor.name,
        target_type=AuditTargetType.AUTH,
    )
    delete_session_cookie(response)
    return LogoutResponse()


def actor_context_from_session(session: dict[str, object]) -> ActorContext:
    actor = session["actor"]
    if not isinstance(actor, dict):
        return ActorContext()
    return ActorContext(
        name=str(actor.get("name") or "demo-user"),
        role=str(actor.get("role") or "viewer"),
        groups=tuple(str(group) for group in actor.get("groups") or []),
        id=str(actor.get("id") or "") or None,
        email=str(actor.get("email") or "") or None,
        title=str(actor.get("title") or "") or None,
    )
