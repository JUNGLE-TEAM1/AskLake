import { readFileSync } from "node:fs";

import {
  applySnapshotRules,
  supportsSnapshotRules,
} from "../src/snapshotRuleRuntime.mjs";

const payload = JSON.parse(readFileSync(0, "utf8") || "{}");
const records = Array.isArray(payload.records) ? payload.records.slice(0, 100) : [];
const rules = Array.isArray(payload.rules) ? payload.rules : [];

try {
  if (!supportsSnapshotRules(rules)) {
    throw Object.assign(new Error("Preview supports canonical Snapshot operations only."), {
      code: "RULE_PREVIEW_OPERATION_UNSUPPORTED",
      status: 422,
    });
  }
  const result = applySnapshotRules(records, rules);
  console.log(`ASKLAKE_RULE_PREVIEW_RESULT=${JSON.stringify(result)}`);
} catch (error) {
  console.log(`ASKLAKE_RULE_PREVIEW_ERROR=${JSON.stringify({
    code: error?.code || "RULE_PREVIEW_FAILED",
    message: error?.message || "Snapshot rule Preview failed.",
    ruleId: error?.ruleId || "",
    status: error?.status || 422,
  })}`);
  process.exitCode = 1;
}
