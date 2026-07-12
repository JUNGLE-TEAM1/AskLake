import assert from "node:assert/strict";
import { postgresLogicalType, stringifyCell } from "../src/connectors.mjs";
import { inferSchemaColumns, parseSourceSample } from "../src/profile.mjs";

const commerceSample = parseSourceSample("commerce_events.jsonl", [
  JSON.stringify({
    event_id: "EVT-000000001",
    schema_version: "1.0",
    user_id: "USR-000001",
    session_id: "SES-00000001",
    event_time: "2026-06-12T14:21:32+09:00",
    product_id: "B07WMTD66B",
  }),
  JSON.stringify({
    event_id: "EVT-000000002",
    schema_version: "1.0",
    user_id: "USR-000002",
    session_id: "SES-00000002",
    event_time: "2026-06-13T08:05:01Z",
    product_id: "B09W2RY3DG",
  }),
].join("\n"));

const commerceTypes = Object.fromEntries(
  inferSchemaColumns(commerceSample).map((column) => [column.sourceName, column.type]),
);

assert.equal(commerceTypes.event_id, "String");
assert.equal(commerceTypes.schema_version, "String");
assert.equal(commerceTypes.user_id, "String");
assert.equal(commerceTypes.session_id, "String");
assert.equal(commerceTypes.product_id, "String");
assert.equal(commerceTypes.event_time, "Timestamp");

const sparseRows = Array.from({ length: 20 }, (_, index) => JSON.stringify({
  event_id: `EVT-${String(index + 1).padStart(9, "0")}`,
  event_time: "2026-06-12T14:21:32+09:00",
  event_type: index === 14 ? "checkout_started" : "product_impression",
  properties: index === 14
    ? { checkout_id: "CHK-000000001", currency: "USD", item_count: 1, order_id: null, order_value: 55.99, position: 1 }
    : { position: 1 },
})).join("\n");
const sparseSample = parseSourceSample("commerce_events.jsonl", sparseRows, { maxRows: 1000 });
const sparseColumns = inferSchemaColumns(sparseSample).map((column) => column.sourceName);
assert(sparseColumns.includes("properties.checkout_id"));
assert(sparseColumns.includes("properties.order_id"));
assert(sparseColumns.includes("properties.order_value"));

const numericSample = parseSourceSample("numeric.csv", "id,amount\n1,12.5\n2,7.0\n");
const numericTypes = Object.fromEntries(
  inferSchemaColumns(numericSample).map((column) => [column.sourceName, column.type]),
);
assert.equal(numericTypes.id, "Integer");
assert.equal(numericTypes.amount, "Float");

assert.equal(postgresLogicalType("timestamp with time zone", "timestamptz"), "Timestamp");
assert.equal(postgresLogicalType("numeric", "numeric"), "Float");
assert.equal(postgresLogicalType("integer", "int4"), "Integer");
assert.equal(postgresLogicalType("jsonb", "jsonb"), "JSON");
assert.equal(stringifyCell(new Date("2026-06-12T05:21:32.000Z")), "2026-06-12T05:21:32.000Z");

console.log("verify-source-profile: ok");
