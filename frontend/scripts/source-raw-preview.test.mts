import assert from "node:assert/strict";
import test from "node:test";

import {
  extractRawTextPreviewLines,
  resolveRawTextPreviewLines,
  shouldShowRawTextPreview,
} from "../src/utils/sourcePreview.ts";

test("TXT source preview extracts only the original value column", () => {
  const lines = extractRawTextPreviewLines(
    ["line_number", "value"],
    [
      ["1", "2026-06-12T14:21:32+09:00 EVT-000000001 USR-0000001"],
      ["2", "2026-06-12T14:21:55+09:00 EVT-000000002 USR-0000001"],
    ],
  );

  assert.deepEqual(lines, [
    "2026-06-12T14:21:32+09:00 EVT-000000001 USR-0000001",
    "2026-06-12T14:21:55+09:00 EVT-000000002 USR-0000001",
  ]);
  assert.equal(shouldShowRawTextPreview({
    detectedFormat: "TXT",
    requiresRecordParsing: true,
    rawLines: lines,
    sourceType: "File / S3",
  }), true);
});

test("structured previews remain tabular", () => {
  assert.equal(shouldShowRawTextPreview({
    detectedFormat: "JSONL",
    requiresRecordParsing: false,
    rawLines: ["{\"event_id\":\"EVT-1\"}"],
    sourceType: "File / S3",
  }), false);
});

test("Kafka raw text uses backend-preserved lines even when table preview is empty", () => {
  const lines = resolveRawTextPreviewLines({
    backendRawLines: [
      "2026-06-12T14:21:32+09:00 EVT-000000001 USR-0000001 SES-00000001 product_impression B07WMTD66B /search mobile email 1",
    ],
    columnLabels: [],
    rows: [],
  });

  assert.deepEqual(lines, [
    "2026-06-12T14:21:32+09:00 EVT-000000001 USR-0000001 SES-00000001 product_impression B07WMTD66B /search mobile email 1",
  ]);
  assert.equal(shouldShowRawTextPreview({
    detectedFormat: "TXT",
    requiresRecordParsing: true,
    rawLines: lines,
    sourceType: "Stream / Kafka",
  }), true);
});

test("structured Kafka JSON remains tabular even if raw lines are present", () => {
  assert.equal(shouldShowRawTextPreview({
    detectedFormat: "JSON",
    requiresRecordParsing: false,
    rawLines: ["{\"event_id\":\"EVT-1\"}"],
    sourceType: "Stream / Kafka",
  }), false);
});
