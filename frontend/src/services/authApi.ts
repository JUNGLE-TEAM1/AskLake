import type { AuthSessionResponse, AuthUserResponse, LoginRequest, LogoutResponse, SignupRequest } from "../types";
import { apiClient } from "./apiClient";

export async function fetchAuthSession(): Promise<AuthSessionResponse> {
  return apiClient.get<AuthSessionResponse>("/api/auth/session");
}

export async function login(payload: LoginRequest): Promise<AuthUserResponse> {
  return apiClient.post<AuthUserResponse>("/api/auth/login", payload);
}

export async function signup(payload: SignupRequest): Promise<AuthUserResponse> {
  return apiClient.post<AuthUserResponse>("/api/auth/signup", payload);
}

export async function logout(): Promise<LogoutResponse> {
  return apiClient.post<LogoutResponse>("/api/auth/logout", {});
}
