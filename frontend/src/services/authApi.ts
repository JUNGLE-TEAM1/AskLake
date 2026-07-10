import { ApiError } from "../types";
import type { AuthSessionResponse, AuthUserResponse, CurrentUserResponse, LoginRequest, LogoutResponse, SignupRequest } from "../types";
import { apiClient } from "./apiClient";

const tempUsersKey = "asklake.tempAuth.users";
const tempSessionKey = "asklake.tempAuth.session";

export async function fetchAuthSession(): Promise<AuthSessionResponse> {
  try {
    const session = await apiClient.get<AuthSessionResponse>("/api/auth/session");
    return session.authenticated ? session : localSession();
  } catch (error) {
    if (!shouldUseTempAuth(error)) throw error;
    return localSession();
  }
}

export async function login(payload: LoginRequest): Promise<AuthUserResponse> {
  try {
    return await apiClient.post<AuthUserResponse>("/api/auth/login", payload);
  } catch (error) {
    if (!shouldUseTempAuth(error)) throw error;
    return loginTempUser(payload);
  }
}

export async function signup(payload: SignupRequest): Promise<AuthUserResponse> {
  try {
    return await apiClient.post<AuthUserResponse>("/api/auth/signup", payload);
  } catch (error) {
    if (!shouldUseTempAuth(error)) throw error;
    return signupTempUser(payload);
  }
}

export async function logout(): Promise<LogoutResponse> {
  clearTempSession();
  try {
    return await apiClient.post<LogoutResponse>("/api/auth/logout", {});
  } catch (error) {
    if (!shouldUseTempAuth(error)) throw error;
    return { ok: true };
  }
}

type TempUserRecord = {
  displayName: string;
  email: string;
  id: string;
  password: string;
};

function shouldUseTempAuth(error: unknown) {
  if (error instanceof ApiError) return !error.status || error.status >= 500;
  return true;
}

function localSession(): AuthSessionResponse {
  const user = readTempSessionUser();
  return user ? { authenticated: true, user } : { authenticated: false, user: null };
}

function loginTempUser(payload: LoginRequest): AuthUserResponse {
  const normalizedEmail = normalizeEmail(payload.email);
  const matched = readTempUsers().find((user) => normalizeEmail(user.email) === normalizedEmail && user.password === payload.password);
  if (!matched) {
    throw new ApiError({
      code: "TEMP_AUTH_LOGIN_FAILED",
      message: "임시 계정이 없습니다. 회원가입 탭에서 먼저 계정을 만들어주세요.",
      status: 401,
    });
  }
  const user = toCurrentUser(matched);
  writeTempSessionUser(user);
  return { user };
}

function signupTempUser(payload: SignupRequest): AuthUserResponse {
  const normalizedEmail = normalizeEmail(payload.email);
  if (!normalizedEmail.includes("@")) {
    throw new ApiError({
      code: "TEMP_AUTH_INVALID_EMAIL",
      message: "이메일 형식으로 입력해주세요.",
      status: 400,
    });
  }
  if (payload.password.length < 8) {
    throw new ApiError({
      code: "TEMP_AUTH_WEAK_PASSWORD",
      message: "비밀번호는 8자 이상이어야 합니다.",
      status: 400,
    });
  }
  const users = readTempUsers();
  const displayName = payload.displayName.trim() || normalizedEmail.split("@")[0] || "Temp User";
  const existingIndex = users.findIndex((user) => normalizeEmail(user.email) === normalizedEmail);
  const record: TempUserRecord = {
    displayName,
    email: normalizedEmail,
    id: existingIndex >= 0 ? users[existingIndex].id : `temp-${Date.now().toString(36)}`,
    password: payload.password,
  };
  const nextUsers = existingIndex >= 0
    ? users.map((user, index) => (index === existingIndex ? record : user))
    : [...users, record];
  writeTempUsers(nextUsers);
  const user = toCurrentUser(record);
  writeTempSessionUser(user);
  return { user };
}

function readTempUsers(): TempUserRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(tempUsersKey) || "[]");
    return Array.isArray(parsed) ? parsed.filter(isTempUserRecord) : [];
  } catch {
    return [];
  }
}

function writeTempUsers(users: TempUserRecord[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(tempUsersKey, JSON.stringify(users));
}

function readTempSessionUser(): CurrentUserResponse | null {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(tempSessionKey) || "null");
    return isCurrentUser(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeTempSessionUser(user: CurrentUserResponse) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(tempSessionKey, JSON.stringify(user));
}

function clearTempSession() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(tempSessionKey);
}

function isTempUserRecord(value: unknown): value is TempUserRecord {
  const record = value as Partial<TempUserRecord>;
  return Boolean(record && typeof record.email === "string" && typeof record.password === "string" && typeof record.id === "string");
}

function isCurrentUser(value: unknown): value is CurrentUserResponse {
  const record = value as Partial<CurrentUserResponse>;
  return Boolean(record && typeof record.id === "string" && typeof record.email === "string" && typeof record.displayName === "string");
}

function toCurrentUser(record: TempUserRecord): CurrentUserResponse {
  return {
    displayName: record.displayName,
    email: record.email,
    groups: [{ id: "temp-local", name: "Local Temp Users", description: "Temporary browser-only accounts", memberCount: 1 }],
    id: record.id,
    permissionsSummary: {
      canDelete: 0,
      canManage: 0,
      canQuery: 10,
      canRun: 10,
      canShare: 0,
      canView: 10,
    },
    profile: {
      avatarInitials: initials(record.displayName),
      displayName: record.displayName,
      email: record.email,
      role: "viewer",
      title: "Temporary Local User",
    },
    role: "viewer",
  };
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function initials(displayName: string) {
  const letters = displayName
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return letters || "TU";
}
