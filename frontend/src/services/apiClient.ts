import { ApiError } from "../types";
import type { ApiErrorResponse } from "../types";

const defaultApiBaseUrl = "http://localhost:8080";

export const apiConfig = {
  baseUrl: import.meta.env.VITE_API_BASE_URL || defaultApiBaseUrl,
  useMock: import.meta.env.VITE_USE_MOCK_API === "true",
};

type RequestOptions = {
  body?: unknown;
  method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
};

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, method = body ? "POST" : "GET" } = options;
  const response = await fetch(`${apiConfig.baseUrl}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    method,
  });

  if (!response.ok) {
    const fallback: ApiErrorResponse = {
      error: {
        code: `HTTP_${response.status}`,
        message: response.statusText || "API request failed",
      },
    };
    const payload = await response.json().catch(() => fallback) as ApiErrorResponse;
    throw new ApiError({
      code: payload.error?.code ?? fallback.error.code,
      message: payload.error?.message ?? fallback.error.message,
      status: response.status,
    });
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const apiClient = {
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  get: <T>(path: string) => request<T>(path),
  patch: <T>(path: string, body: unknown) => request<T>(path, { body, method: "PATCH" }),
  post: <T>(path: string, body: unknown) => request<T>(path, { body, method: "POST" }),
  put: <T>(path: string, body: unknown) => request<T>(path, { body, method: "PUT" }),
};

