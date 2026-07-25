import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Catalog makes datasets retained after Job deletion visible as refresh-ended", () => {
  const detail = read("src/pages/catalog/CatalogDetailPage.tsx");
  const explorer = read("src/pages/catalog/CatalogExplorerPage.tsx");

  assert.match(detail, /dataset\.runtimeStatus === "producer_deleted"/);
  assert.match(detail, /자동 갱신 종료/);
  assert.match(explorer, /<DatasetStatusBadge dataset=\{dataset\} shape="compact"/);
});
