import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Catalog list owns the direct Dataset delete action", () => {
  const explorer = read("src/pages/catalog/CatalogExplorerPage.tsx");
  const action = read("src/pages/catalog/CatalogDatasetDeleteAction.tsx");
  assert.match(explorer, /<CatalogDatasetDeleteAction/);
  assert.match(action, /목록에서 데이터셋 삭제/);
  assert.match(action, /onLoadDeletionImpact\(dataset\.id\)/);
  assert.match(action, /confirmation !== dataset\.name/);
});

test("Mock catalog datasets explicitly grant the demo admin delete permission", () => {
  const catalogState = read("src/state/asklake/catalogState.ts");
  assert.match(catalogState, /const mockCatalogDatasetPermissions = \{/);
  assert.match(catalogState, /canDelete: true/);
  assert.match(catalogState, /apiConfig\.useMock \? dataset\.permissions \?\? \{ \.\.\.mockCatalogDatasetPermissions \}/);
});

test("Dataset delete waits for durable backend success before removing the row", () => {
  const api = read("src/services/catalogApi.ts");
  const controller = read("src/state/asklake/useCatalogController.ts");
  assert.match(api, /api\/catalog\/datasets\/\$\{encodeURIComponent\(datasetId\)\}\?confirmName=\$\{encodeURIComponent\(confirmName\)\}/);
  assert.match(api, /api\/catalog\/dataset-deletions\/\$\{encodeURIComponent\(deletionId\)\}/);
  assert.match(controller, /completed\.status !== "succeeded"/);
  assert.match(controller, /items\.filter\(\(dataset\) => dataset\.id !== datasetId\)/);
  assert.ok(controller.indexOf("completed.status") < controller.indexOf("items.filter"));
});

test("Dataset delete invalidates SQL and dashboard frontend state", () => {
  const controller = read("src/state/asklake/useCatalogController.ts");
  const event = read("src/services/catalogEvents.ts");
  const sql = read("src/pages/sql/SqlAnalysisPage.tsx");
  const dashboardDatasets = read("src/pages/dashboard/runtime/useDashboardDatasets.ts");
  const dashboardRuntime = read("src/pages/dashboard/runtime/useDashboardRuntimeResources.ts");
  const dashboardPage = read("src/pages/dashboard/DashboardPage.tsx");

  assert.match(controller, /notifyCatalogDatasetDeleted\(datasetId\)/);
  assert.match(event, /asklake:catalog-dataset-deleted/);
  assert.match(dashboardDatasets, /onCatalogDatasetDeleted\(loadDatasets\)/);
  assert.match(dashboardRuntime, /onCatalogDatasetDeleted\(\(\) =>/);
  assert.match(dashboardPage, /availableDashboardDatasetIds/);
  assert.match(dashboardPage, /visibleSelectedPublishedWidgets/);
  assert.match(sql, /setReferenceDatasetIds\(\[\]\)/);
});
