import assert from "node:assert/strict";
import test from "node:test";

import {
  chartSeriesValues,
  dataFocusValueAxisRange,
  resolveChartValueAxisRange,
  validateChartValueAxisRange,
} from "../src/pages/dashboard/runtime/chartAxisRange.ts";

test("data-focus range magnifies nearby values with deterministic padding and nice bounds", () => {
  assert.deepEqual(dataFocusValueAxisRange([980, 990, 1_000]), { min: 975, max: 1_005 });
  assert.deepEqual(dataFocusValueAxisRange([-100, -90]), { min: -102, max: -88 });
  assert.deepEqual(dataFocusValueAxisRange([0, 0]), { min: -1, max: 1 });
  assert.deepEqual(dataFocusValueAxisRange([Number.NaN, Number.POSITIVE_INFINITY]), {});
});

test("manual range accepts one-sided bounds and fails safe for invalid persisted values", () => {
  const series = [{ data: [980, 990, 1_000] }];

  assert.deepEqual(resolveChartValueAxisRange({
    valueAxisRangeMode: "manual",
    valueAxisMin: 970,
  }, series), { min: 970 });
  assert.deepEqual(resolveChartValueAxisRange({
    valueAxisRangeMode: "manual",
    valueAxisMax: 1_010,
  }, series), { max: 1_010 });
  assert.deepEqual(resolveChartValueAxisRange({
    valueAxisRangeMode: "manual",
    valueAxisMin: 1_010,
    valueAxisMax: 1_000,
  }, series), {});
  assert.deepEqual(resolveChartValueAxisRange({}, series), {});
});

test("stacked series use cumulative visible edges when calculating the focused range", () => {
  const series = [
    { data: [60, 70] },
    { data: [40, 30] },
  ];

  assert.deepEqual(chartSeriesValues(series, true), [60, 100, 70, 100]);
  assert.deepEqual(resolveChartValueAxisRange({
    valueAxisRangeMode: "data_focus",
  }, series, { stacked: true }), { min: 55, max: 105 });
});

test("shared widget validation requires a usable manual range", () => {
  const baseConfig = {
    valueAxisRangeMode: "manual" as const,
  };

  assert.equal(
    validateChartValueAxisRange(baseConfig),
    "직접 설정할 최솟값 또는 최댓값을 입력해 주세요.",
  );
  assert.equal(
    validateChartValueAxisRange({
      ...baseConfig,
      valueAxisMin: 1_000,
      valueAxisMax: 990,
    }),
    "값 축 최솟값은 최댓값보다 작아야 합니다.",
  );
  assert.equal(
    validateChartValueAxisRange({
      ...baseConfig,
      valueAxisMin: 975,
      valueAxisMax: 1_005,
    }),
    null,
  );
});
