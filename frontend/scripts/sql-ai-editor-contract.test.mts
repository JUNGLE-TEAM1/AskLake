import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hook = readFileSync(new URL("../src/pages/sql/useSqlQueryAi.ts", import.meta.url), "utf8");

test("SQL AI owns one cancellable request and ignores stale completion paths", () => {
  assert.match(hook, /LatestRequestGate/);
  assert.match(hook, /requests\.current\.begin\(contextFingerprint\)/);
  assert.match(hook, /signal:\s*lease\.signal/);
  assert.match(hook, /requests\.current\.isCurrent\(lease\)/);
  assert.match(hook, /requests\.current\.complete\(lease\)/);
  assert.match(hook, /requests\.current\.invalidate\(\)/);
  assert.match(hook, /const changePrompt[\s\S]*requests\.current\.invalidate\(\);[\s\S]*setPrompt\(nextPrompt\)/);
});

test("SQL AI preserves backend and timeout diagnostics instead of swallowing them", () => {
  assert.match(hook, /getQueryAiErrorMessage/);
  assert.match(hook, /catch \(requestError\)/);
  assert.match(hook, /setError\(getQueryAiErrorMessage\(requestError\)\)/);
});
