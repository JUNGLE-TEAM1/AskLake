export type AuthMode = "login" | "signup";

export function authModeFromPath(pathname: string): AuthMode | null {
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (normalizedPath === "/login") return "login";
  if (normalizedPath === "/signup") return "signup";
  return null;
}

export function authPath(mode: AuthMode): string {
  return mode === "signup" ? "/signup" : "/login";
}
