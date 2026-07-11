import assert from "node:assert/strict";

import { inferSchemaColumns, parseSourceSample } from "../src/profile.mjs";
import { sourceCollectionFromConfig, sourceParsingFromConfig } from "../src/sparkRunner.mjs";

const fields = [
  { name: "event_time", nullable: false, type: "Timestamp" },
  { name: "level", nullable: false, type: "String" },
  { name: "message", nullable: true, type: "String" },
];

const pipeLog = [
  "2026-07-11T09:00:00Z|INFO|started",
  "2026-07-11T09:00:01Z|ERROR|request failed",
].join("\n");

const parsed = parseSourceSample("application.log", pipeLog, {
  delimiter: "auto",
  fields: JSON.stringify(fields),
  hasHeader: "false",
  maxRows: 10,
  parserMode: "delimited",
  quoteChar: '"',
  rowDelimiter: "\\n",
});

assert.deepEqual(parsed.columns, ["event_time", "level", "message"]);
assert.equal(parsed.profile.detected.delimiter, "|");
assert.equal(parsed.profile.detected.has_header, false);
assert.equal(parsed.profile.detected.line_separator, "\n");
assert.equal(parsed.profile.width_conflicts, 0);
assert.equal(parsed.rows[1][1], "ERROR");
assert.equal(inferSchemaColumns(parsed)[0].type, "Timestamp");

const productClickLog = [
  "event_id|session_id|user_id|page_url|event_type|quantity|event_time",
  "clk-1001|sess-501|demo-user-01|/products/B013SK1JTY|view|1|2026-07-11 10:00:00",
  "clk-1002|sess-501|demo-user-01|/products/B013SK1JTY/cart|add_to_cart|1|2026-07-11 10:01:12",
].join("\n");
const productClicks = parseSourceSample("product-click-events.log", productClickLog, {
  delimiter: "auto",
  hasHeader: "auto",
  maxRows: 10,
});
const productClickSchema = inferSchemaColumns(productClicks);
assert.equal(productClicks.profile.detected.delimiter, "|");
assert.equal(productClicks.profile.detected.has_header, true);
assert.deepEqual(productClickSchema.map((column) => column.type), [
  "String",
  "String",
  "String",
  "String",
  "String",
  "Integer",
  "Timestamp",
]);

const headerlessClicks = parseSourceSample(
  "headerless-clicks.log",
  "clk-2001|sess-601|B013SK1JTY|view|2026-07-11 11:00:00\nclk-2002|sess-602|B07ZPSG8P5|purchase|2026-07-11 11:01:00",
  { delimiter: "auto", hasHeader: "auto", maxRows: 10 },
);
assert.equal(headerlessClicks.profile.detected.has_header, false);
assert.equal(headerlessClicks.rows.length, 2);

assert.throws(
  () => parseSourceSample("blank-field.log", "a|b", {
    delimiter: "|",
    fields: JSON.stringify([{ name: " ", nullable: true, type: "String" }]),
    hasHeader: "false",
    parserMode: "delimited",
  }),
  (error) => error?.code === "INVALID_DELIMITED_FIELD_NAMES",
);

const semicolon = parseSourceSample("events.csv", "id;name\n1;alpha\n2;beta", {
  delimiter: "auto",
  hasHeader: "true",
  maxRows: 10,
});
assert.equal(semicolon.profile.detected.delimiter, ";");
assert.deepEqual(semicolon.columns, ["id", "name"]);
assert.deepEqual(semicolon.rows[0], ["1", "alpha"]);

assert.throws(
  () => parseSourceSample("overflow.log", "a|b|c", {
    delimiter: "|",
    fields: JSON.stringify(fields.slice(0, 2)),
    hasHeader: "false",
    parserMode: "delimited",
  }),
  (error) => error?.code === "DELIMITED_FIELD_COUNT_MISMATCH",
);

const sparkParsing = sourceParsingFromConfig([
  ["Parser Mode", "delimited"],
  ["Row Delimiter", "auto"],
  ["__Detected Row Delimiter", "\\n"],
  ["Delimiter", "pipe"],
  ["Header", "auto"],
  ["__Detected Header", "false"],
  ["Quote Character", "none"],
  ["Escape Character", "none"],
  ["Encoding", "UTF-8"],
  ["Delimited Fields", JSON.stringify(fields)],
]);
assert.equal(sparkParsing.delimiter, "|");
assert.equal(sparkParsing.header, false);
assert.equal(sparkParsing.quote, "");
assert.equal(sparkParsing.escape, "");
assert.equal(sparkParsing.rowDelimiter, "\n");
assert.deepEqual(sparkParsing.fields, fields);

const folderCollection = sourceCollectionFromConfig([
  ["Collection Scope", "folder"],
  ["File Pattern", "*.log"],
  ["Recursive", "true"],
]);
assert.deepEqual(folderCollection, {
  filePattern: "*.log",
  incrementalSince: null,
  mode: "incremental",
  recursive: true,
  scope: "folder",
});
assert.deepEqual(
  sourceCollectionFromConfig([
    ["Collection Scope", "folder"],
    ["Collection Mode", "incremental"],
  ], "2026-07-11T10:20:30Z"),
  { filePattern: null, incrementalSince: "2026-07-11T10:20:30Z", mode: "incremental", recursive: false, scope: "folder" },
);

console.log("verify-delimited-text-parser: ok");
