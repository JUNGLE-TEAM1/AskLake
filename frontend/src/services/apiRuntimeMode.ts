export function resolveApiBaseUrl(configuredBaseUrl: unknown) {
  return typeof configuredBaseUrl === "string"
    ? configuredBaseUrl.replace(/\/+$/, "")
    : "";
}

export function resolveMockApiMode(requested: boolean, isDevelopment: boolean) {
  if (requested && !isDevelopment) {
    throw new Error(
      "VITE_USE_MOCK_API is development-only and must be disabled in production builds.",
    );
  }
  return requested && isDevelopment;
}
