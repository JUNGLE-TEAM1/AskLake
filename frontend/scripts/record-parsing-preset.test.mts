import assert from "node:assert/strict";
import test from "node:test";

import {
  applyClickEventRecordSchemaPreset,
  CLICK_EVENT_RECORD_SCHEMA_PRESET,
  isClickEventLogSource,
} from "../src/pages/etl/recordParsingPreset.ts";
import type { RecordParsingDraft } from "../src/types/etl.ts";

function recordParsingWithFieldCount(fieldCount: number): RecordParsingDraft {
  return {
    columns: Array.from({ length: fieldCount }, (_, position) => ({
      inferredType: "String" as const,
      name: `field_${position + 1}`,
      position,
    })),
    delimiterKind: "whitespace",
    delimiterPattern: "\\s+",
    enabled: true,
    expectedFieldCount: fieldCount,
    header: false,
  };
}

test("click event recommendation is shown only for click event log sources", () => {
  assert.equal(isClickEventLogSource("click-events.log", []), true);
  assert.equal(isClickEventLogSource("Amazon S3", [["Path / Prefix", "events/2026/click_events.log"]]), true);
  assert.equal(isClickEventLogSource("application.log", [["Path / Prefix", "logs/application.log"]]), false);
  assert.equal(isClickEventLogSource("click-events-whitespace-100.log", []), false);
});

test("click event recommendation maps the exact ten presentation fields in order", () => {
  const result = applyClickEventRecordSchemaPreset(recordParsingWithFieldCount(10));

  assert.ok(result);
  assert.deepEqual(result.columns, CLICK_EVENT_RECORD_SCHEMA_PRESET);
  assert.deepEqual(
    result.columns.map(({ name, inferredType }) => [name, inferredType]),
    [
      ["event_time", "Timestamp"],
      ["event_id", "String"],
      ["user_id", "String"],
      ["session_id", "String"],
      ["event_type", "String"],
      ["product_id", "String"],
      ["page_url", "String"],
      ["device_type", "String"],
      ["referrer", "String"],
      ["position", "Integer"],
    ],
  );
});

test("click event recommendation refuses a different field count", () => {
  assert.equal(applyClickEventRecordSchemaPreset(recordParsingWithFieldCount(9)), null);
});
