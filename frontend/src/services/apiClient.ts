import { ApiError } from "../types";
import type { ApiErrorResponse } from "../types";

// The production frontend is served behind Caddy with the API on the same origin.
const defaultApiBaseUrl = "";
// Runtime mock data is intentionally disabled. The only sample schema is an explicit user action in the editor.
const useMockApi = false;

export const apiConfig = {
  baseUrl: import.meta.env.VITE_API_BASE_URL || defaultApiBaseUrl,
  useMock: useMockApi,
};

type RequestOptions = {
  body?: unknown;
  method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
};

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, method = body ? "POST" : "GET" } = options;
  const response = await fetch(`${apiConfig.baseUrl}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "include",
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
    const payload = await response.json().catch(() => fallback) as Partial<ApiErrorResponse>;
    const validationDetail = Array.isArray(payload.detail)
      ? payload.detail
        .map((item) => {
          if (!item || typeof item !== "object") return String(item);
          const record = item as { loc?: unknown[]; msg?: string };
          const location = Array.isArray(record.loc) ? record.loc.join(".") : "";
          return location ? `${location}: ${record.msg ?? "Invalid value"}` : record.msg ?? "Invalid value";
        })
        .join(" / ")
      : typeof payload.detail === "string" ? payload.detail : "";
    const detailMessage = typeof payload.error?.details?.message === "string" ? payload.error.details.message : "";
    throw new ApiError({
      code: payload.error?.code ?? fallback.error.code,
      message: detailMessage || payload.error?.message || validationDetail || fallback.error.message,
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
