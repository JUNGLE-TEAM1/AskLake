import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("record parsing always renders the AI inference placeholder without preset logic", () => {
  const etlPagesSource = readFileSync(new URL("../src/pages/etl/EtlPages.tsx", import.meta.url), "utf8");

  assert.match(etlPagesSource, /data-testid="record-parsing-ai-button"/);
  assert.match(etlPagesSource, /AI 필드 자동 추론/);
  assert.doesNotMatch(etlPagesSource, /CLICK_EVENT_RECORD_SCHEMA_PRESET|applyRecommendedSchema|isClickEventLogSource/);
  assert.doesNotMatch(
    etlPagesSource,
    /data-testid="record-parsing-ai-button"[\s\S]{0,300}(?:disabled=|onClick=)/,
  );
});

test("record parsing keeps content focused and makes large previews collapsible", () => {
  const etlPagesSource = readFileSync(new URL("../src/pages/etl/EtlPages.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(etlPagesSource, /record-parsing-source-strip/);
  assert.doesNotMatch(etlPagesSource, /record-parsing-count/);
  assert.doesNotMatch(etlPagesSource, /record-parsing-status/);
  assert.match(etlPagesSource, /aria-controls="record-parsing-raw-sample"/);
  assert.match(etlPagesSource, /aria-controls="record-parsing-result-preview"/);
  assert.match(etlPagesSource, /aria-expanded=\{rawSampleExpanded\}/);
  assert.match(etlPagesSource, /aria-expanded=\{resultPreviewExpanded\}/);
});
