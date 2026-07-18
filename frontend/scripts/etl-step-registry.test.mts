import assert from "node:assert/strict";
import test from "node:test";

import { buildEtlWizardSteps, etlFlowFromRoute, etlFlowPath, etlStyleRoute } from "../src/pages/etl/stepRegistry.ts";

test("snapshot wizard includes optional record parsing and schedule", () => {
  const steps = buildEtlWizardSteps({ continuousKafka: false, requiresRecordParsing: true, scheduleFlow: "repeat" });
  assert.deepEqual(steps.map(({ flow }) => flow), ["source", "recordParsing", "schema", "repeat", "permission", "target", "review"]);
  assert.deepEqual(steps.map(({ label }) => label), ["소스", "레코드 구조화", "처리", "스케줄", "권한", "타겟", "검토"]);
});

test("continuous Kafka wizard omits schedule", () => {
  assert.deepEqual(
    buildEtlWizardSteps({ continuousKafka: true, requiresRecordParsing: false, scheduleFlow: "manual" }).map(({ flow }) => flow),
    ["source", "schema", "permission", "target", "review"],
  );
});

test("registry preserves legacy routes and schedule fallback", () => {
  assert.equal(etlFlowFromRoute("record-parsing", undefined, 2, "manual"), "recordParsing");
  assert.equal(etlFlowFromRoute("schedule", undefined, 2, "repeat"), "repeat");
  assert.equal(etlFlowFromRoute("schedule", "manual", 3, "repeat"), "manual");
  assert.equal(etlFlowPath("rules"), "/etl/rules");
  assert.equal(etlFlowPath("repeat"), "/etl/schedule");
  assert.equal(etlStyleRoute("source"), "source");
  assert.equal(etlStyleRoute("recordParsing"), "record-parsing");
  assert.equal(etlStyleRoute("manual"), "schedule");
  assert.equal(etlStyleRoute("catalog"), null);
});
