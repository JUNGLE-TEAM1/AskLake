import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "node-json-bridge.mjs");

function invoke(envelope, env = {}) {
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    input: JSON.stringify(envelope),
  });
}

test("bridge rejects unsupported protocol before loading an operation", () => {
  const result = invoke({
    version: "2.0",
    requestId: "request-1",
    idempotencyKey: "same-1",
    operation: "reviewAnalysis.suggestSchema",
    payload: {},
  });
  const response = JSON.parse(result.stdout);
  assert.equal(result.status, 1);
  assert.equal(response.version, "1.0");
  assert.equal(response.ok, false);
});

test("bridge rejects operations outside the allow list", () => {
  const result = invoke({
    version: "1.0",
    requestId: "request-2",
    idempotencyKey: "same-2",
    operation: "system.exec",
    payload: {},
  });
  const response = JSON.parse(result.stdout);
  assert.equal(result.status, 1);
  assert.equal(response.requestId, "request-2");
  assert.match(response.error.message, /unsupported operation/);
});

test("bridge fails closed on environment protocol conflicts", () => {
  const result = invoke({
    version: "1.0",
    requestId: "request-3",
    idempotencyKey: "same-3",
    operation: "reviewAnalysis.suggestSchema",
    payload: {},
  }, { ASKLAKE_NODE_BRIDGE_VERSION: "9.0" });
  const response = JSON.parse(result.stdout);
  assert.equal(result.status, 1);
  assert.match(response.error.message, /version conflicts/);
});
