import assert from "node:assert/strict";
import test from "node:test";

import type { DashboardWidgetFilter } from "../src/types/dashboard.ts";
import {
  MAX_DASHBOARD_WIDGET_FILTERS,
  applyDashboardWidgetFilters,
  dashboardContextFilters,
  dashboardFilterInputValue,
  dashboardFilterOperatorOptions,
  dashboardWidgetFiltersFromConfig,
  localDashboardFilterValues,
  normalizeDashboardWidgetFilters,
  reconcileDashboardWidgetFilters,
  validateDashboardWidgetFilters,
} from "../src/pages/dashboard/runtime/widgetFilters.ts";
import { inferSqlResultColumnType } from "../src/pages/dashboard/runtime/dashboardDatasetAdapters.ts";

const columns = [
  { name: "category", type: "string" as const },
  { name: "subcategory", type: "string" as const },
  { name: "amount", type: "number" as const },
  { name: "event_time", type: "date" as const },
];

test("filter operators are derived from the selected column type", () => {
  assert.deepEqual(
    dashboardFilterOperatorOptions("string").map((option) => option.value),
    ["eq", "in", "contains", "is_null", "is_not_null"],
  );
  assert.deepEqual(
    dashboardFilterOperatorOptions("number").map((option) => option.value),
    ["eq", "gt", "gte", "lt", "lte", "between", "is_null", "is_not_null"],
  );
  assert.deepEqual(
    dashboardFilterOperatorOptions("date").map((option) => option.value),
    ["eq", "gt", "gte", "lt", "lte", "between", "is_null", "is_not_null"],
  );
});

test("complete filters normalize into the persisted widget contract", () => {
  const filters: DashboardWidgetFilter[] = [
    { id: "category-filter", column: "category", operator: "eq", value: "Wearable Technology" },
    { id: "empty-filter", column: "subcategory", operator: "eq" },
    { id: "null-filter", column: "amount", operator: "is_null", value: 10 },
  ];

  assert.deepEqual(normalizeDashboardWidgetFilters(filters), [
    { id: "category-filter", column: "category", operator: "eq", value: "Wearable Technology" },
    { id: "null-filter", column: "amount", operator: "is_null" },
  ]);
});

test("filter validation rejects incomplete values and caps conditions", () => {
  assert.equal(
    validateDashboardWidgetFilters(
      [{ id: "category-filter", column: "category", operator: "eq" }],
      columns,
    ),
    "category 필터 값을 입력해 주세요.",
  );
  assert.match(
    validateDashboardWidgetFilters(
      Array.from({ length: MAX_DASHBOARD_WIDGET_FILTERS + 1 }, (_, index) => ({
        id: `filter-${index}`,
        column: "category",
        operator: "eq" as const,
        value: "Wearable Technology",
      })),
      columns,
    ) ?? "",
    /최대 5개/,
  );
});

test("dataset changes remove missing columns and reset incompatible operators", () => {
  const reconciled = reconcileDashboardWidgetFilters([
    { id: "missing", column: "removed", operator: "eq", value: "x" },
    { id: "amount", column: "amount", operator: "contains", value: "10" },
  ], columns);

  assert.deepEqual(reconciled, [{
    id: "amount",
    column: "amount",
    operator: "eq",
    value: undefined,
    values: undefined,
  }]);
});

test("a value request receives only complete preceding filters", () => {
  const filters: DashboardWidgetFilter[] = [
    { id: "category-filter", column: "category", operator: "eq", value: "Wearable Technology" },
    { id: "empty-filter", column: "subcategory", operator: "eq" },
    { id: "amount-filter", column: "amount", operator: "gte", value: 10 },
  ];

  assert.deepEqual(dashboardContextFilters(filters, 2), [filters[0]]);
});

test("local SQL-result values are dynamically narrowed by previous conditions", () => {
  const result = localDashboardFilterValues(
    [
      { category: "Wearable Technology", subcategory: "Smartwatches" },
      { category: "Wearable Technology", subcategory: "Fitness Trackers" },
      { category: "Electronics", subcategory: "Smartwatches" },
    ],
    "subcategory",
    [{ id: "category-filter", column: "category", operator: "eq", value: "Wearable Technology" }],
    "fit",
    50,
  );

  assert.deepEqual(result, { truncated: false, values: ["Fitness Trackers"] });
});

test("SQL-result widget rows apply the persisted filters before rendering", () => {
  const rows = applyDashboardWidgetFilters(
    [
      { category: "Wearable Technology", subcategory: "Smartwatches" },
      { category: "Wearable Technology", subcategory: "Fitness Trackers" },
      { category: "Electronics", subcategory: "Smartwatches" },
    ],
    [{ id: "category-filter", column: "category", operator: "eq", value: "Wearable Technology" }],
  );

  assert.deepEqual(rows, [
    { category: "Wearable Technology", subcategory: "Smartwatches" },
    { category: "Wearable Technology", subcategory: "Fitness Trackers" },
  ]);
});

test("SQL result identifiers are not misclassified as dates", () => {
  assert.equal(inferSqlResultColumnType("order_id", ["ORD-1001", "ORD-1002"]), "string");
  assert.equal(inferSqlResultColumnType("order_date", ["2026-07-01", "2026-07-02"]), "date");
});

test("saved config filters restore without hard-coded category names", () => {
  assert.deepEqual(dashboardWidgetFiltersFromConfig([
    { id: "region-filter", column: "region", operator: "in", values: ["Seoul", "Busan"] },
  ]), [
    { id: "region-filter", column: "region", operator: "in", values: ["Seoul", "Busan"] },
  ]);
  assert.equal(dashboardFilterInputValue("12.5", "number"), 12.5);
  assert.equal(dashboardFilterInputValue("invalid", "number"), undefined);
});
