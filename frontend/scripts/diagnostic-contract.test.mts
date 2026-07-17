import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const apiClient = readFileSync(new URL("../src/services/apiClient.ts", import.meta.url), "utf8");
const jobDetail = readFileSync(new URL("../src/pages/ingest/jobs/JobDetailPage.tsx", import.meta.url), "utf8");

test("API errors prefer safe user messages and retain the diagnostic id", () => {
  assert.match(apiClient, /payload\.error\?\.userMessage/);
  assert.match(apiClient, /X-Correlation-ID/);
  assert.match(apiClient, /diagnosticId:/);
});

test("Continuous Job detail exposes a copyable diagnostic id", () => {
  assert.match(jobDetail, /진단 ID/);
  assert.match(jobDetail, /navigator\.clipboard\.writeText\(diagnosticId\)/);
  assert.match(jobDetail, /errorDetail\?\.userMessage/);
});
