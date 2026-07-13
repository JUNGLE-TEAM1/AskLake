import assert from "node:assert/strict";
import { canonicalSchemaType, inferSchemaColumns, parseSourceSample } from "../src/profile.mjs";

const jsonSample = parseSourceSample("reviews.jsonl", [
  JSON.stringify({
    active: true,
    count: 1,
    created_at: "2026-07-12T00:00:00Z",
    ratio: 1.5,
    raw: { reviewerID: "user-1", score: 5 },
    schema_version: "1.0",
    tags: ["electronics"],
  }),
  JSON.stringify({
    active: false,
    count: null,
    created_at: "2026-07-12T00:00:01Z",
    ratio: 2,
    raw: { reviewerID: "user-2", score: 4 },
    schema_version: "2.0",
    tags: [],
  }),
].join("\n"));
const jsonColumns = Object.fromEntries(inferSchemaColumns(jsonSample).map((column) => [column.sourceName, column]));

assert.equal(jsonColumns.schema_version.type, "String", "Numeric-looking JSON strings must remain String.");
assert.equal(jsonColumns.count.type, "Long", "Native JSON integers must use Long.");
assert.equal(jsonColumns.count.nullable, true, "Native JSON null must mark the field nullable.");
assert.equal(jsonColumns.ratio.type, "Double", "Mixed integer/real JSON numbers must widen to Double.");
assert.equal(jsonColumns.active.type, "Boolean");
assert.equal(jsonColumns.created_at.type, "String", "JSON strings need an explicit format before timestamp conversion.");
assert.equal(jsonColumns["raw.reviewerID"].type, "String");
assert.equal(jsonColumns["raw.reviewerID"].targetName, "raw_reviewerid");
assert.equal(jsonColumns["raw.score"].type, "Long");
assert.equal(jsonColumns.tags.type, "JSON");
assert.equal(jsonSample.rows[0][jsonSample.columns.indexOf("ratio")], "1.5", "Preview rows remain display strings.");

const mixedSample = parseSourceSample("mixed.jsonl", '{"value":1}\n{"value":"2"}');
assert.equal(inferSchemaColumns(mixedSample)[0].type, "String", "Mixed native scalar types must not be guessed as numeric.");

const csvSample = parseSourceSample("fallback.csv", [
  "count,ratio,created_at",
  "1,1.5,2026-07-12T00:00:00Z",
  "2,2.5,2026-07-12T00:00:01Z",
].join("\n"));
const csvTypes = Object.fromEntries(inferSchemaColumns(csvSample).map((column) => [column.sourceName, column.type]));
assert.deepEqual(csvTypes, { count: "Integer", ratio: "Double", created_at: "Timestamp" });

assert.equal(canonicalSchemaType("Float"), "Double", "Legacy Float input must canonicalize to Double.");
assert.equal(canonicalSchemaType("float64"), "Double");
assert.equal(canonicalSchemaType("bigint"), "Long");
assert.equal(canonicalSchemaType("array<string>"), "JSON");

console.log("verify-schema-type-contract: ok");
