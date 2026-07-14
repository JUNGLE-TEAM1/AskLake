import assert from "node:assert/strict";

import {
  buildKafkaTargetSchema,
  parseKafkaSnapshotRecord,
  projectKafkaTargetRecord,
  usesLegacyReviewContract,
} from "../src/kafkaTargetProjection.mjs";
import { applySnapshotRules } from "../src/snapshotRuleRuntime.mjs";

const rules = [{
  contractVersion: "1.0",
  enabled: true,
  failureDisposition: "keep",
  id: "rename-review",
  inputColumns: ["review"],
  kind: "transform",
  onError: "warn",
  operation: "rename",
  outputColumns: ["review_clean"],
  outputType: "String",
  parameters: {},
}];
const source = {
  event_id: "review-1",
  raw: { private_note: "must-not-leak" },
  review: "Hello Lake",
  source: "fixture",
};
const processed = applySnapshotRules([source], rules).records;
assert.deepEqual(Object.keys(processed[0]).sort(), ["event_id", "raw", "review", "review_clean", "source"]);

const schemaColumns = [
  { included: true, nullable: false, sourceName: "event_id", targetName: "event_id", type: "String" },
  { included: true, nullable: true, sourceName: "review", targetName: "review_clean", type: "String" },
  { included: false, nullable: true, sourceName: "raw", targetName: "raw", type: "JSON" },
];
const outputSchema = [["event_id", "String"], ["review_clean", "String"]];
const targetSchema = buildKafkaTargetSchema({ outputSchema, records: processed, rules, schemaColumns });
const projected = projectKafkaTargetRecord(processed[0], targetSchema);

assert.deepEqual(targetSchema.map((column) => column.targetName), ["event_id", "review_clean"]);
assert.deepEqual(projected, { event_id: "review-1", review_clean: "Hello Lake" });
assert.equal(Object.hasOwn(projected, "review"), false);
assert.equal(Object.hasOwn(projected, "raw"), false);

const genericSchemaColumns = [
  { included: true, nullable: false, sourceName: "event_id", targetName: "event_id", type: "String" },
  { included: true, nullable: false, sourceName: "payload.device", targetName: "payload_device", type: "String" },
];
assert.equal(usesLegacyReviewContract(genericSchemaColumns), false);
const genericParsed = parseKafkaSnapshotRecord(JSON.stringify({
  event_id: "event-1",
  payload: { device: "ios" },
}), { offset: "9", partition: 0, topic: "events.raw" }, genericSchemaColumns);
assert.equal(genericParsed.valid, true);
assert.deepEqual(
  projectKafkaTargetRecord(genericParsed.record, buildKafkaTargetSchema({ schemaColumns: genericSchemaColumns })),
  { event_id: "event-1", payload_device: "ios" },
);

assert.equal(usesLegacyReviewContract([]), true);
const invalidLegacyReview = parseKafkaSnapshotRecord(
  JSON.stringify({ event_id: "review-2" }),
  { offset: "10", partition: 0, topic: "reviews.raw" },
  [],
);
assert.equal(invalidLegacyReview.valid, false);
assert.equal(invalidLegacyReview.error.reason, "missing_required_field");
assert.equal(invalidLegacyReview.error.field, "offset");

const authoritativeOutputSchema = buildKafkaTargetSchema({
  outputSchema,
  records: processed,
  rules: [
    ...rules,
    {
      ...rules[0],
      id: "stale-intermediate",
      outputColumns: ["debug_intermediate"],
    },
  ],
  schemaColumns: [
    ...schemaColumns,
    { included: true, nullable: true, sourceName: "source", targetName: "source", type: "String" },
  ],
});
assert.deepEqual(
  authoritativeOutputSchema.map((column) => column.targetName),
  ["event_id", "review_clean"],
  "Compiled outputSchema must be the authoritative final projection.",
);

console.log("verify-kafka-target-projection: ok");
