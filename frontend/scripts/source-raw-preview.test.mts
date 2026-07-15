import assert from "node:assert/strict";
import test from "node:test";

import {
  extractKafkaClickLogPreviewLines,
  extractRawTextPreviewLines,
  shouldShowKafkaClickLogPreview,
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

test("structured and Kafka previews remain tabular", () => {
  assert.equal(shouldShowRawTextPreview({
    detectedFormat: "JSONL",
    requiresRecordParsing: false,
    rawLines: ["{\"event_id\":\"EVT-1\"}"],
    sourceType: "File / S3",
  }), false);
  assert.equal(shouldShowRawTextPreview({
    detectedFormat: "TXT",
    requiresRecordParsing: true,
    rawLines: ["raw event"],
    sourceType: "Stream / Kafka",
  }), false);
});

test("Kafka click-events-log payload reconstructs the preserved raw log lines", () => {
  const columns = [
    "schema_version",
    "source",
    "raw.event_time",
    "raw.event_id",
    "raw.user_id",
    "raw.session_id",
    "raw.event_type",
    "raw.product_id",
    "raw.page_url",
    "raw.device_type",
    "raw.referrer",
    "raw.position",
  ];
  const lines = extractKafkaClickLogPreviewLines(columns, [[
    "1.0",
    "click-events-log",
    "2026-06-12T14:21:32+09:00",
    "EVT-000000001",
    "USR-0000001",
    "SES-00000001",
    "product_impression",
    "B07WMTD66B",
    "/search?category=Camera+%26+Photo",
    "mobile",
    "email",
    "1",
  ]]);

  assert.deepEqual(lines, [
    "2026-06-12T14:21:32+09:00 EVT-000000001 USR-0000001 SES-00000001 product_impression B07WMTD66B /search?category=Camera+%26+Photo mobile email 1",
  ]);
  assert.equal(shouldShowKafkaClickLogPreview({ rawLines: lines, sourceType: "Stream / Kafka" }), true);
});

test("ordinary Kafka JSON does not masquerade as a raw click log", () => {
  const lines = extractKafkaClickLogPreviewLines(
    ["source", "event_id", "review"],
    [["orders-api", "EVT-1", "created"]],
  );

  assert.deepEqual(lines, []);
  assert.equal(shouldShowKafkaClickLogPreview({ rawLines: lines, sourceType: "Stream / Kafka" }), false);
});
