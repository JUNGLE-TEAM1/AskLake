from pydantic import Field

from app.schemas.common import CamelModel
from app.schemas.identity import CurrentUserResponse


class SignupRequest(CamelModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=8, max_length=128)
    display_name: str = Field(min_length=1, max_length=80)


class LoginRequest(CamelModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=1, max_length=128)


class AuthSessionResponse(CamelModel):
    authenticated: bool
    user: CurrentUserResponse | None = None


class AuthUserResponse(CamelModel):
    user: CurrentUserResponse


class LogoutResponse(CamelModel):
    ok: bool = True
