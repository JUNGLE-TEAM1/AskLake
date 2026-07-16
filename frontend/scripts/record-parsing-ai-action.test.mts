import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

type SourceFile = {
  source: string;
  url: URL;
};

function collectSourceFiles(directory: URL): SourceFile[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) return collectSourceFiles(url);
    if (!/\.(?:jsx|tsx)$/.test(entry.name)) return [];
    return [{ source: readFileSync(url, "utf8"), url }];
  });
}

function extractEtlSectionHeaderTags(source: string): string[] {
  const tags: string[] = [];
  let current: string[] | null = null;

  source.split("\n").forEach((line) => {
    if (!current && line.includes("<EtlSectionHeader")) current = [];
    if (!current) return;
    current.push(line);

    const singleLineTag = current.length === 1 && line.includes("/>");
    const standaloneClosing = line.trim() === "/>";
    if (!singleLineTag && !standaloneClosing) return;
    tags.push(current.join("\n"));
    current = null;
  });

  return tags;
}

test("record parsing always renders the AI inference placeholder without preset logic", () => {
  const etlPagesSource = readFileSync(new URL("../src/pages/etl/EtlPages.tsx", import.meta.url), "utf8");

  assert.match(etlPagesSource, /data-testid="record-parsing-ai-button"/);
  assert.match(etlPagesSource, /AI 필드 자동 추론/);
  assert.doesNotMatch(etlPagesSource, /CLICK_EVENT_RECORD_SCHEMA_PRESET|applyRecommendedSchema|isClickEventLogSource/);
  assert.doesNotMatch(
    etlPagesSource,
    /data-testid="record-parsing-ai-button"[\s\S]{0,300}(?:disabled=|onClick=)/,
  );
});

test("record parsing keeps content focused and makes large previews collapsible", () => {
  const etlPagesSource = readFileSync(new URL("../src/pages/etl/EtlPages.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(etlPagesSource, /record-parsing-source-strip/);
  assert.doesNotMatch(etlPagesSource, /record-parsing-count/);
  assert.doesNotMatch(etlPagesSource, /record-parsing-status/);
  assert.doesNotMatch(etlPagesSource, /source-explorer-preview-meta/);
  assert.doesNotMatch(etlPagesSource, /\{displayPreviewRows\.length\}행 · \{displayPreviewColumns\.length\}필드/);
  assert.match(etlPagesSource, /aria-controls="record-parsing-raw-sample"/);
  assert.match(etlPagesSource, /aria-controls="record-parsing-result-preview"/);
  assert.match(etlPagesSource, /aria-expanded=\{rawSampleExpanded\}/);
  assert.match(etlPagesSource, /aria-expanded=\{resultPreviewExpanded\}/);
});

test("ETL section headers share one typography and icon treatment", () => {
  const etlPagesSource = readFileSync(new URL("../src/pages/etl/EtlPages.tsx", import.meta.url), "utf8");
  const schemaSummarySource = readFileSync(new URL("../src/pages/etl/SchemaRuleSummary.tsx", import.meta.url), "utf8");
  const sectionHeaderSource = readFileSync(new URL("../src/components/etl/EtlSectionHeader.tsx", import.meta.url), "utf8");
  const etlSurfaceFiles = [
    ...collectSourceFiles(new URL("../src/pages/etl/", import.meta.url)),
    ...collectSourceFiles(new URL("../src/components/etl/", import.meta.url)),
  ];

  assert.match(etlPagesSource, /<EtlSectionHeader[\s\S]*title=\{connectionStatusCopy\[connectionStatus\]\.title\}/);
  assert.match(etlPagesSource, /<EtlSectionHeader[\s\S]*title="원본 샘플"/);
  assert.match(schemaSummarySource, /<EtlSectionHeader[\s\S]*title="적용 내용 확인"/);
  assert.match(sectionHeaderSource, /etl-section-header min-h-\[68px\] px-5 py-3\.5/);
  assert.match(sectionHeaderSource, /bg-blue-100 text-blue-600/);
  assert.match(sectionHeaderSource, /size="default"/);
  assert.doesNotMatch(sectionHeaderSource, /density|compact|size-9|size-\[18px\]/);

  etlSurfaceFiles.forEach(({ source, url }) => {
    const sectionHeaderTags = extractEtlSectionHeaderTags(source);
    sectionHeaderTags.forEach((tag) => {
      assert.doesNotMatch(tag, /\bdensity=/, `${url.pathname} must use the single ETL section-header size`);
    });
    if (!/Etl(?:Section|Step)Header\.tsx$/.test(url.pathname)) {
      assert.doesNotMatch(source, /<PanelHeader\b|<CardTitle\b|<h2\b/, `${url.pathname} must use the shared ETL headers`);
    }
  });
});

test("ETL pages use shared headers and the TanStack plus shadcn table renderer", () => {
  const etlPagesSource = readFileSync(new URL("../src/pages/etl/EtlPages.tsx", import.meta.url), "utf8");
  const schemaEditorSource = readFileSync(new URL("../src/components/etl/SchemaTransformEditor.jsx", import.meta.url), "utf8");
  const dataTableSource = readFileSync(new URL("../src/components/ui/data-table.tsx", import.meta.url), "utf8");

  assert.match(etlPagesSource, /icon=\{<SourceBrandIcon[\s\S]{0,160}title=\{current\.title\}/);
  assert.match(etlPagesSource, /aria-label="레코드 구조화 결과 미리보기 표"[\s\S]{0,240}<DataTable|<DataTable[\s\S]{0,240}aria-label="레코드 구조화 결과 미리보기 표"/);
  assert.doesNotMatch(etlPagesSource, /<table|<CardTitle|source-step-header|etl-review-card-header|hegun-section-title/);
  assert.doesNotMatch(schemaEditorSource, /<table/);
  assert.match(schemaEditorSource, /<DataTable/);
  assert.match(dataTableSource, /useReactTable\(/);
  assert.match(dataTableSource, /<Table(?:\s|>)/);
});
