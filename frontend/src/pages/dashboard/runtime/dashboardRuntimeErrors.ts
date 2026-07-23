import type { ApiError } from "../../../types";

export function dashboardRuntimeErrorMessage(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback;
  const apiError = error as Partial<ApiError>;
  if (typeof apiError.code !== "string" || typeof apiError.stage !== "string") {
    return error.message || fallback;
  }
  const context = [apiError.code, apiError.stage, apiError.diagnosticId]
    .filter(Boolean)
    .join(" · ");
  const message = error.message || fallback;
  return context ? `${message} (${context})` : message;
}
