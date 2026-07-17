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
  assert.match(page, /\.catch\(\(\) => providedDatasets\)/);
});

test("analysis criteria are one workflow step with both definition sections visible", () => {
  const page = source("src/pages/semantic/SemanticLayerPage.tsx");

  assert.match(page, /id: "analysis", number: 2, title: "분석 기준"/);
  assert.match(page, /semantic-real-analysis-content[\s\S]*<MetricsSection[\s\S]*<DimensionsSection/);
  assert.doesNotMatch(page, /definitionView/);
});

test("whole-document embedding requires confirmation and index progress stays visible", () => {
  const page = source("src/pages/semantic/SemanticLayerPage.tsx");

  assert.match(page, /문서 전체 임베딩/);
  assert.match(page, /pendingWholeDocumentEmbedding/);
  assert.match(page, /위험을 이해하고 전체 포함/);
  assert.match(page, /RAG_APPROVAL_COLUMN_LIMIT = 256/);
  assert.match(page, /<RagJobHistory datasetId=\{selectedDatasetId\}[\s\S]*onLatestJobSettled=\{onRefresh\}/);
});
