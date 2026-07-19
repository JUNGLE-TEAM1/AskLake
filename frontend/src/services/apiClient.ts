import { ApiError } from "../types/audit.ts";
import type { ApiErrorResponse } from "../types/audit.ts";
import { resolveMockApiMode } from "./apiRuntimeMode.ts";
import { apiBaseUrl } from "./apiOrigin.ts";

const environment = (import.meta as ImportMeta & {
  env?: Record<string, boolean | string | undefined>;
}).env ?? {};
const mockApiRequested = String(environment.VITE_USE_MOCK_API ?? "false").toLowerCase() === "true";
const useMockApi = resolveMockApiMode(mockApiRequested, Boolean(environment.DEV));

export const apiConfig = {
  baseUrl: apiBaseUrl,
  useMock: useMockApi,
};

export type ApiRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

type RequestOptions = ApiRequestOptions & {
  body?: unknown;
  method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
};

export class ApiRequestTimeoutError extends Error {
  timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`API request timed out after ${timeoutMs}ms`);
    this.name = "ApiRequestTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, method = body ? "POST" : "GET", signal, timeoutMs } = options;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new RangeError("timeoutMs must be a positive finite number");
  }

  const timeoutController = timeoutMs === undefined ? null : new AbortController();
  let didTimeout = false;
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
  const relayAbort = () => timeoutController?.abort(signal?.reason);

  if (timeoutController) {
    if (signal?.aborted) {
      relayAbort();
    } else {
      signal?.addEventListener("abort", relayAbort, { once: true });
      timeoutId = globalThis.setTimeout(() => {
        didTimeout = true;
        timeoutController.abort();
      }, timeoutMs);
    }
  }

  try {
    const response = await fetch(`${apiConfig.baseUrl}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      method,
      signal: timeoutController?.signal ?? signal,
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
        details: payload.error?.details ?? null,
        diagnosticId: payload.error?.diagnosticId ?? response.headers.get("X-Correlation-ID") ?? undefined,
        message: payload.error?.userMessage || detailMessage || payload.error?.message || validationDetail || fallback.error.message,
        retryable: payload.error?.retryable ?? response.status >= 500,
        stage: payload.error?.stage ?? "api",
        status: response.status,
      });
    }

    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  } catch (error) {
    if (didTimeout) throw new ApiRequestTimeoutError(timeoutMs as number);
    if (error instanceof TypeError) {
      throw new ApiError({
        code: "API_NETWORK_ERROR",
        details: { path },
        message: "API 서버에 연결할 수 없습니다. 현재 서비스 주소와 네트워크 상태를 확인해 주세요.",
        retryable: true,
        stage: "transport",
        status: 0,
      });
    }
    throw error;
  } finally {
    if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
    signal?.removeEventListener("abort", relayAbort);
  }
}

export const apiClient = {
  delete: <T>(path: string, options: ApiRequestOptions = {}) => request<T>(path, { ...options, method: "DELETE" }),
  get: <T>(path: string, options: ApiRequestOptions = {}) => request<T>(path, options),
  patch: <T>(path: string, body: unknown, options: ApiRequestOptions = {}) => request<T>(path, { ...options, body, method: "PATCH" }),
  post: <T>(path: string, body: unknown, options: ApiRequestOptions = {}) => request<T>(path, { ...options, body, method: "POST" }),
  put: <T>(path: string, body: unknown, options: ApiRequestOptions = {}) => request<T>(path, { ...options, body, method: "PUT" }),
};
