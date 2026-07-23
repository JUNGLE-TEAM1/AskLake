import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  barChartAxisLabelFormatters,
  barChartFieldLabels,
  buildBarChartAxes,
  formatChartAxisNumber,
} from "../src/pages/dashboard/runtime/barChartAxes.ts";

const frontendRoot = path.resolve(import.meta.dirname, "..");
const panelSource = readFileSync(path.join(frontendRoot, "src/pages/dashboard/runtime/WidgetConfigPanel.tsx"), "utf8");
const rendererSource = readFileSync(path.join(frontendRoot, "src/pages/dashboard/runtime/WidgetRenderer.tsx"), "utf8");
const definitionsSource = readFileSync(path.join(frontendRoot, "src/pages/dashboard/runtime/widgetDefinitions.ts"), "utf8");

test("bar field labels describe the physical axes without swapping the persisted field roles", () => {
  assert.deepEqual(barChartFieldLabels("vertical"), {
    category: "분류 컬럼 (X축)",
    value: "값 컬럼 (Y축)",
  });
  assert.deepEqual(barChartFieldLabels("horizontal"), {
    category: "분류 컬럼 (Y축)",
    value: "값 컬럼 (X축)",
  });

  assert.match(panelSource, /barChartFields\.category[^\n]+currentConfig\.xKey/);
  assert.match(panelSource, /barChartFields\.value[^\n]+currentConfig\.yKey/);
  assert.match(panelSource, /barChartFields\.value[\s\S]{0,350}columnGroups\.numericColumns/);
  assert.match(definitionsSource, /가로 막대의 Y축에 표시할 분류 컬럼/);
  assert.match(definitionsSource, /가로 막대의 X축에서 막대 길이를 계산할 숫자 컬럼/);
});

test("horizontal bars format numeric X ticks and product-name Y labels", () => {
  const formatters = barChartAxisLabelFormatters("horizontal");
  const longProductName = "프리미엄 여름 한정판 대용량 탄산수 선물 세트 상품명";

  assert.notEqual(formatters.x(12500), "NaN");
  assert.equal(formatters.y("상품 A"), "상품 A");
  assert.match(formatters.y(longProductName), /\.\.\.$/);
  assert.ok(formatters.y(longProductName).length < longProductName.length);
  assert.equal(formatChartAxisNumber("상품 A"), "상품 A");
});

test("vertical bars retain category X labels and numeric Y ticks", () => {
  const formatters = barChartAxisLabelFormatters("vertical");

  assert.equal(formatters.x("상품 A"), "상품 A");
  assert.notEqual(formatters.y(12500), "NaN");
});

test("the bar renderer applies the orientation to both bars and physical axis formatters", () => {
  const axes = buildBarChartAxes(
    { xaxis: { labels: {} }, yaxis: { labels: {} } },
    ["상품 A"],
    "horizontal",
    { min: 10, max: 20 },
  );

  assert.equal(axes.xaxis?.min, 10);
  assert.equal(axes.xaxis?.max, 20);
  assert.equal(Array.isArray(axes.yaxis) ? axes.yaxis[0]?.min : axes.yaxis?.min, undefined);
  assert.match(rendererSource, /const labelKey = widget\.config\.xKey/);
  assert.match(rendererSource, /const valueKey = widget\.config\.yKey/);
  assert.match(rendererSource, /horizontal: isHorizontal/);
  assert.match(rendererSource, /const axes = buildBarChartAxes/);
  assert.match(rendererSource, /xaxis: axes\.xaxis/);
  assert.match(rendererSource, /yaxis: axes\.yaxis/);
});
