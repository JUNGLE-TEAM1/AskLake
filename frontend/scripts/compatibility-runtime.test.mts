import assert from "node:assert/strict";
import test from "node:test";

import { resolveMockApiMode } from "../src/services/apiRuntimeMode.ts";
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
