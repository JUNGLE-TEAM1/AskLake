import type { AuthSessionResponse, AuthUserResponse, CurrentUserResponse, LoginRequest, LogoutResponse, SignupRequest } from "../types";
import { apiClient, apiConfig } from "./apiClient";

const mockSessionKey = "asklake.mockAuthUser";
const mockAutoAuth = String(import.meta.env.VITE_MOCK_AUTHENTICATED ?? "false").toLowerCase() === "true";

const mockAdminUser: CurrentUserResponse = {
  displayName: "AskLake Admin",
  email: "admin.user@asklake.local",
  groups: [],
  id: "user-admin",
  permissionsSummary: { canDelete: 12, canManage: 12, canQuery: 12, canRun: 12, canShare: 12, canView: 12 },
  profile: { avatarInitials: "AL", displayName: "AskLake Admin", email: "admin.user@asklake.local", role: "admin", title: "Platform Administrator" },
  role: "admin",
};

let mockSessionUser: CurrentUserResponse | null = null;

export async function fetchAuthSession(): Promise<AuthSessionResponse> {
  if (apiConfig.useMock) {
    const user = readMockSession() ?? (mockAutoAuth ? mockAdminUser : null);
    return { authenticated: Boolean(user), user };
  }
  return apiClient.get<AuthSessionResponse>("/api/auth/session");
}

export async function login(payload: LoginRequest): Promise<AuthUserResponse> {
  if (apiConfig.useMock) {
    const user = { ...mockAdminUser, email: payload.email, profile: { ...mockAdminUser.profile, email: payload.email } };
    writeMockSession(user);
    return { user };
  }
  return apiClient.post<AuthUserResponse>("/api/auth/login", payload);
}

export async function signup(payload: SignupRequest): Promise<AuthUserResponse> {
  if (apiConfig.useMock) {
    const user = {
      ...mockAdminUser,
      displayName: payload.displayName,
      email: payload.email,
      profile: { ...mockAdminUser.profile, displayName: payload.displayName, email: payload.email },
    };
    writeMockSession(user);
    return { user };
  }
  return apiClient.post<AuthUserResponse>("/api/auth/signup", payload);
}

export async function logout(): Promise<LogoutResponse> {
  if (apiConfig.useMock) {
    writeMockSession(null);
    return { ok: true };
  }
  return apiClient.post<LogoutResponse>("/api/auth/logout", {});
}

function readMockSession() {
  if (mockSessionUser || typeof window === "undefined") return mockSessionUser;
  const stored = window.sessionStorage.getItem(mockSessionKey);
  if (!stored) return null;
  try {
    mockSessionUser = JSON.parse(stored) as CurrentUserResponse;
  } catch {
    window.sessionStorage.removeItem(mockSessionKey);
  }
  return mockSessionUser;
}

function writeMockSession(user: CurrentUserResponse | null) {
  mockSessionUser = user;
  if (typeof window === "undefined") return;
  if (user) window.sessionStorage.setItem(mockSessionKey, JSON.stringify(user));
  else window.sessionStorage.removeItem(mockSessionKey);
}
