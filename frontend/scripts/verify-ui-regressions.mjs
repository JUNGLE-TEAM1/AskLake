import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const read = (path) => readFileSync(resolve(root, path), "utf8");

const checks = [
  {
    name: "SQL sidebar tabs keep grid layout",
    file: "src/styles/sql.css",
    patterns: [
      /\.sql-sidebar-tabs\s*\{[^}]*display:\s*grid;/s,
      /\.sql-sidebar-tabs\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/s,
      /\.sql-sidebar-tabs button\s*\{[^}]*display:\s*inline-flex;/s,
      /\.sql-sidebar-tabs button\s*\{[^}]*gap:\s*6px;/s,
      /\.sql-sidebar-tabs button svg\s*\{[^}]*flex:\s*0 0 auto;/s,
    ],
  },
  {
    name: "SQL Trino result and materialization failures expose retries",
    file: "src/pages/sql/SqlAnalysisPage.tsx",
    patterns: [
      /setTrinoResultRetryCursor\(cursor\);/,
      /setTrinoResultRetryTargetIndex\(trinoResultPageIndex\);/,
      /const retryTrinoResultPage = async \(\) => \{/,
      /const retryTrinoMaterializationStatus = async \(\) => \{/,
      /결과를 불러오지 못했습니다\./,
      /등록 다시 확인/,
    ],
  },
  {
    name: "SQL Trino execution metrics expose actual runtime stats",
    file: "src/pages/sql/SqlAnalysisPage.tsx",
    patterns: [
      /className="sql-execution-metrics"/,
      /trinoRun\.stats\?\.processedBytes/,
      /trinoRun\.stats\?\.peakMemoryBytes/,
      /trinoRun\.stats\?\.processedRows/,
      /예상 처리량/,
    ],
  },
  {
    name: "SQL query evaluation and active run monitor distinguish estimates from runtime progress",
    file: "src/pages/sql/SqlAnalysisPage.tsx",
    patterns: [
      /const activeQueryEstimate = queryEstimateKey === queryValidationKey \? queryEstimate : null;/,
      /setTimeout\(\(\) => \{[\s\S]*estimateSqlQueryRun\(baseDataset, query, \[\.\.\.referenceDatasetIds\]\.sort\(\)\)/,
      /className=\{`sql-query-evaluation \$\{activeQueryEstimate\?\.riskLevel \?\? "neutral"\}`\}/,
      /const runProgressPercentage = trinoRun \? getRunProgressPercentage\(trinoRun\) : null;/,
      /runProgressPercentage == null \? "진행률 계산 중" : `\$\{Math\.round\(runProgressPercentage\)\}%`/,
      /className=\{runProgressPercentage == null \? "sql-run-progress indeterminate" : "sql-run-progress"\}/,
      /\{runPhase\}/,
    ],
  },
  {
    name: "SQL Query Run history reopens persisted runs without rendering every result",
    file: "src/pages/sql/SqlAnalysisPage.tsx",
    patterns: [
      /listTrinoQueryRuns\(\)/,
      /const openTrinoRunHistoryItem = async \(summary: TrinoQueryRunHistoryItem\) => \{/,
      /className="sql-run-history"/,
      /내 최근 실행/,
      /getTrinoQueryRun\(summary\.runId\)/,
      /toTrinoHistoryItem\(nextRun\),/,
      /onNotify\(message, "info"\)/,
    ],
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
    name: "Dashboard list table stays compact",
    file: "src/styles/dashboard.css",
    patterns: [
      /\.dashboard-table-scroll \.schema-table\s*\{[^}]*table-layout:\s*fixed;/s,
      /\.dashboard-table-list \.schema-table th,\s*\.dashboard-table-list \.schema-table td\s*\{[^}]*font-size:\s*13px;/s,
      /\.dashboard-row-link\s*\{[^}]*white-space:\s*nowrap;/s,
      /\.dashboard-row-tags\s*\{[^}]*flex-wrap:\s*nowrap;/s,
      /\.dashboard-row-tag\s*\{[^}]*height:\s*22px;/s,
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
];

const failures = [];

for (const check of checks) {
  const contents = read(check.file);
  check.patterns.forEach((pattern, index) => {
    if (!pattern.test(contents)) {
      failures.push(`${check.name}: missing pattern #${index + 1} in ${check.file}`);
    }
  });
}

if (failures.length > 0) {
  console.error("UI regression verification failed:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`UI regression verification passed (${checks.length} checks).`);
