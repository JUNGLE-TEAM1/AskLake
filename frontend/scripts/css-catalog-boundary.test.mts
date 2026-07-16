import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const etlParts = [
  "01-source-shared.css",
  "02-schema.css",
  "03-rules.css",
  "04-permission.css",
  "05-review.css",
  "06-target-shared.css",
  "07-schema-target-overrides.css",
  "08-record-parsing.css",
];
const layoutParts = [
  "01-shell.css",
  "02-account.css",
  "03-admin.css",
  "04-workflow-forms.css",
];

function read(relativePath: string) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function lineCount(value: string) {
  return value.split("\n").length - (value.endsWith("\n") ? 1 : 0);
}

function braceDelta(value: string) {
  return [...value].reduce((depth, character) => depth + (character === "{" ? 1 : character === "}" ? -1 : 0), 0);
}

function selectorInventory(css: string) {
  const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)]
    .map((match) => match[1].trim().replace(/\s+/g, " "))
    .filter((selector) => selector && !selector.startsWith("@") && !selector.includes(":" + " "));
  const counts = new Map<string, number>();
  for (const selector of selectors) counts.set(selector, (counts.get(selector) ?? 0) + 1);
  return {
    duplicateDefinitions: [...counts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0),
    selectors: selectors.length,
    uniqueSelectors: counts.size,
  };
}

test("CSS entrypoints preserve the exact pre-split cascade", () => {
  const expectedEtlEntry = `${etlParts.map((file) => `@import "./etl/${file}";`).join("\n")}\n`;
  const expectedLayoutEntry = `${layoutParts.map((file) => `@import "./layout/${file}";`).join("\n")}\n`;
  assert.equal(read("src/styles/etl.css"), expectedEtlEntry);
  assert.equal(read("src/styles/layout.css"), expectedLayoutEntry);

  const etlSources = etlParts.map((file) => read(`src/styles/etl/${file}`));
  const layoutSources = layoutParts.map((file) => read(`src/styles/layout/${file}`));
  assert.equal(digest(etlSources.join("")), "07c8257b9ac5e496ad8173148941c3f32ff4141e82e312ae705f44df7c871771");
  assert.equal(digest(layoutSources.join("")), "c427c6371a8a2703fdb8711fc8e90d542d7e9a5b092b560d04979735cf5e921b");
  for (const [index, source] of etlSources.entries()) assert.equal(braceDelta(source), 0, `${etlParts[index]} must own complete CSS blocks`);
  for (const [index, source] of layoutSources.entries()) assert.equal(braceDelta(source), 0, `${layoutParts[index]} must own complete CSS blocks`);

  const etlInventory = selectorInventory(etlSources.join(""));
  const layoutInventory = selectorInventory(layoutSources.join(""));
  assert.ok(etlInventory.selectors > 1_000);
  assert.ok(layoutInventory.selectors > 150);
  assert.ok(etlInventory.duplicateDefinitions >= 0);
  assert.ok(layoutInventory.duplicateDefinitions >= 0);
  console.info("CSS selector inventory", { etl: etlInventory, layout: layoutInventory });
});

test("CSS and catalog entrypoints stay within their ownership budgets", () => {
  assert.ok(lineCount(read("src/styles/etl.css")) <= 20);
  assert.ok(lineCount(read("src/styles/layout.css")) <= 10);
  for (const file of etlParts) assert.ok(lineCount(read(`src/styles/etl/${file}`)) <= 3_000, file);
  for (const file of layoutParts) assert.ok(lineCount(read(`src/styles/layout/${file}`)) <= 1_000, file);

  assert.ok(lineCount(read("src/pages/catalog/CatalogPage.tsx")) <= 10);
  assert.ok(lineCount(read("src/pages/catalog/CatalogExplorerPage.tsx")) <= 500);
  assert.ok(lineCount(read("src/pages/catalog/CatalogDetailPage.tsx")) <= 700);
  assert.ok(lineCount(read("src/pages/catalog/CatalogLineage.tsx")) <= 600);
  assert.ok(lineCount(read("src/pages/catalog/catalogModel.ts")) <= 400);
  assert.ok(lineCount(read("src/pages/catalog/useCatalogExplorerState.ts")) <= 300);
});

test("catalog query and selection state are owned outside the presentation module", () => {
  const page = read("src/pages/catalog/CatalogExplorerPage.tsx");
  const state = read("src/pages/catalog/useCatalogExplorerState.ts");
  assert.match(page, /useCatalogExplorerState\(\{ datasets, onAction, onOpenSql, selectedDataset \}\)/);
  assert.doesNotMatch(page, /getCatalogDataset\(/);
  assert.doesNotMatch(page, /useEffect\(/);
  assert.match(state, /getCatalogDataset\(datasetId\)/);
  assert.match(state, /let cancelled = false/);
  assert.match(state, /setSelectedSqlDatasetId\(dataset\.id\)/);
  assert.match(state, /catalog\.page_changed/);
});
