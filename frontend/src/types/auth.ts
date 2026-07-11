import type { CurrentUserResponse } from "./identity";

export type LoginRequest = {
  email: string;
  password: string;
};

export type SignupRequest = LoginRequest & {
  displayName: string;
};

export type AuthUserResponse = {
  user: CurrentUserResponse;
};

export type AuthSessionResponse = {
  authenticated: boolean;
  user: CurrentUserResponse | null;
};

export type LogoutResponse = {
  ok: boolean;
};
