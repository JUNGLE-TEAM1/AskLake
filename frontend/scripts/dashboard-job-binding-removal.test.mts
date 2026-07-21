import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

function source(path: string) {
  return readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
}

test("Job creation surfaces do not offer or create Dashboard bindings", () => {
  const creationSources = [
    "pages/etl/ReviewPage.tsx",
    "pages/sql/SqlJobWizardDialog.tsx",
    "pages/sql/ContinuousSqlJoinDialog.tsx",
    "pages/sql/useContinuousSqlJoin.ts",
    "state/asklake/usePipelineMutations.ts",
  ].map(source).join("\n");

  assert.doesNotMatch(
    creationSources,
    /dashboardBinding|dashboard-job-bindings|Dashboard 연동|결과를 Dashboard|createManagedJobDashboard/,
  );
});

test("Dashboard runtime uses ordinary Dataset selection without managed binding state", () => {
  const runtimeSources = [
    "pages/dashboard/DashboardPage.tsx",
    "pages/dashboard/runtime/DashboardRuntimeView.tsx",
    "pages/dashboard/runtime/WidgetConfigPanel.tsx",
    "pages/dashboard/runtime/DashboardAssistantPanel.tsx",
    "pages/dashboard/runtime/dashboardAssistantActions.ts",
    "pages/dashboard/runtime/dashboardDatasetAdapters.ts",
  ].map(source).join("\n");

  assert.doesNotMatch(
    runtimeSources,
    /managedDataset|DashboardJobBinding|bindingOutputToDashboardOption|getDashboardJobBinding|연동 Dashboard/,
  );
});

test("the frontend Dashboard binding API client is retired", () => {
  assert.equal(
    existsSync(new URL("../src/services/dashboardJobBindingApi.ts", import.meta.url)),
    false,
  );
});
