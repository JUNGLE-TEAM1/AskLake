
import { ApiError } from "../../types";

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
    return {
      data: fallback,
      error: `${resourceName}: ${getInitialReadErrorMessage(error)}`,
      fatal: !isRecoverableInitialReadError(error),
    };
  }
}
