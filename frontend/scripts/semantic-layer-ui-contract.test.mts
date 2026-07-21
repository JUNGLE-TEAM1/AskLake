import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(relativePath: string) {
  return readFileSync(path.join(frontendDir, relativePath), "utf8").replace(/\r\n/g, "\n");
}

test("semantic data selection always renders the selected dataset schema as a table", () => {
  const page = source("src/pages/semantic/SemanticLayerPage.tsx");

  assert.match(page, /function SchemaCard[\s\S]*semantic-real-schema-block/);
  assert.match(page, /실제 스키마[\s\S]*<Table>[\s\S]*<TableHeader>[\s\S]*<TableBody>/);
  assert.doesNotMatch(page, /<details className="semantic-real-schema-disclosure"/);
  assert.match(page, /datasets: providedDatasets/);
  assert.match(page, /const catalogDatasets = providedDatasets;/);
  assert.doesNotMatch(page, /apiClient[\s\S]*\/api\/catalog\/datasets/);
});

test("legacy AI workspace routes converge on the governed semantic catalog", () => {
  const app = source("src/App.tsx");

  assert.match(app, /semanticCatalogCompatibilityPaths = new Set\(\["\/ai", "\/semantic-layer"\]\)/);
  assert.match(app, /semanticCatalogCompatibilityPaths\.has\(location\.pathname\)[\s\S]*navigate\("\/catalog\?view=semantic", \{ replace: true \}\)/);
  assert.doesNotMatch(app, /<AiChatPage/);
});

test("semantic mutations stay single-flight and failed saves keep their editor open", () => {
  const page = source("src/pages/semantic/SemanticLayerPage.tsx");

  assert.match(page, /const busyRef = useRef\(false\)/);
  assert.match(page, /if \(busyRef\.current\) return false;[\s\S]*busyRef\.current = true;/);
  assert.match(page, /catch \(actionError\)[\s\S]*return false;[\s\S]*finally[\s\S]*busyRef\.current = false;/);
  assert.match(page, /if \(await onSave\(name\.trim\(\), description\)\) setEditing\(false\)/);
  assert.match(page, /if \(await onSave\(datasets\)\) setPickerOpen\(false\)/);
});

test("physical column picker does not expose a fallback dataset before selection", () => {
  const page = source("src/pages/semantic/SemanticLayerPage.tsx");

  assert.match(page, /function PhysicalColumnPicker[\s\S]*model\.datasets\.find\(\(item\) => item\.datasetId === datasetId\)/);
  assert.doesNotMatch(page, /function PhysicalColumnPicker[\s\S]*const dataset = modelDataset\(model, datasetId\)/);
});

test("analysis criteria are one workflow step with both definition sections visible", () => {
  const page = source("src/pages/semantic/SemanticLayerPage.tsx");

  assert.match(page, /id: "analysis", number: 2, title: "분석 기준"/);
  assert.match(page, /semantic-real-analysis-content[\s\S]*<MetricsSection[\s\S]*<DimensionsSection/);
  assert.doesNotMatch(page, /definitionView/);
});
