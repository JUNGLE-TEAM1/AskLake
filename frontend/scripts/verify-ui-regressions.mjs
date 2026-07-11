import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const read = (path) => readFileSync(resolve(root, path), "utf8");

const checks = [
  {
    name: "SQL tool tabs use the shared shadcn layout and animated indicator",
    file: "src/pages/sql/SqlAnalysisPage.tsx",
    patterns: [
      /<Tabs[\s\S]*value=\{contextPanelTab\}/,
      /<TabsList className="grid w-full grid-cols-2"/,
      /<TabsTrigger[\s\S]*value="tables"/,
      /data-sql-tab-indicator=""/,
      /layoutId="sql-tools-active-tab"/,
    ],
  },
  {
    name: "Job detail localizes source metadata and manual schedules",
    file: "src/pages/ingest/JobsPages.tsx",
    patterns: [
      /"Bucket \/ Stage Name": "버킷 \/ 스테이지 이름"/,
      /"Path \/ Prefix": "경로 \/ 프리픽스"/,
      /return !label\.startsWith\("__"\) && !hiddenJobDetailFieldLabels\.has\(label\);/,
      /detail=\{realtime \? job\.scheduleSummary \?\? formatJobSchedule\(job\.schedule\) : formatJobSchedule\(job\.schedule\)\}/,
      /\{ label: "주기", value: formatJobSchedule\(job\.schedule\) \}/,
    ],
  },
  {
    name: "SQL collapsed workspace stays in the visible grid column",
    file: "src/styles/sql.css",
    patterns: [
      /\.sql-page\.context-collapsed \.sql-workspace\s*\{[^}]*grid-column:\s*1;/s,
      /\.sql-page\.context-collapsed \.sql-workspace\s*\{[^}]*min-width:\s*0;/s,
    ],
  },
  {
    name: "SQL page header uses the shared page gutter",
    file: "src/styles/base.css",
    patterns: [
      /\.page-body\.sql-body\s*\{[^}]*padding:\s*24px var\(--layout-page-padding\) 40px;/s,
    ],
  },
  {
    name: "Schema transform scrollbars do not render a fixed blue fake thumb",
    file: "src/styles/schema-transform-adapter.css",
    patterns: [
      /scrollbar-color:\s*#cbd5e1 transparent;/,
      /::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*#cbd5e1;/s,
    ],
    forbiddenPatterns: [
      /\.flex-1\.overflow-y-auto\.p-2::before/,
      /box-shadow:\s*inset -18px 0 0 #dbeafe/,
    ],
  },
  {
    name: "Catalog explains materialization runs as selectable data versions",
    file: "src/pages/catalog/CatalogPage.tsx",
    patterns: [
      /<ExternalLink \/> 데이터 버전/,
      /SQL 분석에 사용할 데이터 저장 시점을 선택합니다\./,
      /선택한 데이터 버전을 기준으로 SQL 분석을 엽니다\./,
    ],
    forbiddenPatterns: [/생성 결과/],
  },
  {
    name: "Catalog wide action button keeps icon and label aligned",
    file: "src/styles/catalog.css",
    patterns: [
      /\.catalog-wide-button\s*\{[^}]*display:\s*inline-flex;/s,
      /\.catalog-wide-button\s*\{[^}]*align-items:\s*center;/s,
      /\.catalog-wide-button\s*\{[^}]*justify-content:\s*center;/s,
      /\.catalog-wide-button\s*\{[^}]*gap:\s*6px;/s,
      /\.catalog-wide-button svg\s*\{[^}]*flex:\s*0 0 auto;/s,
    ],
  },
  {
    name: "Dashboard list uses shared DataTable cells and permission-aware actions",
    file: "src/pages/dashboard/components/DashboardTable.tsx",
    patterns: [
      /<DataTable/,
      /<DataTableStackedCell/,
      /<StatusBadge/,
      /<Avatar size="lg">/,
      /dashboard\.permissions\?\.canDelete !== false|row\.original\.permissions\?\.canDelete !== false/,
    ],
  },
  {
    name: "Dashboard DataTable keeps wide content inside its own viewport",
    file: "src/styles/dashboard.css",
    patterns: [
      /\.dashboard-table-viewport\s*\{[^}]*contain:\s*paint;/s,
      /\.dashboard-table-viewport\s*\{[^}]*max-width:\s*100%;/s,
      /\.dashboard-table-list-body\s*\{[^}]*min-width:\s*0;/s,
      /\.dashboard-table-list-body\s*\{[^}]*overflow:\s*hidden;/s,
    ],
  },
  {
    name: "ETL mobile scroll surfaces do not expand the document root",
    file: "src/styles/responsive.css",
    patterns: [
      /\.stepper-inner\s*\{[^}]*contain:\s*paint;/s,
      /\.stepper-inner\s*\{[^}]*max-width:\s*100%;/s,
      /\.stepper-inner\s*\{[^}]*overflow-x:\s*auto;/s,
    ],
  },
  {
    name: "ETL stepper clips overflow at the shell boundary",
    file: "src/styles/base.css",
    patterns: [
      /\.stepper\s*\{[^}]*min-width:\s*0;/s,
      /\.stepper\s*\{[^}]*overflow:\s*hidden;/s,
    ],
  },
  {
    name: "ETL review schema keeps wide columns inside its viewport",
    file: "src/styles/etl.css",
    patterns: [
      /\.review-schema-table-viewport\s*\{[^}]*contain:\s*paint;/s,
      /\.review-schema-table-viewport\s*\{[^}]*max-width:\s*100%;/s,
      /\.review-schema-table-viewport\s*\{[^}]*overflow-x:\s*auto;/s,
    ],
  },
  {
    name: "ApexCharts widget removes leaked foreignObject style text",
    file: "src/pages/dashboard/runtime/WidgetRenderer.tsx",
    patterns: [
      /const chartContainerRef = useRef<HTMLDivElement \| null>\(null\);/,
      /querySelectorAll\("foreignObject style"\)/,
      /styleElement\)\s*=>\s*styleElement\.remove\(\)/,
      /new MutationObserver\(cleanupApexStyleText\)/,
      /observer\.observe\(chartContainer,\s*\{\s*childList:\s*true,\s*subtree:\s*true\s*\}\)/,
      /<div className="asklake-apex-widget" ref=\{chartContainerRef\}/,
    ],
  },
  {
    name: "Visualization request patches can use the active dataset",
    file: "src/pages/dashboard/runtime/DashboardRuntimeView.tsx",
    patterns: [
      /const requestedDatasetId = patch\.datasetId \?\? widget\.datasetId \?\? selectedDatasetId \?\? null;/,
      /const nextDataset = dashboardDatasets\.find\(\(dataset\) => dataset\.id === requestedDatasetId\)/,
      /\?\? dashboardDatasets\[0\]/,
      /const nextData = cloneDatasetRows\(dashboardDatasets, nextDatasetId\);/,
      /activeDatasetId: selectedDatasetId,/,
    ],
  },
  {
    name: "Visualization request render guard accepts active dataset fallback",
    file: "src/pages/dashboard/runtime/WidgetRenderer.tsx",
    patterns: [
      /patchCanRenderVisualization\(widget, widgetPatch, assistantContext\?\.activeDatasetId\)/,
      /activeDatasetId\?: string \| null,/,
      /if \(patch\.datasetId \|\| widget\.datasetId \|\| activeDatasetId\) return true;/,
    ],
  },
  {
    name: "Widget config updates include selected dataset rows",
    file: "src/pages/dashboard/runtime/WidgetConfigPanel.tsx",
    patterns: [
      /function cloneDatasetRows\(dataset: DashboardDatasetOption \| null \| undefined\)/,
      /data: cloneDatasetRows\(selectedDataset\),/,
      /await onCreateWidget\(\{\s*\.\.\.nextInput,\s*data: cloneDatasetRows\(selectedDataset\),/s,
    ],
  },
  {
    name: "Count visualization settings do not require a numeric value column",
    file: "src/pages/dashboard/runtime/WidgetConfigPanel.tsx",
    patterns: [
      /const usesCount = config\.aggregation === "count";/,
      /\(type === "bar_chart" \|\| type === "line_chart" \|\| type === "area_chart"\) && \(!config\.xKey \|\| \(!usesCount && !config\.yKey\)\)/,
      /\(type === "donut_chart" \|\| type === "pie_chart" \|\| type === "treemap_chart"\) && \(!config\.labelKey \|\| \(!usesCount && !config\.valueKey\)\)/,
      /type === "heatmap_chart" && \(!config\.xKey \|\| !config\.yKey \|\| \(!usesCount && !config\.valueKey\)\)/,
    ],
  },
  {
    name: "Job edit selects the hydrated job before opening the edit flow",
    file: "src/hooks/useAskLakeData.ts",
    patterns: [
      /const normalizedJob = normalizeJobRow\(hydratedJob\);\s*applyHydratedJob\(normalizedJob\);\s*setSelectedJob\(normalizedJob\);\s*setDraftPipeline\(hydrateDraftPipelineFromJob\(normalizedJob, initialDraftPipeline\)\);/s,
    ],
  },
  {
    name: "Terminal Job success refreshes Catalog once per Run",
    file: "src/hooks/useAskLakeData.ts",
    patterns: [
      /const wasObservedActive = activeRunIds\.delete\(latestRun\.runId\);\s*return wasObservedActive && latestRun\.status === "success" \? latestRun\.runId : null;/s,
      /const terminalSuccessRunId = trackCatalogRefreshCandidate\(normalizedJob, catalogActiveRunIdsRef\.current\);/,
      /terminalSuccessRunId && !catalogRefreshRunIdsRef\.current\.has\(terminalSuccessRunId\)/,
      /catalogRefreshRunIdsRef\.current\.add\(terminalSuccessRunId\);/,
      /const refreshedDatasets = await getDatasets\(\);/,
      /applyHydratedDatasets\(refreshedDatasets\);/,
      /catalog\.datasets\.refresh_after_run_failed/,
    ],
  },
  {
    name: "AI chat context uses only queryable available datasets",
    file: "src/pages/ai/AiChatPage.tsx",
    patterns: [
      /datasets\.filter\(\(dataset\) => dataset\.status === "available" && dataset\.permissions\?\.canQuery !== false\)/,
      /type Conversation = \{[\s\S]*selectedDatasetIds: string\[\];[\s\S]*submissionState: SubmissionState;/,
      /onAction\("ai\.context\.dataset_toggled", "\/api\/ai\/context", datasetId\);/,
      /disabled=\{!activeConversation\.draftPrompt\.trim\(\) \|\| runtimeUnavailable \|\| selectedDatasets\.length === 0\}/,
    ],
  },
  {
    name: "Nessie chat creates local conversations and shows no mock response",
    file: "src/pages/ai/AiChatPage.tsx",
    patterns: [
      /function createConversation\(\): Conversation/,
      /setConversations\(\(current\) => \[nextConversation, \.\.\.current\]\);/,
      /<strong>Nessie runtime 미연결<\/strong>/,
      /<button disabled type="button"><FileText size=\{15\} \/><span>근거<\/span><small>미연결<\/small><\/button>/,
      /aria-current=\{conversation\.id === activeConversation\.id \? "page" : undefined\}/,
      /const deleteConversation = \(conversationId: string\) => \{/,
      /onAction\("ai\.chat\.deleted", "\/api\/ai\/conversations", conversationId\);/,
      /className="ai-conversation-delete"/,
    ],
  },
  {
    name: "AI chat context selector supports keyboard and outside close",
    file: "src/pages/ai/AiChatPage.tsx",
    patterns: [
      /event instanceof KeyboardEvent && event\.key === "Escape"/,
      /!contextPickerRef\.current\?\.contains\(event\.target as Node\)/,
    ],
  },
  {
    name: "AI conversation controls remain usable on mobile",
    file: "src/styles/ai.css",
    patterns: [
      /@media \(max-width: 720px\) \{[\s\S]*\.ai-response-blocks \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/,
      /\.ai-context-option:focus-within \{ outline: 2px solid #[0-9a-f]{6};/,
      /\.ai-conversation-sidebar\.open \{ transform: translateX\(0\); \}/,
    ],
  },
  {
    name: "Auth page uses AskLake-owned review class names",
    file: "src/pages/auth/AuthPage.tsx",
    patterns: [/asklake-review-card/, /asklake-review-card-header/, /asklake-review-icon/],
    forbiddenPatterns: [/xflow-/],
  },
  {
    name: "Profile page uses AskLake-owned review class names",
    file: "src/pages/profile/ProfilePage.tsx",
    patterns: [/asklake-review-stack/, /profile-review-stack/, /asklake-review-card/],
    forbiddenPatterns: [/xflow-/],
  },
  {
    name: "Admin page uses AskLake-owned review class names",
    file: "src/pages/admin/AdminConsolePage.tsx",
    patterns: [/asklake-review-card/, /asklake-review-card-header/, /asklake-review-icon/],
    forbiddenPatterns: [/xflow-/],
  },
];

const failures = [];

for (const check of checks) {
  const contents = read(check.file);
  check.patterns.forEach((pattern, index) => {
    if (!pattern.test(contents)) {
      failures.push(`${check.name}: missing pattern #${index + 1} in ${check.file}`);
    }
  });
  check.forbiddenPatterns?.forEach((pattern, index) => {
    if (pattern.test(contents)) {
      failures.push(`${check.name}: forbidden pattern #${index + 1} in ${check.file}`);
    }
  });
}

if (failures.length > 0) {
  console.error("UI regression verification failed:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`UI regression verification passed (${checks.length} checks).`);
