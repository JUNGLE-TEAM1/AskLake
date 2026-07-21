import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { applyAssistantWidgetActions } from "../src/pages/dashboard/runtime/dashboardAssistantActions.ts";
import { dashboardAssistantWidgetContextSignature } from "../src/pages/dashboard/runtime/dashboardAssistantContextSignature.ts";

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

test("type-changing update replaces incompatible config instead of retaining table fields", async () => {
  let persisted: Record<string, unknown> | null = null;
  await applyAssistantWidgetActions({
    datasets: [{ id: "sales", rows: [{ category: "Camera", price: 100 }] }] as never,
    onUpdateWidget: async (_widgetId, input) => {
      persisted = input as unknown as Record<string, unknown>;
      return true;
    },
    response: {
      actions: [{
        patch: {
          config: {
            aggregation: "avg",
            color: { colors: ["#2563eb"] },
            xKey: "category",
            yKey: "price",
          },
          type: "bar_chart",
        },
        type: "update_widget",
        usedEvidenceIds: [],
        widgetId: "widget-table",
      }],
      message: "updated",
      warnings: [],
    },
    widgets: [{
      config: { columns: ["category", "price"], limit: 100, sortKey: "category" },
      datasetId: "sales",
      id: "widget-table",
      title: "상품 표",
      type: "table",
    }] as never,
  });

  assert.equal(persisted?.type, "bar_chart");
  assert.deepEqual(persisted?.config, {
    aggregation: "avg",
    color: { colors: ["#2563eb"] },
    xKey: "category",
    yKey: "price",
  });
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

test("a no-op update is rejected instead of reporting fake success", async () => {
  let persistenceCalls = 0;
  await assert.rejects(
    applyAssistantWidgetActions({
      datasets: [],
      onUpdateWidget: async () => {
        persistenceCalls += 1;
        return true;
      },
      response: {
        actions: [{
          patch: { title: "지역별 매출" },
          type: "update_widget",
          usedEvidenceIds: [],
          widgetId: "widget-1",
        }],
        message: "updated",
        warnings: [],
      },
      widgets: [currentWidget] as never,
    }),
    /실제 변경사항이 없습니다/,
  );
  assert.equal(persistenceCalls, 0);
});

test("multiple mutation actions are rejected before any draft API callback", async () => {
  let persistenceCalls = 0;
  await assert.rejects(
    applyAssistantWidgetActions({
      datasets: [],
      onCreateWidget: async () => {
        persistenceCalls += 1;
        return true;
      },
      response: {
        actions: [
          {
            type: "create_widget",
            widget: { config: {}, datasetId: "sales", title: "차트 1", type: "bar_chart" },
            usedEvidenceIds: [],
          },
          {
            type: "create_widget",
            widget: { config: {}, datasetId: "sales", title: "차트 2", type: "line_chart" },
            usedEvidenceIds: [],
          },
        ],
        message: "created",
        warnings: [],
      },
      widgets: [],
    }),
    /여러 위젯 변경/,
  );
  assert.equal(persistenceCalls, 0);
});

test("widget context signature changes when the current editor config changes", () => {
  const before = dashboardAssistantWidgetContextSignature([currentWidget] as never);
  const after = dashboardAssistantWidgetContextSignature([{
    ...currentWidget,
    config: { ...currentWidget.config, xKey: "category" },
  }] as never);

  assert.notEqual(after, before);
});

test("dashboard assistant surfaces reject stale responses before persistence", () => {
  const service = readFileSync(new URL("../src/services/dashboardAssistantService.ts", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../src/pages/dashboard/runtime/DashboardAssistantPanel.tsx", import.meta.url), "utf8");
  const widget = readFileSync(new URL("../src/pages/dashboard/runtime/WidgetRenderer.tsx", import.meta.url), "utf8");
  const ownership = readFileSync(new URL("../src/pages/dashboard/runtime/useDashboardAssistantRequestGate.ts", import.meta.url), "utf8");
  const signature = readFileSync(new URL("../src/pages/dashboard/runtime/dashboardAssistantContextSignature.ts", import.meta.url), "utf8");
  const runtimeView = readFileSync(new URL("../src/pages/dashboard/runtime/DashboardRuntimeView.tsx", import.meta.url), "utf8");
  const creator = readFileSync(new URL("../src/pages/dashboard/runtime/useDraftWidgetCreator.ts", import.meta.url), "utf8");
  const mutations = readFileSync(new URL("../src/pages/dashboard/runtime/useDraftWidgetMutations.ts", import.meta.url), "utf8");
  const runtimeApi = readFileSync(new URL("../src/services/dashboardRuntimeApi.ts", import.meta.url), "utf8");

  assert.match(service, /options: ApiRequestOptions = \{\}/);
  assert.match(service, /signal: options\.signal/);
  assert.match(service, /apiClient\.post<DashboardAssistantResponse>\([\s\S]*body, options\)/);
  assert.match(ownership, /new LatestRequestGate\(\)/);
  assert.match(ownership, /requests\.current\.invalidate\(\)/);
  assert.match(ownership, /requests\.begin\(createResourceQueryKey\(input\)\)/);
  assert.match(signature, /widget\.config/);
  assert.match(panel, /dashboardAssistantWidgetContextSignature\(widgets\)/);
  assert.match(panel, /surfaceKeyRef\.current !== submissionSurfaceKey/);
  assert.match(widget, /dashboardAssistantWidgetContextSignature\(assistantWidgets\)/);
  assert.match(widget, /surfaceKeyRef\.current !== submissionSurfaceKey/);
  assert.doesNotMatch(widget, /response\.widgetPatch|response\.configPatch/);
  assert.match(runtimeView, /onCreateWidget=\{onCreateDatasetWidget\}/);
  assert.match(runtimeView, /onUpdateWidget=\{onUpdateWidget\}/);
  assert.match(creator, /await createDraftWidget\(dashboardId, selectedPageId,/);
  assert.match(mutations, /await updateDraftWidget\(dashboardId, widgetId, input\)/);
  assert.match(runtimeApi, /\/draft\/pages\/\$\{encodeURIComponent\(pageId\)\}\/widgets/);
  assert.match(runtimeApi, /\/draft\/widgets\/\$\{encodeURIComponent\(widgetId\)\}/);
  for (const source of [panel, widget]) {
    assert.match(source, /useDashboardAssistantRequestGate\(/);
    assert.match(source, /beginDashboardAssistantRequest\(/);
    assert.match(source, /signal: lease\.signal/);
    assert.match(source, /isCurrent\(lease\)/);
    assert.match(source, /complete\(lease\)/);
  }
});

test("dashboard assistant sends and renders the same explicit multi-dataset selection", () => {
  const runtimeView = readFileSync(new URL("../src/pages/dashboard/runtime/DashboardRuntimeView.tsx", import.meta.url), "utf8");
  const sidebar = readFileSync(new URL("../src/pages/dashboard/runtime/DatasetSidebar.tsx", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../src/pages/dashboard/runtime/DashboardAssistantPanel.tsx", import.meta.url), "utf8");

  assert.match(runtimeView, /setAssistantDatasetIds\(\(current\) => \([\s\S]*current\.includes\(dataset\.id\)[\s\S]*\[\.\.\.current, dataset\.id\]/);
  assert.match(runtimeView, /selectedDatasetIds=\{inspectorMode === "assistant" \? assistantDatasetIds : undefined\}/);
  assert.match(sidebar, /selectedDatasetIds !== undefined[\s\S]*selectedDatasetIds\.includes\(dataset\.id\)[\s\S]*dataset\.id === selectedDatasetId/);
  assert.match(panel, /selectedDatasetIds,[\s\S]*selectedWidgetId/);
});
