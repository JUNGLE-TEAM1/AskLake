
import { ApiError } from "../../types";
import { recordCompatibilityPath } from "../../services/compatibilityTelemetry.ts";

export function isFetchConnectionError(error: unknown) {
  return error instanceof TypeError && /fetch|network|load failed|connection/i.test(error.message);
}

export function isRecoverableInitialReadError(error: unknown) {
  if (error instanceof ApiError) {
    return error.status === 404 || error.status === 502 || error.status === 503 || error.status === 504;
  }

  return isFetchConnectionError(error);
}

export function getInitialReadErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Failed to load AskLake data.";
}

export async function readInitialResource<T>(
  read: () => Promise<T>,
  resourceName: string,
  fallback: T,
): Promise<{ data: T; error: string | null; fatal: boolean }> {
  try {
    return {
      data: await read(),
      error: null,
      fatal: false,
    };
  } catch (error) {
    const fatal = !isRecoverableInitialReadError(error);
    recordCompatibilityPath(
      "frontend.initial-read-degraded",
      "initial backend read failed and the caller-provided fallback value was returned",
      {
        errorType: error instanceof Error ? error.name : typeof error,
        fatal,
        resourceName,
      },
    );
    return {
      data: fallback,
      error: `${resourceName}: ${getInitialReadErrorMessage(error)}`,
      fatal,
    };
  }
}
