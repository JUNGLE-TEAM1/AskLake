import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveApiBaseUrl,
  resolveMockApiMode,
} from "../src/services/apiRuntimeMode.ts";
import {
  getCompatibilityPathCounts,
  recordCompatibilityPath,
  resetCompatibilityPathCountsForTest,
} from "../src/services/compatibilityTelemetry.ts";

test("mock API is allowed only in a development build", () => {
  assert.equal(resolveMockApiMode(false, false), false);
  assert.equal(resolveMockApiMode(false, true), false);
  assert.equal(resolveMockApiMode(true, true), true);
  assert.throws(
    () => resolveMockApiMode(true, false),
    /development-only/,
  );
});

test("API base URL defaults to the browser origin and normalizes explicit origins", () => {
  assert.equal(resolveApiBaseUrl(undefined), "");
  assert.equal(resolveApiBaseUrl(false), "");
  assert.equal(resolveApiBaseUrl(""), "");
  assert.equal(resolveApiBaseUrl("https://asklake.example.com/"), "https://asklake.example.com");
});

test("frontend compatibility paths emit a warning and increment a stable counter", () => {
  resetCompatibilityPathCountsForTest();
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) => warnings.push(values);
  try {
    assert.equal(recordCompatibilityPath("frontend.test-path", "fixture", { resourceName: "jobs" }), 1);
    assert.equal(recordCompatibilityPath("frontend.test-path", "fixture"), 2);
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(getCompatibilityPathCounts(), { "frontend.test-path": 2 });
  assert.equal(warnings.length, 2);
  assert.equal((warnings[0]?.[1] as { event?: string }).event, "compatibility.path.used");
});
