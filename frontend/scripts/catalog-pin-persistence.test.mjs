import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("catalog live adapter persists the actor-scoped pin through PUT and DELETE", () => {
  const source = read("src/services/catalogApi.ts");

  assert.match(source, /export async function pinCatalogDataset/);
  assert.match(source, /apiClient\.put<CatalogDatasetPreferenceResponse>/);
  assert.match(source, /`\/api\/catalog\/datasets\/\$\{encodeURIComponent\(datasetId\)\}\/pin`/);
  assert.match(source, /export async function unpinCatalogDataset/);
  assert.match(source, /apiClient\.delete<CatalogDatasetPreferenceResponse>/);
});

test("catalog page hydrates server preference and only confirms live mutations after the adapter succeeds", () => {
  const source = read("src/pages/catalog/CatalogPage.tsx");

  assert.match(source, /preferenceOverrides\[dataset\.id\] \?\? dataset\.userPreference/);
  assert.match(source, /if \(apiConfig\.useMock\) \{/);
  assert.match(source, /await pinCatalogDataset\(datasetId\)/);
  assert.match(source, /await unpinCatalogDataset\(datasetId\)/);
  assert.match(source, /\[response\.datasetId\]: response\.userPreference/);
  assert.match(source, /catalog\.dataset\.pin_failed/);
  assert.doesNotMatch(source, /const \[pinnedDatasetIds, setPinnedDatasetIds\] = useState/);
});

test("catalog dataset contract exposes the canonical userPreference shape", () => {
  const source = read("src/types/catalog.ts");

  assert.match(source, /export type CatalogDatasetUserPreference = \{/);
  assert.match(source, /pinned: boolean;/);
  assert.match(source, /pinnedAt: string \| null;/);
  assert.match(source, /userPreference\?: CatalogDatasetUserPreference;/);
});
