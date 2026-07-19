import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { applyAssistantWidgetActions } from "../src/pages/dashboard/runtime/dashboardAssistantActions.ts";

const currentWidget = {
  config: {
    aggregation: "sum",
    color: { colors: ["#2563eb"] },
    xKey: "region",
    yKey: "revenue",
  },
  datasetId: "sales",
  id: "widget-1",
  title: "지역별 매출",
  type: "bar_chart",
};

test("create action reaches the editor persistence callback", async () => {
  let persisted: Record<string, unknown> | null = null;
  const messages = await applyAssistantWidgetActions({
    datasets: [],
    onCreateWidget: async (input) => {
      persisted = input as unknown as Record<string, unknown>;
      return true;
    },
    response: {
      actions: [{
        type: "create_widget",
        widget: {
          config: { aggregation: "sum", color: { colors: ["#2563eb"] }, xKey: "region", yKey: "revenue" },
          datasetId: "sales",
          title: "지역별 매출",
          type: "bar_chart",
        },
        usedEvidenceIds: [],
      }],
      message: "created",
      warnings: [],
    },
    widgets: [],
  });

  assert.equal(persisted?.datasetId, "sales");
  assert.equal(persisted?.type, "bar_chart");
  assert.deepEqual(messages, ["AI가 제안한 위젯을 추가했습니다."]);
});

test("update action merges editor state and persists dataset rows", async () => {
  let persistedWidgetId = "";
  let persisted: Record<string, unknown> | null = null;
  const rows = [{ region: "서울", revenue: 100 }];
  await applyAssistantWidgetActions({
    datasets: [{ id: "sales", rows }] as never,
    onUpdateWidget: async (widgetId, input) => {
      persistedWidgetId = widgetId;
      persisted = input as unknown as Record<string, unknown>;
      return true;
    },
    response: {
      actions: [{
        patch: { config: { color: { colors: ["#ef4444"] } }, title: "서울 매출" },
        type: "update_widget",
        usedEvidenceIds: [],
        widgetId: "widget-1",
      }],
      message: "updated",
      warnings: [],
    },
    widgets: [currentWidget] as never,
  });

  assert.equal(persistedWidgetId, "widget-1");
  assert.equal(persisted?.title, "서울 매출");
  assert.deepEqual((persisted?.config as Record<string, unknown>).color, { colors: ["#ef4444"] });
  assert.deepEqual(persisted?.data, rows);
});

test("failed persistence is surfaced instead of claiming a chart was applied", async () => {
  await assert.rejects(
    applyAssistantWidgetActions({
      datasets: [],
      onCreateWidget: async () => false,
      response: {
        actions: [{
          type: "create_widget",
          widget: { config: {}, datasetId: "sales", title: "차트", type: "bar_chart" },
          usedEvidenceIds: [],
        }],
        message: "created",
        warnings: [],
      },
      widgets: [],
    }),
    /저장에 실패/,
  );
});

test("missing persistence confirmation fails closed", async () => {
  await assert.rejects(
    applyAssistantWidgetActions({
      datasets: [],
      onCreateWidget: (async () => undefined) as never,
      response: {
        actions: [{
          type: "create_widget",
          widget: { config: {}, datasetId: "sales", title: "차트", type: "bar_chart" },
          usedEvidenceIds: [],
        }],
        message: "created",
        warnings: [],
      },
      widgets: [],
    }),
    /저장에 실패/,
  );
});

test("dashboard assistant surfaces reject stale responses before persistence", () => {
  const service = readFileSync(new URL("../src/services/dashboardAssistantService.ts", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../src/pages/dashboard/runtime/DashboardAssistantPanel.tsx", import.meta.url), "utf8");
  const widget = readFileSync(new URL("../src/pages/dashboard/runtime/WidgetRenderer.tsx", import.meta.url), "utf8");
  const ownership = readFileSync(new URL("../src/pages/dashboard/runtime/useDashboardAssistantRequestGate.ts", import.meta.url), "utf8");

  assert.match(service, /options: ApiRequestOptions = \{\}/);
  assert.match(service, /signal: options\.signal/);
  assert.match(service, /apiClient\.post<DashboardAssistantResponse>\([\s\S]*body, options\)/);
  assert.match(ownership, /new LatestRequestGate\(\)/);
  assert.match(ownership, /requests\.current\.invalidate\(\)/);
  assert.match(ownership, /requests\.begin\(createResourceQueryKey\(input\)\)/);
  for (const source of [panel, widget]) {
    assert.match(source, /useDashboardAssistantRequestGate\(/);
    assert.match(source, /beginDashboardAssistantRequest\(/);
    assert.match(source, /signal: lease\.signal/);
    assert.match(source, /isCurrent\(lease\)/);
    assert.match(source, /complete\(lease\)/);
  }
});
