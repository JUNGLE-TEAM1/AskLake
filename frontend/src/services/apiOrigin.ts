const environment = (import.meta as ImportMeta & {
  env?: Record<string, boolean | string | undefined>;
}).env ?? {};
const defaultApiBaseUrl = environment.DEV ? "" : "http://localhost:8080";

export const apiBaseUrl = String(environment.VITE_API_BASE_URL || defaultApiBaseUrl).replace(/\/+$/, "");
