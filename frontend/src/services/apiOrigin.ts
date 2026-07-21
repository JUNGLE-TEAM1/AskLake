const environment = (import.meta as ImportMeta & {
  env?: Record<string, boolean | string | undefined>;
}).env ?? {};

// Keep deployable frontend images environment-neutral. EKS ingress routes
// browser-origin /api requests to FastAPI; local development may still provide
// an explicit backend origin through VITE_API_BASE_URL.
const defaultApiBaseUrl = "";

export const apiBaseUrl = String(environment.VITE_API_BASE_URL || defaultApiBaseUrl).replace(/\/+$/, "");
