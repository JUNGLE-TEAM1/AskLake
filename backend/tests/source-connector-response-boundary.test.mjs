import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildObjectStoragePrefixAnalysis,
  limitSourceConnectorResponse,
  SOURCE_CONNECTOR_PREVIEW_ROW_LIMIT,
  SOURCE_CONNECTOR_RESPONSE_MAX_BYTES,
} from "../src/connectors.mjs";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("50,000 real JSONL rows inform schema while only 20 preview rows cross the API boundary", async () => {
  const jsonLines = Array.from({ length: 50_000 }, (_, index) => JSON.stringify({
    id: index + 1,
    product: `amazon-product-${index + 1}`,
    ...(index === 0 ? { review_body: "x".repeat(SOURCE_CONNECTOR_RESPONSE_MAX_BYTES + 4096) } : {}),
    ...(index === 49_999 ? { late_metric: 42 } : {}),
  })).join("\n");
  const object = {
    Key: "amazon_reviews/reviews.jsonl",
    Size: Buffer.byteLength(jsonLines, "utf8"),
    LastModified: new Date("2026-07-17T00:00:00.000Z"),
  };

  const connectorResult = await buildObjectStoragePrefixAnalysis({
    bucket: "m3-raw",
    endpoint: "https://s3.amazonaws.com",
    fields: [["File Type", "JSONL"]],
    forcePathStyle: false,
    objects: [object],
    prefix: "amazon_reviews/",
    readSample: async () => jsonLines,
    region: "ap-northeast-2",
    samplePolicy: {
      kind: "object",
      label: "full schema sample",
      rowLimit: 50_000,
      scope: "full",
    },
    sourceType: "File / S3 JSONL",
  });

  assert.equal(connectorResult.previewRows.length, 50_000);
  assert.equal(connectorResult.draftPatch.schema.sampleRows.length, 50_000);
  assert.ok(connectorResult.draftPatch.schema.columns.some(({ sourceName }) => sourceName === "late_metric"));

  const limited = limitSourceConnectorResponse(connectorResult);

  assert.ok(limited.previewRows.length <= SOURCE_CONNECTOR_PREVIEW_ROW_LIMIT);
  assert.ok(limited.draftPatch.schema.sampleRows.length <= SOURCE_CONNECTOR_PREVIEW_ROW_LIMIT);
  assert.ok(limited.previewRows.length > 0);
  assert.ok(limited.draftPatch.schema.sampleRows.length > 0);
  assert.ok(limited.draftPatch.schema.columns.some(({ sourceName }) => sourceName === "late_metric"));
  assert.ok(Buffer.byteLength(JSON.stringify(limited), "utf8") <= SOURCE_CONNECTOR_RESPONSE_MAX_BYTES);
  assert.equal(connectorResult.previewRows.length, 50_000, "limiting must not mutate schema-inference rows");
});

test("connector CLIs naturally flush success and failure markers without process.exit", async (context) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.end(Array.from({ length: 30 }, (_, index) => JSON.stringify({
      id: index + 1,
      product: `amazon-product-${index + 1}`,
      review_body: "r".repeat(10 * 1024),
    })).join("\n"));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const testScript = path.join(backendDir, "scripts", "test-source-connector.mjs");
  const listScript = path.join(backendDir, "scripts", "list-source-assets.mjs");
  const success = await runCli(testScript, {
    sourceConfig: [
      ["Endpoint URL", `http://127.0.0.1:${address.port}/amazon-reviews.jsonl`],
      ["Method", "GET"],
    ],
    sourceType: "REST API",
  });

  assert.equal(success.code, 0, success.stderr);
  assert.ok(success.stdout.endsWith("\n"));
  assert.ok(Buffer.byteLength(success.stdout, "utf8") > 64 * 1024);
  const result = parseMarker(success.stdout, "ASKLAKE_SOURCE_CONNECTOR_RESULT");
  assert.equal(result.status, "success");
  assert.ok(result.previewRows.length <= SOURCE_CONNECTOR_PREVIEW_ROW_LIMIT);
  assert.ok(result.draftPatch.schema.sampleRows.length <= SOURCE_CONNECTOR_PREVIEW_ROW_LIMIT);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= SOURCE_CONNECTOR_RESPONSE_MAX_BYTES);

  const failure = await runCli(listScript, { sourceConfig: [], sourceType: "REST API" });
  assert.equal(failure.code, 1);
  assert.ok(failure.stdout.endsWith("\n"));
  assert.equal(parseMarker(failure.stdout, "ASKLAKE_SOURCE_ASSETS_ERROR").code, "UNSUPPORTED_SOURCE_ASSETS");

  for (const script of [testScript, listScript]) {
    const source = await readFile(script, "utf8");
    assert.doesNotMatch(source, /process\.exit\s*\(/);
    assert.match(source, /process\.exitCode\s*=\s*1/);
  }
});

function runCli(script, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: backendDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr, stdout }));
    child.stdin.end(JSON.stringify(payload));
  });
}

function parseMarker(output, marker) {
  const prefix = `${marker}=`;
  const line = output
    .split("\n")
    .map((candidate) => candidate.endsWith("\r") ? candidate.slice(0, -1) : candidate)
    .findLast((candidate) => candidate.startsWith(prefix));
  assert.ok(line, `missing ${marker} in child output`);
  return JSON.parse(line.slice(prefix.length));
}
