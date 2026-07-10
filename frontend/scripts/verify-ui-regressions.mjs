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
    name: "AI chat creates local conversations and shows no mock response",
    file: "src/pages/ai/AiChatPage.tsx",
    patterns: [
      /function createConversation\(\): Conversation/,
      /setConversations\(\(current\) => \[nextConversation, \.\.\.current\]\);/,
      /<strong>AI runtime 미연결<\/strong>/,
      /<button disabled type="button"><FileText size=\{15\} \/><span>근거<\/span><small>미연결<\/small><\/button>/,
      /aria-current=\{conversation\.id === activeConversation\.id \? "page" : undefined\}/,
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
      /\.ai-context-option:focus-within \{ outline: 2px solid #2563eb;/,
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
