import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const etlParts = [
  "00-shared.css",
  "01-source-shared.css",
  "02-schema.css",
  "03-rules.css",
  "04-permission.css",
  "05-review.css",
  "06-target-shared.css",
  "07-schema-target-overrides.css",
  "08-record-parsing.css",
];
const etlFacadeImports = [
  "./shared/base.css",
  "./routes/source.css",
  "./routes/schema.css",
  "./routes/rules.css",
  "./routes/schedule.css",
  "./routes/permission.css",
  "./routes/review.css",
  "./routes/target.css",
  "./shared/schema-target-overrides.css",
  "./routes/record-parsing.css",
];
const etlRouteFacades = new Map([
  ["permission.css", '@import "../04-permission.css";\n'],
  ["record-parsing.css", '@import "../08-record-parsing.css";\n'],
  ["review.css", '@import "../05-review.css";\n'],
  ["rules.css", '@import "../03-rules.css";\n'],
  ["schedule.css", "/* Schedule uses the shared ETL shell and component-level utility styles. */\n"],
  ["schema.css", '@import "../02-schema.css";\n'],
  ["source.css", '@import "../01-source-shared.css";\n'],
  ["target.css", '@import "../06-target-shared.css";\n'],
]);
const layoutParts = [
  "01-shell.css",
  "02-account.css",
  "03-admin.css",
  "04-workflow-forms.css",
];

function read(relativePath: string) {
  return readFileSync(resolve(root, relativePath), "utf8").replace(/\r\n/g, "\n");
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

function declarationsForSelector(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^{}]*)\\}`, "g"))].map((match) => (
    match[1]
      .split(";")
      .map((declaration) => declaration.trim().replace(/\s+/g, " "))
      .filter(Boolean)
  ));
}

test("CSS entrypoints preserve the exact reviewed cascade", () => {
  const expectedEtlEntry = '@import "./etl/facade.css";\n';
  const expectedEtlFacade = `${etlFacadeImports.map((file) => `@import "${file}";`).join("\n")}\n`;
  const expectedLayoutEntry = `${layoutParts.map((file) => `@import "./layout/${file}";`).join("\n")}\n`;
  assert.equal(read("src/styles/etl.css"), expectedEtlEntry);
  assert.equal(read("src/styles/etl/facade.css"), expectedEtlFacade);
  assert.equal(read("src/styles/etl/shared/base.css"), '@import "../00-shared.css";\n');
  assert.equal(read("src/styles/etl/shared/schema-target-overrides.css"), '@import "../07-schema-target-overrides.css";\n');
  for (const [file, expected] of etlRouteFacades) {
    assert.equal(read(`src/styles/etl/routes/${file}`), expected);
  }
  assert.equal(read("src/styles/layout.css"), expectedLayoutEntry);

  const etlSources = etlParts.map((file) => read(`src/styles/etl/${file}`));
  const layoutSources = layoutParts.map((file) => read(`src/styles/layout/${file}`));
  assert.equal(digest(etlSources.join("")), "e8a4a4d04e0552c7d4c5277a917c5909861a4d3555281077af9b6e6742e8db22");
  assert.equal(digest(layoutSources.join("")), "c427c6371a8a2703fdb8711fc8e90d542d7e9a5b092b560d04979735cf5e921b");
  for (const [index, source] of etlSources.entries()) assert.equal(braceDelta(source), 0, `${etlParts[index]} must own complete CSS blocks`);
  for (const [index, source] of layoutSources.entries()) assert.equal(braceDelta(source), 0, `${layoutParts[index]} must own complete CSS blocks`);

  const etlInventory = selectorInventory(etlSources.join(""));
  const layoutInventory = selectorInventory(layoutSources.join(""));
  assert.deepEqual(etlInventory, { duplicateDefinitions: 20, selectors: 429, uniqueSelectors: 409 });
  assert.deepEqual(layoutInventory, { duplicateDefinitions: 0, selectors: 246, uniqueSelectors: 246 });
  console.info("CSS selector inventory", { etl: etlInventory, layout: layoutInventory });
});

test("adjacent S3 tree panel rules stay consolidated without declaration drift", () => {
  const targetCss = read("src/styles/etl/06-target-shared.css");
  assert.deepEqual(declarationsForSelector(targetCss, ".s3-tree-panel"), [[
    "min-width: 0",
    "min-height: 0",
    "border: 1px solid #dee1e6",
    "border-radius: 8px",
    "background: #f9fbfc",
    "overflow: auto",
    "padding: 8px",
  ]]);
});

test("retired ETL selectors cannot silently reactivate legacy screens", () => {
  const etlCss = etlParts.map((file) => read(`src/styles/etl/${file}`)).join("\n");
  for (const retiredSelector of [
    ".source-connect-stack",
    ".schema-transform-editor",
    ".permission-row",
    ".target-debug-panel",
    ".transform-code-workbench",
  ]) {
    assert.doesNotMatch(etlCss, new RegExp(retiredSelector.replace(".", "\\.")));
  }
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
