import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { dashboardWidgetDataRequests } from "../src/pages/dashboard/runtime/dashboardWidgetDataState.ts";
import type { DashboardRuntimeResponse, DashboardRuntimeWidget } from "../src/types/dashboard.ts";

const runtimeLoaders = readFileSync(
  new URL("../src/pages/dashboard/runtime/useDashboardRuntimeLoaders.ts", import.meta.url),
  "utf8",
);
const mutationSources = [
  "useDraftPageMutations.ts",
  "useDraftWidgetCreator.ts",
  "useDraftWidgetMutations.ts",
].map((fileName) => readFileSync(
  new URL(`../src/pages/dashboard/runtime/${fileName}`, import.meta.url),
  "utf8",
));

function widget(id: string, pageId: string, datasetId: string): DashboardRuntimeWidget {
  return {
    config: { aggregation: "count", valueKey: "value" },
    data: [],
    dataStatus: "pending",
    datasetId,
    id,
    layout: { h: 3, w: 4, x: 0, y: 0 },
    pageId,
    title: id,
    type: "metric",
  };
}

function runtime(): DashboardRuntimeResponse {
  return {
    dashboard: {
      hasPublishedRevision: true,
      id: "dashboard-performance",
      status: "published",
      title: "Performance dashboard",
      updatedAt: "2026-07-18T00:00:00Z",
    },
    eventCursor: 0,
    filters: [],
    mode: "published",
    pages: [
      { id: "page-visible", orderIndex: 0, title: "Visible" },
      { id: "page-hidden", orderIndex: 1, title: "Hidden" },
    ],
    revision: { id: "revision-1", kind: "published", version: 1 },
    widgetsByPageId: {
      "page-visible": [
        widget("orders-total", "page-visible", "orders"),
        widget("orders-trend", "page-visible", "orders"),
        widget("users-total", "page-visible", "users"),
      ],
      "page-hidden": [widget("hidden-widget", "page-hidden", "hidden-dataset")],
    },
  };
}

test("Dashboard shell 요청은 widget data를 포함하지 않는다", () => {
  assert.equal(runtimeLoaders.match(/includeData:\s*false/g)?.length, 4);
});

test("선택한 page의 세 widget은 Dataset 두 개 기준으로 두 요청만 만든다", () => {
  const requests = dashboardWidgetDataRequests(runtime(), "page-visible");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => request.widgetIds), [
    ["orders-total", "orders-trend"],
    ["users-total"],
  ]);
  assert.equal(requests.flatMap((request) => request.widgetIds).includes("hidden-widget"), false);
});

test("page와 widget 변경 경로는 전체 Dashboard runtime을 다시 요청하지 않는다", () => {
  for (const source of mutationSources) {
    assert.doesNotMatch(source, /loadDraftRuntime|ensureDraftDashboard|getPublishedDashboard/);
  }
});
