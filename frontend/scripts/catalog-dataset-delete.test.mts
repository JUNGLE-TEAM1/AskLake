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
  const mockData = read("src/data/mockData.ts");
  assert.match(mockData, /const mockCatalogDatasetPermissions = \{/);
  assert.match(mockData, /canDelete: true/);
  assert.match(mockData, /permissions: \{ \.\.\.mockCatalogDatasetPermissions \}/);
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
