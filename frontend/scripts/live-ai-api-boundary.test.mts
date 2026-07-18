import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readFrontend(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

function readRepo(path: string) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

test("live API clients default to same-origin authenticated requests", () => {
  const apiClient = readFrontend("src/services/apiClient.ts");
  const assistant = readFrontend("src/services/dashboardAssistantService.ts");

  assert.match(apiClient, /const defaultApiBaseUrl = "";/);
  assert.doesNotMatch(apiClient, /defaultApiBaseUrl[^\n]*localhost:8080/);
  assert.match(apiClient, /credentials: "include"/);
  assert.match(assistant, /VITE_DASHBOARD_ASSISTANT_API_PATH \|\| "\/api\/dashboards\/assistant"/);
  assert.match(assistant, /credentials: "include"/);
});

test("ETL AI and SQL preview use the shared live client without synthesized success", () => {
  const aiApi = readFrontend("src/services/aiApi.js");
  const schemaTransformApi = readFrontend("src/services/schemaTransformApi.js");
  const combined = `${aiApi}\n${schemaTransformApi}`;

  assert.match(aiApi, /import \{ apiClient \} from '\.\/apiClient';/);
  assert.match(aiApi, /apiClient\.post\('\/api\/ai\/generate-sql'/);
  assert.match(aiApi, /promptType,/);
  assert.match(schemaTransformApi, /apiClient\.post\('\/api\/sql\/test'/);
  assert.match(schemaTransformApi, /\{ timeoutMs \}/);
  assert.doesNotMatch(combined, /\bfetch\s*\(/);
  assert.doesNotMatch(combined, /API_BASE_URL|apiConfig\.useMock|mock/i);
  assert.doesNotMatch(aiApi, /search-schema|\/api\/ai\/health/);
});

test("review analysis client uses canonical persisted run and preview APIs", () => {
  const client = readFrontend("src/services/reviewAnalysisApi.ts");

  assert.match(client, /"\/api\/review-analysis\/runs\/latest"/);
  assert.match(client, /`\/api\/review-analysis\/runs\/\$\{encodeURIComponent\(runId\)\}`/);
  assert.match(client, /"\/api\/review-analysis\/preview"/);
  assert.match(client, /"\/api\/review-analysis\/runs"/);
  assert.doesNotMatch(client, /review-analysis\/cellphones/);
});

test("Vite and container nginx forward same-origin API calls without weakening secure cookies", () => {
  const viteConfig = readFrontend("vite.config.ts");
  const nginx = readFrontend("nginx.conf");
  const localCompose = readRepo("deploy/docker-compose.local-e2e.yml");

  assert.match(viteConfig, /VITE_DEV_PROXY_TARGET \|\| "http:\/\/127\.0\.0\.1:8080"/);
  assert.match(viteConfig, /"\/api"[\s\S]*target: devProxyTarget/);
  assert.match(nginx, /location \/api\/ \{/);
  assert.match(nginx, /proxy_pass \$asklake_backend;/);
  assert.doesNotMatch(nginx, /proxy_cookie_flags[\s\S]*nosecure/i);
  assert.match(localCompose, /VITE_API_BASE_URL: ""/);
  assert.match(localCompose, /AUTH_SESSION_COOKIE_SECURE: "false"/);
});
