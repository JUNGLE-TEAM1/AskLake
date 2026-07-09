from typing import Annotated

from fastapi import APIRouter, Cookie, Depends, Response, status
from sqlalchemy.orm import Session

from app.core.auth_context import ActorContext, get_actor_context
from app.core.database import get_db
from app.schemas.auth import AuthSessionResponse, AuthUserResponse, LoginRequest, LogoutResponse, SignupRequest
from app.services.auth_service import SESSION_COOKIE_NAME, SESSION_TTL_DAYS, AuthService
from app.services.identity_service import IdentityService

router = APIRouter(prefix="/auth", tags=["auth"])


def get_auth_service(db: Annotated[Session, Depends(get_db)]) -> AuthService:
    return AuthService(db)


def issue_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        httponly=True,
        max_age=SESSION_TTL_DAYS * 24 * 60 * 60,
        path="/",
        samesite="lax",
        secure=False,
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
    response: Response,
    service: Annotated[AuthService, Depends(get_auth_service)],
    db: Annotated[Session, Depends(get_db)],
) -> AuthUserResponse:
    session = service.login(email=payload.email, password=payload.password)
    issue_session_cookie(response, str(session["token"]))
    actor = actor_context_from_session(session)
    return AuthUserResponse(user=IdentityService(db).get_current_user(actor))


@router.get("/session", response_model=AuthSessionResponse)
def get_session(
    service: Annotated[AuthService, Depends(get_auth_service)],
    db: Annotated[Session, Depends(get_db)],
    session_token: Annotated[str | None, Cookie(alias=SESSION_COOKIE_NAME)] = None,
) -> AuthSessionResponse:
    session_actor = service.actor_for_session(session_token)
    if session_actor is None:
        return AuthSessionResponse(authenticated=False, user=None)
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
        user=IdentityService(db).get_current_user(actor),
    )


@router.post("/logout", response_model=LogoutResponse)
def logout(
    response: Response,
    service: Annotated[AuthService, Depends(get_auth_service)],
    session_token: Annotated[str | None, Cookie(alias=SESSION_COOKIE_NAME)] = None,
) -> LogoutResponse:
    service.logout(session_token)
    response.delete_cookie(key=SESSION_COOKIE_NAME, path="/", samesite="lax")
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
