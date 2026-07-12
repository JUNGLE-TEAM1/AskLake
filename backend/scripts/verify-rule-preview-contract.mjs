import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(readFileSync(path.join(backendDir, "fixtures", "rules", "snapshot-rule-conformance.json"), "utf8"));
const testCase = fixture.cases.find((item) => item.name === "portable transforms and quality quarantine");
assert(testCase, "Portable Snapshot conformance fixture is required.");

const preview = runPreview({ records: testCase.records, rules: testCase.rules });
assert.equal(preview.records.length, testCase.expected.records.length);
assert.equal(preview.quarantined.length, testCase.expected.quarantine.length);
assert.equal(preview.transform.errorCount, testCase.expected.transform.errorCount);
assert.equal(preview.quality.invalidRowCount, testCase.expected.quality.invalidRowCount);
assert.equal(preview.quality.passRate, testCase.expected.quality.passRate);

const unsupported = spawnSync(process.execPath, ["scripts/preview-snapshot-rules.mjs"], {
  cwd: backendDir,
  encoding: "utf8",
  input: JSON.stringify({
    records: [{ event_id: "sql-1", review: "sample" }],
    rules: [{
      contractVersion: "1.0",
      enabled: true,
      failureDisposition: "keep",
      id: "sql-preview",
      inputColumns: ["review"],
      kind: "transform",
      onError: "warn",
      operation: "sql_expression",
      outputColumns: ["review"],
      parameters: { expression: "UPPER(review)" },
    }],
  }),
});
assert.notEqual(unsupported.status, 0);
assert.match(unsupported.stdout, /RULE_PREVIEW_OPERATION_UNSUPPORTED/);

console.log("verify-rule-preview-contract: ok");

function runPreview(payload) {
  const result = spawnSync(process.execPath, ["scripts/preview-snapshot-rules.mjs"], {
    cwd: backendDir,
    encoding: "utf8",
    input: JSON.stringify(payload),
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const marker = result.stdout.split(/\r?\n/).find((line) => line.startsWith("ASKLAKE_RULE_PREVIEW_RESULT="));
  assert(marker, "Preview bridge result marker is required.");
  return JSON.parse(marker.slice("ASKLAKE_RULE_PREVIEW_RESULT=".length));
}
