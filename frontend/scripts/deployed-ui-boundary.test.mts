import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");
const frontendRoot = resolve(repoRoot, "frontend");
const sourceRoot = resolve(frontendRoot, "src");
const sourceExtensions = new Set([".js", ".jsx", ".ts", ".tsx"]);

function readFromRepo(path: string) {
  return readFileSync(resolve(repoRoot, path), "utf8").replace(/\r\n/g, "\n");
}

function readFromFrontend(path: string) {
  return readFileSync(resolve(frontendRoot, path), "utf8").replace(/\r\n/g, "\n");
}

function sourceFiles(directory = sourceRoot): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return sourceExtensions.has(extname(entry.name)) ? [path] : [];
  });
}

test("the application composes deployed UI modules without activating compatibility facades", () => {
  const app = readFromFrontend("src/App.tsx");

  for (const expectedImport of [
    'from "./pages/ingest/jobs/JobDetailPage"',
    'from "./pages/ingest/jobs/JobRunsPage"',
    'from "./pages/ingest/jobs/JobsLandingPage"',
    'from "./state/asklake/useAskLakeWorkspace"',
  ]) {
    assert.ok(app.includes(expectedImport), `App.tsx must compose ${expectedImport}`);
  }

  for (const inactiveFacade of ["/etl/EtlPages", "/ingest/JobsPages", "/hooks/useAskLakeData"]) {
    const consumers = sourceFiles()
      .filter((path) => readFileSync(path, "utf8").includes(inactiveFacade))
      .map((path) => relative(frontendRoot, path).replaceAll("\\", "/"));
    assert.deepEqual(consumers, [], `${inactiveFacade} must remain an inactive compatibility facade`);
  }
});

test("production frontend defaults keep mock and legacy demo UI disabled", () => {
  const dockerfile = readFromRepo("frontend/Dockerfile");
  const compose = readFromRepo("deploy/docker-compose.prod.yml");
  const exampleEnv = readFromRepo("deploy/.env.example");

  assert.match(dockerfile, /^ARG VITE_USE_MOCK_API=false$/m);
  assert.match(dockerfile, /^ARG VITE_AUTH_LEGACY_DEMO_USERS_ENABLED=false$/m);
  assert.match(compose, /VITE_USE_MOCK_API: \$\{VITE_USE_MOCK_API:-false\}/);
  assert.match(compose, /VITE_AUTH_LEGACY_DEMO_USERS_ENABLED: \$\{VITE_AUTH_LEGACY_DEMO_USERS_ENABLED:-false\}/);
  assert.match(exampleEnv, /^VITE_USE_MOCK_API=false$/m);
  assert.match(exampleEnv, /^VITE_AUTH_LEGACY_DEMO_USERS_ENABLED=false$/m);
});
