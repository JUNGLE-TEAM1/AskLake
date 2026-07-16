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
