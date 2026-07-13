import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const readCssWithLocalImports = (filePath, visited = new Set()) => {
  if (visited.has(filePath)) return "";
  visited.add(filePath);

  return readFileSync(filePath, "utf8").replace(
    /@import\s+["'](\.\/[^"']+)["'];/g,
    (_, importPath) => readCssWithLocalImports(resolve(dirname(filePath), importPath), visited),
  );
};

const read = (path) => {
  const filePath = resolve(root, path);
  return path.endsWith(".css")
    ? readCssWithLocalImports(filePath)
    : readFileSync(filePath, "utf8");
};

const checks = [
  {
    name: "ETL permission composes the governance, policy, and searchable grant workflow with shadcn controls",
    file: "src/pages/etl/EtlPages.tsx",
    patterns: [
      /title="권한 설정"/,
      /<EtlStepHeader[\s\S]*className="etl-step-standalone-header"[\s\S]*icon=\{<ShieldCheck \/>\}[\s\S]*title="권한 설정"/,
      /data-testid="permission-workflow"/,
      /<CardTitle>거버넌스 확인<\/CardTitle>/,
      /<CardTitle>접근 정책<\/CardTitle>/,
      /<CardTitle>역할 및 사용자 권한<\/CardTitle>/,
      /<SelectGroup>/,
      /<TabsTrigger value="roles">역할<\/TabsTrigger>/,
      /<TabsTrigger value="users">사용자<\/TabsTrigger>/,
      /placeholder=\{grantTab === "roles" \? "역할 검색" : "사용자 검색"\}/,
      /<Checkbox[\s\S]*onCheckedChange=\{\(checked\) => updateRoleCheck\(role\.id, checked === true\)\}/,
      /<PermissionGrantEmpty query=\{grantSearch\} \/>/,
      /fetchPermissionOptions\(\)/,
      /permissionGrants,/,
      /principalType: "group" as const/,
      /principalType: "user" as const/,
      /data-testid="permission-options-loading"/,
    ],
    forbiddenPatterns: [
      /<CardTitle>Governance Check<\/CardTitle>/,
      /<CardTitle>Access Policy<\/CardTitle>/,
      /<CardTitle>Role Grants<\/CardTitle>/,
      /\$\{selectedRoleCount\}개 선택/,
      /\$\{selectedUserCount\}명 선택/,
    ],
    forbiddenPatterns: [
      /생성할 데이터셋에 접근할 수 있는 역할과 사용자를 선택하세요\./,
      /<InfoBox title="권한 검토 필요"/,
      /<InfoBox title="추천 권한 템플릿"/,
      /recommended \? <em>Template<\/em> : null/,
      /공개 범위, 민감 데이터, 승인 상태를 생성 전에 확인합니다\./,
      /조직 정책에 맞는 권한 템플릿과 공개 범위를 설정합니다\./,
      /개 역할 선택 · 템플릿 기준 접근 권한을 조정합니다\./,
      /<NativeSelectField[^>]*label="권한 템플릿"/,
      /<NativeSelectField[^>]*label="공개 범위"/,
      /<NativeSelectField[^>]*label="승인 상태"/,
      /<em className=\{selected && role\.access\.includes\(item\) \? "allowed" : ""\}/,
      /<CheckableOption/,
      /PERMISSION_USERS/,
      /APPROVAL_STATUS_OPTIONS/,
      /label: "승인자"/,
      /label: "승인 상태"/,
    ],
  },
  {
    name: "Landing hero renders a scalable vector brand instead of enlarged raster logos",
    file: "src/pages/landing/AskLakeLandingPage.tsx",
    patterns: [
      /<h1 className="landing-hero-wordmark" id="landing-hero-title">\s*AskLake\s*<\/h1>/,
      /src="\/asklake-wave-hero\.svg"/,
    ],
    forbiddenPatterns: [
      /asklake-logo\.png/,
      /asklake-wave-icon\.png/,
    ],
  },
  {
    name: "Landing vector wordmark stays crisp and responsive",
    file: "src/styles/landing.css",
    patterns: [
      /font-size: clamp\(72px, 20vw, 248px\);/,
      /text-rendering: geometricPrecision;/,
      /-webkit-font-smoothing: antialiased;/,
      /background: url\("\/asklake-wave-hero\.svg"\) center \/ contain no-repeat;/,
    ],
    forbiddenPatterns: [
      /\.landing-hero-wordmark img/,
      /asklake-wave-icon\.png/,
    ],
  },
  {
    name: "SQL analysis page orchestrates focused SQL modules",
    file: "src/pages/sql/SqlAnalysisPage.tsx",
    patterns: [
      /import \{ SqlDatasetContextPanel \} from "\.\/SqlDatasetContextPanel";/,
      /import \{ SqlQueryEditorPanel \} from "\.\/SqlQueryEditorPanel";/,
      /import \{ SqlResultsPanel, type SqlResultView \} from "\.\/SqlResultsPanel";/,
      /const contextPanel = useSqlContextPanel\(\{/,
      /const queryAi = useSqlQueryAi\(\{/,
      /limit: previewRowLimit,/,
      /leadingAlign="center"/,
      /<SqlDatasetContextPanel/,
      /<SqlQueryEditorPanel/,
      /<SqlResultsPanel/,
      /<SqlJobWizardDialog/,
      /onCreate=\{createDerivedDatasetJob\}/,
      /onCreateDatasetJob: \(request: CreateDerivedDatasetRequest\) => Promise<boolean>;/,
      /const visiblePreflightSummary = preflightSummary\?\.tone === "success" \? null : preflightSummary;/,
    ],
    forbiddenPatterns: [
      /import \{ Slider \} from "@\/components\/ui\/slider";/,
      /<Slider/,
      /AI로 차트 만들기/,
      /chartGenerated/,
      /SqlChartBuilderDialog/,
      /SqlNessieAssistant/,
      /value="nessie"/,
      /Job 생성 검토로 이동/,
      /대시보드 만들기/,
      /DashboardPage/,
      /dashboardDialog/,
      /RAG 사용 가능/,
      /sql-materialize-tags/,
      /title=\{resultDraft \? `\$\{resultDraft\.rowCount\}행 조회됨`/,
      />완료</,
      /실행 ID \{resultDraft\.runId\}/,
    ],
  },
  {
    name: "SQL context panel keeps dataset and Dashboard chart tools together",
    file: "src/pages/sql/SqlDatasetContextPanel.tsx",
    patterns: [
      /<TabsTrigger value="tables"><Table2 \/> 분석 테이블<\/TabsTrigger>/,
      /<TabsTrigger value="chart"><BarChart3 \/> 차트 생성하기<\/TabsTrigger>/,
      /<SqlDatasetTree/,
      /<SqlChartConfigurator/,
      /className=\{styles\.datasetPanel\}/,
    ],
  },
  {
    name: "SQL editor module keeps Nessie, reset, execution, and autocomplete controls",
    file: "src/pages/sql/SqlQueryEditorPanel.tsx",
    patterns: [
      /<SqlAiWriterDialog disabled=\{disabled\} \{\.\.\.ai\} \/>/,
      /<Button type="button" onClick=\{onReset\}/,
      /<Button type="button" onClick=\{onExecute\}/,
      /className="focus-visible:ring-0 focus-visible:ring-offset-0"[\s\S]*id="sql-query-editor"/,
      /autocompleteCandidates\.map/,
      /title="선택 데이터셋 기준 SQL"/,
    ],
  },
  {
    name: "SQL result module reuses one result renderer in panel and dialog",
    file: "src/pages/sql/SqlResultsPanel.tsx",
    patterns: [
      /function SqlResultContent/,
      /aria-label="차트 보기"[\s\S]*차트 보기/,
      /aria-label="데이터 미리보기"[\s\S]*데이터 미리보기/,
      /<SqlChartEmptyState \/>/,
      /<DialogTitle>SQL 결과 전체 보기<\/DialogTitle>/,
      /<SqlResultChart chartConfig=\{chartConfig\} source=\{activeChartSource\} \/>/,
      /className=\{styles\.resultToolbar\}/,
      /className=\{styles\.resultScroll\}/,
    ],
  },
  {
    name: "SQL result dialog pages through the complete stored run snapshot",
    file: "src/pages/sql/SqlResultsPanel.tsx",
    patterns: [
      /dialogResultDraft: SqlResultDraft \| null;/,
      /pagePending: boolean;/,
      /onPageChange: \(offset: number\) => void;/,
      /aria-label="SQL 결과 페이지 탐색"/,
      />\s*처음\s*<\/Button>/,
      />\s*이전\s*<\/Button>/,
      /aria-label="SQL 결과 페이지"/,
      />\s*다음\s*<\/Button>/,
      />\s*마지막\s*<\/Button>/,
      /role="alert"/,
    ],
    forbiddenPatterns: [
      /resultDraft\.resultTruncated/,
      /최대.*행 탐색/,
    ],
  },
  {
    name: "SQL result paging adapter requests a stored run page by offset and limit",
    file: "src/services/mockApi.ts",
    patterns: [
      /export async function getQueryPreviewPage\(runId: string, options: QueryResultPageOptions\)/,
      /new URLSearchParams\(\{ limit: String\(limit\), offset: String\(offset\) \}\)/,
      /\/api\/query\/runs\/\$\{encodeURIComponent\(runId\)\}\?\$\{params\.toString\(\)\}/,
      /pageLimit: options\.limit/,
      /pageOffset: 0/,
    ],
    forbiddenPatterns: [
      /resultLimit:/,
      /resultTruncated:/,
    ],
  },
  {
    name: "SQL user edits do not reinitialize the query when cached results are invalidated",
    file: "src/pages/sql/SqlAnalysisPage.tsx",
    patterns: [
      /const initializedBaseDatasetIdRef = useRef<string \| null \| undefined>\(undefined\);/,
      /if \(initializedBaseDatasetIdRef\.current === nextBaseDatasetId\) return;/,
      /initializedBaseDatasetIdRef\.current = nextBaseDatasetId;/,
      /}, \[baseDataset\?\.id\]\);/,
      /const updateQuery = \(nextQuery: string\) => \{[\s\S]*setQuery\(nextQuery\);[\s\S]*resetResultState\(\);/,
      /const resetQuery = \(\) => \{[\s\S]*updateQuery\(defaultQuery\);/,
    ],
    forbiddenPatterns: [
      /skipNextBaseDatasetResetRef/,
      /}, \[baseDataset, canRestoreCachedResult, defaultQuery\]\);/,
    ],
  },
  {
    name: "SQL editor surface, gutter, and textarea share one responsive viewport",
    file: "src/pages/sql/SqlAnalysisPage.module.css",
    patterns: [
      /\.editorSurface \{[\s\S]*height: clamp\(276px, 36vh, 480px\);[\s\S]*overflow: hidden;/,
      /\.editorSurface pre \{[\s\S]*height: 100%;[\s\S]*min-height: 0;[\s\S]*overflow: hidden;/,
      /\.editorSurface textarea \{[\s\S]*height: 100%;[\s\S]*min-height: 0;[\s\S]*max-height: none;[\s\S]*resize: none;[\s\S]*overflow: auto;/,
      /\.editorInputWrap \{[\s\S]*height: 100%;[\s\S]*min-height: 0;[\s\S]*overflow: hidden;/,
    ],
  },
  {
    name: "SQL chart configurator reuses the Dashboard WidgetConfigPanel",
    file: "src/pages/sql/SqlChartConfigurator.tsx",
    patterns: [
      /import \{ WidgetConfigPanel \} from "\.\.\/dashboard\/runtime\/WidgetConfigPanel";/,
      /const datasets = useMemo\(\(\) => sources\.map\(toConfigDataset\), \[sources\]\);/,
      /<WidgetConfigPanel/,
      /datasets=\{datasets\}/,
      /onSelectDataset=\{setSelectedSourceId\}/,
      /createButtonLabel=\{initialCreateInput \? "변경 적용" : "차트 생성하기"\}/,
      /onApply\(\{/,
    ],
    forbiddenPatterns: [
      /fieldSelectMode="dropdown"/,
    ],
  },
  {
    name: "Nessie SQL writer uses Popover, Bubble, and controlled Collapsible",
    file: "src/pages/sql/SqlAiWriterDialog.tsx",
    patterns: [
      /Nessie로 SQL 작성/,
      /import \{ Bubble, BubbleContent, BubbleGroup \} from "@\/components\/ui\/bubble";/,
      /import \{ Collapsible, CollapsibleContent \} from "@\/components\/ui\/collapsible";/,
      /PopoverTrigger/,
      /<Collapsible open=\{promptOpen\}>/,
      /event\.nativeEvent\.isComposing/,
      /event\.shiftKey/,
      /void onGenerate\(\);/,
      /pendingStatusRef\.current\?\.focus\(\);/,
      /applyButtonRef\.current\?\.focus\(\);/,
      /SQL 초안 생성 중…/,
      /suggestion\?\.sql/,
      /onApply\(suggestion\.sql \?\? ""\)/,
      /편집기에 적용/,
    ],
    forbiddenPatterns: [
      /<Dialog/,
      /DialogContent/,
      /Enter 또는 Ctrl\/⌘ \+ Enter로 생성 · Shift \+ Enter로 줄바꿈/,
    ],
  },
  {
    name: "SQL result chart keeps its heading compact and fits inside the result panel",
    file: "src/pages/sql/SqlResultChart.tsx",
    patterns: [
      /min-h-\[320px\]/,
      /sql-result-chart-header flex min-w-0 items-center gap-2/,
      /shrink-0 text-sm text-muted-foreground/,
      /h-\[280px\]/,
    ],
    forbiddenPatterns: [
      /h-\[360px\]/,
    ],
  },
  {
    name: "AI workspace submits through the governed SQL suggestion contract",
    file: "src/pages/ai/AiChatPage.tsx",
    patterns: [
      /import \{ generateQueryAiSuggestion, getQueryAiErrorMessage, QUERY_AI_REQUEST_TIMEOUT_MS \} from "\.\.\/\.\.\/services\/queryAiService";/,
      /queryAiRequestRef\.current\?\.controller\.abort\(\);/,
      /previousRequest\?\.controller\.abort\(\);/,
      /const suggestion = await generateQueryAiSuggestion\(/,
      /signal: controller\.signal,/,
      /timeoutMs: QUERY_AI_REQUEST_TIMEOUT_MS,/,
      /finally \{[\s\S]*conversation\.id === conversationId \? \{ \.\.\.conversation, pending: false \}/,
      /content: getQueryAiErrorMessage\(error\)/,
      /onAction\("ai\.chat\.suggestion_created", "\/api\/query\/ai-suggestions"/,
      /onAction\("ai\.chat\.suggestion_failed", "\/api\/query\/ai-suggestions"/,
      /message\.sql \? <pre className="ai-chat-sql">/,
    ],
    forbiddenPatterns: [/runtimeUnavailable/, /prompt_drafted/],
  },
  {
    name: "AI suggestions preserve only the backend-validated response",
    file: "src/services/queryAiService.ts",
    patterns: [
      /return apiClient\.post<QueryAiSuggestion>\("\/api\/query\/ai-suggestions"/,
      /export const QUERY_AI_REQUEST_TIMEOUT_MS = 25_000;/,
      /signal: options\.signal,/,
      /timeoutMs: options\.timeoutMs \?\? QUERY_AI_REQUEST_TIMEOUT_MS,/,
      /error instanceof ApiRequestTimeoutError/,
      /hasErrorName\(error, "AbortError"\)/,
    ],
    forbiddenPatterns: [/useMock/, /draftSql\(/, /ensureSelectedJoinSuggestion/, /frontend JOIN 초안 fallback/],
  },
  {
    name: "API client keeps existing calls compatible while supporting cancellation and timeouts",
    file: "src/services/apiClient.ts",
    patterns: [
      /export type ApiRequestOptions = \{[\s\S]*signal\?: AbortSignal;[\s\S]*timeoutMs\?: number;/,
      /signal: timeoutController\?\.signal \?\? signal,/,
      /if \(didTimeout\) throw new ApiRequestTimeoutError\(timeoutMs as number\);/,
      /post: <T>\(path: string, body: unknown, options: ApiRequestOptions = \{\}\)/,
    ],
  },
  {
    name: "SQL Job creation submits an explicit draft without opening ETL Review",
    file: "src/hooks/useAskLakeData.ts",
    patterns: [
      /const createPipelineFromDraft = async \(/,
      /const createSqlDatasetJob = async \(request: CreateDerivedDatasetRequest\) =>/,
      /return createPipelineFromDraft\(nextDraft, \{ resetDraft: false \}\);/,
      /roles: buildSqlJobPermissionRoles\(request\.job\?\.accessScope, permissionOwner\)/,
      /description: request\.dataset\.description/,
      /tags: \[\]/,
      /rag: false/,
    ],
    forbiddenPatterns: [
      /prepareSqlDatasetJobDraft/,
      /onFlowChange\("review"\)/,
    ],
  },
  {
    name: "ETL Job collection upserts and reconciles rows by stable job id",
    file: "src/hooks/useAskLakeData.ts",
    patterns: [
      /function upsertJobById\(/,
      /jobs\.filter\(\(job\) => job\.id !== nextJob\.id\)/,
      /function replaceJobById\(/,
      /setJobs\(\(items\) => upsertJobById\(items, normalizedJob\)\)/,
      /setJobs\(\(items\) => replaceJobById\(items, jobId, updater\)\)/,
    ],
    forbiddenPatterns: [
      /items\.filter\(\(item\) => item\.name !== normalizedJob\.name\)/,
    ],
  },
  {
    name: "SQL Job governance keeps access scope and permission summary aligned",
    file: "src/pages/sql/sqlJobWizardModel.ts",
    patterns: [
      /export function buildPermissionSummary\(accessScope: SqlJobWizardAccessScope\)/,
      /accessScope,\s*owner:[\s\S]*permissionSummary: buildPermissionSummary\(accessScope\)/s,
    ],
    forbiddenPatterns: [
      /eyebrow="처리 작업"/,
      /SQL 결과를 기준으로 스케줄, 권한, 저장 위치를 확인한 뒤 Job을 생성합니다\./,
      />SQL Result</,
      /개 컬럼을 처리 Job 입력으로 사용합니다\./,
      />실행 미리보기</,
      /조직 정책과 승인 상태를 Job 검토 정보에 함께 저장합니다\./,
      /전체 \{resultDraft\.rowCount\.toLocaleString\(\)\}행 중 최대 5행을 확인합니다\./,
      /\{resultDraft\.columns\.length\}개 컬럼/,
    ],
  },
  {
    name: "SQL Job wizard fields use shared shadcn dropdown and time controls",
    file: "src/pages/sql/SqlJobWizardFields.tsx",
    patterns: [
      /export function WizardSelectField<T extends string>/,
      /export function WizardTimeField/,
      /const timeHourOptions = Array\.from\(\{ length: 24 \}/,
      /const timeMinuteOptions = Array\.from\(\{ length: 60 \}/,
      /<DropdownMenuTrigger asChild>/,
      /<DropdownMenuRadioGroup/,
      /<PopoverContent align="start" className="grid w-72 gap-3 p-3">/,
      /<ScrollArea className="h-52 rounded-lg border border-slate-200">/,
    ],
    forbiddenPatterns: [
      /NativeSelect/,
      /<select/,
      /type="time"/,
    ],
  },
  {
    name: "SQL Job wizard steps compose the shared selectable fields",
    file: "src/pages/sql/SqlJobWizardSteps.tsx",
    patterns: [
      /label="실행 시간"/,
      /label="실행 요일"/,
      /label="시간대"/,
      /label="실행 겹침 정책"/,
      /label="접근 범위"/,
      /<SqlJobTargetSettings/,
      /buildSqlJobPartitionOptions/,
    ],
  },
  {
    name: "SQL Job target settings align with ETL target metadata",
    file: "src/pages/sql/SqlJobTargetSettings.tsx",
    patterns: [
      /<DatabaseField/,
      /<S3PathField/,
      /label="포맷"/,
      /label="압축 방식"/,
      /파티션 컬럼 다중 선택/,
      /onCheckedChange=/,
      /tags: \[\.\.\.target\.tags, nextTag\]/,
      /target\.tags\.filter/,
    ],
    forbiddenPatterns: [
      /<select/,
      /<input[^>]+type="checkbox"/,
    ],
  },
  {
    name: "SQL Job draft preserves database, format, tags, and multiple partitions",
    file: "src/hooks/useAskLakeData.ts",
    patterns: [
      /const targetFormat = request\.job\?\.fileFormat/,
      /const partitionColumns = request\.job\?\.partitionColumns/,
      /databaseName: request\.job\?\.databaseName/,
      /format: targetFormat/,
      /partitionColumns,/,
      /tags: request\.job\?\.tags/,
    ],
  },
  {
    name: "Mock SQL Job creation preserves wizard schedule, governance, and storage settings",
    file: "src/services/mockApi.ts",
    patterns: [
      /permissionSummary: draftPipeline\.permission\.summary/,
      /schedulePolicy: \{/,
      /scheduleSummary: draftPipeline\.schedule\.summary/,
      /compression: draftPipeline\.target\.compression/,
      /partitionColumns: draftPipeline\.target\.partitionColumns/,
      /storagePath: draftPipeline\.target\.storagePath/,
      /targetDatabase: draftPipeline\.target\.databaseName/,
      /targetFormat: draftPipeline\.target\.format/,
      /targetTags: draftPipeline\.target\.tags/,
      /description: draftPipeline\.target\.description\?\.trim\(\)/,
    ],
  },
  {
    name: "SQL workspace height matches the dataset panel in all result states",
    file: "src/pages/sql/SqlAnalysisPage.module.css",
    patterns: [
      /--sql-workspace-height:\s*min\(860px, calc\(100dvh - 24px\)\);/,
      /\.datasetPanel[\s\S]*height:\s*var\(--sql-workspace-height\);/,
      /\.workspace[\s\S]*height:\s*var\(--sql-workspace-height\);/,
      /\.resultPanel[\s\S]*grid-template-rows:\s*max-content minmax\(0, 1fr\);/,
      /\.resultToolbar[\s\S]*display:\s*flex;/,
      /\.resultToolbar[\s\S]*flex-wrap:\s*wrap;/,
      /@media \(max-width: 860px\)[\s\S]*\.datasetPanel[\s\S]*height:\s*min\(720px, 80dvh\);/,
      /@media \(max-width: 860px\)[\s\S]*\.workspace[\s\S]*grid-column:\s*1;/,
      /\.resultScroll,[\s\S]*height:\s*100%;/,
    ],
  },
  {
    name: "Nessie popover styles stay scoped to the SQL AI module",
    file: "src/pages/sql/SqlAiWriterDialog.module.css",
    patterns: [
      /\.popover[\s\S]*width:\s*min\(440px, calc\(100vw - 32px\)\);/,
      /\.preview[\s\S]*height:\s*min\(220px, 28vh\);/,
      /@media \(prefers-reduced-motion: reduce\)/,
    ],
  },
  {
    name: "Catalog preview restores SQL navigation for the selected dataset",
    file: "src/pages/catalog/CatalogPage.tsx",
    patterns: [
      /onOpenSql:\s*\(dataset: CatalogDataset\) => void;/,
      /const openSelectedSqlDataset = \(\) =>/,
      /onOpenSql\(previewDataset\);/,
      /SQL 분석에서 열기/,
    ],
  },
  {
    name: "Catalog schema modal includes a paged actual-data viewer",
    file: "src/pages/catalog/CatalogPage.tsx",
    patterns: [
      /<CatalogDatasetViewer dataset=\{previewDataset\} \/>/,
      /<CatalogSchema dataset=\{dataset\} \/>[\s\S]*<CatalogSample dataset=\{dataset\} \/>/,
      /getCatalogDatasetRows\(dataset\.id, \{ limit: pageSize, offset \}\)/,
      /latestSuccessfulRun/,
      /aria-label="샘플 데이터 새로고침"/,
      />\s*처음\s*<\/Button>/,
      />\s*마지막\s*<\/Button>/,
      /표시할 데이터 행이 없습니다\./,
      /rowsErrorStatus === 403/,
    ],
  },
  {
    name: "Catalog sample table keeps a bounded viewport and sticky header",
    file: "src/styles/catalog.css",
    patterns: [
      /\.catalog-sample-scroll\s*\{[^}]*max-height:\s*min\(480px, 55vh\);/s,
      /\.catalog-sample-table th\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;/s,
      /\.catalog-dataset-viewer\s*\{[^}]*display:\s*grid;/s,
    ],
  },
  {
    name: "SQL analysis uses visible shadcn slider styling",
    file: "src/components/ui/slider.tsx",
    patterns: [
      /data-slot="slider-track"[\s\S]*bg-slate-200[\s\S]*data-\[orientation=horizontal\]:h-2/,
      /data-slot="slider-range"[\s\S]*bg-blue-600/,
      /data-slot="slider-thumb"[\s\S]*border-2 border-blue-600/,
    ],
  },
  {
    name: "SQL dataset browser uses the Shadcnblocks line tree",
    file: "src/pages/sql/SqlDatasetRow.tsx",
    patterns: [
      /from "@\/components\/kibo-ui\/tree";/,
      /<TreeProvider[\s\S]*expandedIds=\{expandedIds\}[\s\S]*showLines/,
      /<TreeNodeTrigger[\s\S]*data-sql-dataset-row=""/,
      /onClick=\{\(\) => onSelect\(dataset\)\}[\s\S]*toggleOnClick=\{false\}/,
      /<TreeExpander hasChildren \/>/,
      /<TreeNodeContent className="pb-2" hasChildren>/,
      /import \{ StatusBadge \} from "@\/components\/ui\/status-badge";/,
      /selectedDatasetIds: ReadonlySet<string>;/,
      /data-sql-dataset-selected=\{selected \? "" : undefined\}/,
      /onClick=\{\(\) => onSelect\(dataset\)\}/,
      /<StatusBadge className="ml-auto shrink-0" size="sm" tone="success">선택됨<\/StatusBadge>/,
    ],
  },
  {
    name: "Catalog dataset status uses the Jobs StatusBadge primitive",
    file: "src/pages/catalog/CatalogPage.tsx",
    patterns: [
      /import \{ StatusBadge \} from "@\/components\/ui\/status-badge";/,
      /<StatusBadge shape=\{shape\} size="sm" tone=\{statusTone\}>\{statusMeta\.label\}<\/StatusBadge>/,
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
    name: "Jobs landing run modal follows centrally polled state by stable run identity",
    file: "src/pages/ingest/JobsPages.tsx",
    patterns: [
      /type LatestRunModalSelection = \{[\s\S]*jobId: string;[\s\S]*runId: string;/,
      /const latestRunModal = useMemo\(\(\) => \{[\s\S]*jobs\.find\(\(candidate\) => candidate\.id === latestRunModalSelection\.jobId\)/,
      /job\.runHistory\?\.find\(\(candidate\) => candidate\.runId === latestRunModalSelection\.runId\)/,
      /setLatestRunModalSelection\(\{[\s\S]*jobId: job\.id,[\s\S]*runId: latestRun\.runId,/,
      /onClose=\{\(\) => setLatestRunModalSelection\(null\)\}/,
    ],
    forbiddenPatterns: [
      /setLatestRunModal\(\{ job, run: latestRun \}\)/,
    ],
  },
  {
    name: "SQL collapsed workspace stays in the visible grid column",
    file: "src/pages/sql/SqlAnalysisPage.module.css",
    patterns: [
      /\.collapsed \.workspace\s*\{[^}]*grid-column:\s*1;/s,
      /\.collapsed \.workspace\s*\{[^}]*min-width:\s*0;/s,
    ],
  },
  {
    name: "SQL collapsed control stays inside the workspace rail",
    file: "src/pages/sql/SqlAnalysisPage.tsx",
    patterns: [
      /<main className=\{cn\(styles\.workspace[\s\S]*contextPanel\.collapsed && \([\s\S]*className=\{styles\.contextRailButton\}/,
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
    name: "Schema target selection uses shared checkboxes and one delete action",
    file: "src/components/etl/SchemaTransformEditor.jsx",
    patterns: [
      /import \{ Checkbox \} from "@\/components\/ui\/checkbox";/,
      /aria-label="전체 타겟 필드 선택"/,
      /aria-label=\{`\$\{col\.name\} 선택`\}/,
      /targetSchema\.filter\(\(c\) => !selectedAfter\.has\(targetColumnKey\(c\)\)\)/,
    ],
    forbiddenPatterns: [/const moveAllToLeft =/, /aria-label="Remove all target columns"/, /onSchemaChange\(initialAfter\)/],
  },
  {
    name: "Schema projection preserves source columns and sample row order",
    file: "src/pages/etl/SchemaTransformWorkbench.tsx",
    patterns: [
      /const nextColumns = currentColumns\.map\(\(column\) => \{/,
      /if \(!selected\) return \{ \.\.\.column, included: false, targetOrder: undefined \};/,
      /const nextRows = sampleRows\.map\(\(row\) => \[\.\.\.row\]\);/,
    ],
  },
  {
    name: "Schema transform keeps source paths distinct and canonicalizes floating types",
    file: "src/pages/etl/SchemaTransformWorkbench.tsx",
    patterns: [
      /const sourceName = target\.originalName \|\| target\.name;/,
      /const selected = targetBySourceName\.get\(column\.sourceName\);/,
      /const source = \(column\.originalName \|\| column\.name\)\.trim\(\);/,
      /\["float", "float32", "float64", "double", "decimal", "number"\]\.includes\(normalized\)\) return "Double";/,
      /sourceType: column\.sourceType \?\? column\.type/,
    ],
    forbiddenPatterns: [/function normalizeSourceName/, /return "Float"/],
  },
  {
    name: "Schema visual transform serializes field controls as ordered canonical rules",
    file: "src/pages/etl/SchemaTransformWorkbench.tsx",
    patterns: [
      /operation: "Rename"/,
      /operation: `Cast \$\{outputType\}`/,
      /operation: "Default Value"/,
      /operation: "Null Guard"/,
      /if \(column\.notNull && column\.nullGuardExplicit\)/,
      /canonicalParameters: parameters/,
      /ensureRequiredFieldTransformSteps\(targetSchema, transformSteps\)/,
      /return \[\.\.\.requiredSteps, \.\.\.nonFieldSteps\];/,
      /if \(mode !== "sql" \|\| !sql\.trim\(\) \|\| continuous \|\| isKafka\) return;/,
      /previewSnapshotRules\(\{/,
      /recordsFromSampleRows\(columns, sampleRows\.slice\(0, 20\)\)/,
    ],
  },
  {
    name: "Target layer is an explicit setting for every ETL source",
    file: "src/pages/etl/EtlPages.tsx",
    patterns: [
      /const \[targetLayer, setTargetLayer\] = useState<TargetLayer>\(initialTargetLayer\);/,
      /label="데이터 레이어"/,
      /targetLayerOptions\.map\(\(layer\) => <SelectItem/,
      /targetLayer,/,
    ],
  },
  {
    name: "Schema editor allocates physical aliases without collapsing source identity",
    file: "src/components/etl/SchemaTransformEditor.jsx",
    patterns: [
      /float: "double"/,
      /float32: "double"/,
      /const targetColumnKey = \(column\) => `\$\{column\.sourceId \|\| sourceId \|\| "source"\}:\$\{String\(column\.originalName \|\| column\.name\)\}`;/,
      /const physicalName = column\.name\.replace\(\/\\\.\/g, "_"\);/,
      /name: getUniqueColumnName\(physicalName, usedNames\)/,
    ],
  },
  {
    name: "Catalog requires explicit dataset selection before SQL analysis",
    file: "src/pages/catalog/CatalogPage.tsx",
    patterns: [
      /setSelectedSqlDatasetId\(dataset\.id\);/,
      /selectedSqlDatasetId !== previewDataset\.id \|\| !canQueryCurrentDataset\(previewDataset\)/,
      /onOpenSql\(previewDataset\);/,
      /왼쪽 목록에서 데이터셋을 선택해 주세요\./,
    ],
    forbiddenPatterns: [/<AccordionItem value="materialization-runs">/, /생성 결과/],
  },
  {
    name: "Catalog wide action button keeps icon and label aligned",
    file: "src/styles/catalog.css",
    patterns: [
      /\.catalog-wide-button\s*\{[^}]*display:\s*inline-flex;/s,
      /\.catalog-wide-button\s*\{[^}]*align-items:\s*center;/s,
      /\.catalog-wide-button\s*\{[^}]*justify-content:\s*center;/s,
      /\.catalog-wide-button\s*\{[^}]*gap:\s*6px;/s,
      /\.catalog-wide-button\s*\{[^}]*width:\s*100%;/s,
    ],
  },
  {
    name: "Dashboard list table uses Jobs table spacing",
    file: "src/styles/dashboard.css",
    patterns: [
      /\.dashboard-table-scroll \.schema-table(?:,\s*\.dashboard-list-data-table)?\s*\{[^}]*table-layout:\s*fixed;/s,
      /\.dashboard-list-data-table\s*\{[^}]*min-width:\s*1320px;/s,
      /\.dashboard-table-list-body\s*\{[^}]*padding:\s*0;/s,
    ],
    forbiddenPatterns: [
      /\.dashboard-row-link\s*\{/,
      /\.dashboard-row-tags\s*\{/,
      /\.dashboard-row-tag\s*\{/,
    ],
  },
  {
    name: "Dashboard list states use shadcn feedback primitives",
    file: "src/pages/dashboard/DashboardLandingPage.tsx",
    patterns: [
      /import \{ Alert, AlertDescription, AlertTitle \} from "@\/components\/ui\/alert";/,
      /import \{ Skeleton \} from "@\/components\/ui\/skeleton";/,
      /function DashboardListSkeleton\(\)/,
      /<Alert variant="destructive">/,
      /<DashboardListSkeleton \/>/,
      /hasActiveFilters=\{Boolean\(searchQuery\.trim\(\) \|\| ownerFilter !== "all" \|\| selectedTags\.length\)\}/,
    ],
  },
  {
    name: "Dashboard API adapters do not hide backend failures with local state",
    file: "src/services/dashboardRuntimeApi.ts",
    patterns: [
      /return apiClient\.get<DashboardRuntimeResponse>/,
      /return apiClient\.post<DashboardRuntimeResponse>/,
      /return apiClient\.patch<\{ ok: true \}>/,
    ],
    forbiddenPatterns: [
      /apiConfig/,
      /runtimeStore/,
      /withRuntimeFallback/,
      /defaultWidgetData/,
    ],
  },
  {
    name: "Dashboard list uses backend state without mock responses",
    file: "src/services/dashboardApi.ts",
    patterns: [
      /apiClient\.post<DashboardListResponse \| DashboardPageResponse>/,
      /apiClient\.post<CreateDashboardResponse>/,
      /apiClient\.delete<DeleteDashboardResponse>/,
    ],
    forbiddenPatterns: [
      /apiConfig/,
      /createLocalDashboard/,
      /getMockDashboardListResponse/,
      /shouldUseLocalDashboardFallback/,
    ],
  },
  {
    name: "Dashboard Catalog options keep schema metadata without sample rows",
    file: "src/pages/dashboard/runtime/dashboardDatasetAdapters.ts",
    patterns: [
      /catalogDatasetToDashboardOption/,
      /dataset\.permissions\?\.canQuery !== false/,
    ],
    forbiddenPatterns: [
      /dataset\.sampleRows/,
      /catalogRowsToRecords/,
    ],
  },
  {
    name: "Dashboard widget editing restores server source config",
    file: "src/pages/dashboard/runtime/WidgetConfigPanel.tsx",
    patterns: [
      /const sourceConfig = runtimeConfig\.sourceConfig;/,
      /dataMode === "server_aggregated" \|\| dataMode === "server_preview"/,
      /sourceConfig: nextConfig/,
    ],
  },
  {
    name: "Dashboard assistant reuses the visualization prompt input composition",
    file: "src/pages/dashboard/runtime/DashboardAssistantPanel.tsx",
    patterns: [
      /import \{ VisualizationPromptInput, type VisualizationPromptInputHandle \} from "\.\/VisualizationPromptInput";/,
      /const promptInputRef = useRef<VisualizationPromptInputHandle \| null>\(null\);/,
      /<VisualizationPromptInput[\s\S]*ariaLabel="AskLake 질문"[\s\S]*rows=\{3\}[\s\S]*submitAriaLabel="질문 보내기"[\s\S]*onSubmit=\{\(\) => void submitQuestion\(\)\}/s,
    ],
    forbiddenPatterns: [
      /<Textarea/,
      /<Button aria-label="질문 보내기"/,
    ],
  },
  {
    name: "Visualization request widget uses a reusable shadcn prompt input",
    file: "src/pages/dashboard/runtime/VisualizationPromptInput.tsx",
    patterns: [
      /import \{ InputGroup, InputGroupTextarea \} from "@\/components\/ui\/input-group";/,
      /<InputGroup className="items-end p-1\.5">/,
      /<InputGroupTextarea/,
      /<Button aria-label=\{submitAriaLabel\} disabled=\{!canSubmit\} size="icon" type="submit">/,
      /if \(event\.key === "Escape"\)/,
    ],
  },
  {
    name: "Visualization request widget delegates prompt UI to the reusable module",
    file: "src/pages/dashboard/runtime/WidgetRenderer.tsx",
    patterns: [
      /import \{ VisualizationPromptInput, type VisualizationPromptInputHandle \} from "\.\/VisualizationPromptInput";/,
      /<VisualizationPromptInput[\s\S]*onSubmit=\{\(\) => void savePrompt\(\)\}/s,
    ],
    forbiddenPatterns: [
      /asklake-visualization-request-nessi-icon/,
    ],
  },
  {
    name: "Dashboard widget basics use shadcn form and single ToggleGroup composition",
    file: "src/pages/dashboard/runtime/WidgetConfigPanel.tsx",
    patterns: [
      /import \{ Field, FieldError, FieldGroup, FieldLabel \} from "@\/components\/ui\/field";/,
      /import \{ FormFieldGroup, type NativeSelectFieldProps \} from "@\/components\/ui\/form-field-group";/,
      /import \{ ToggleGroup, ToggleGroupItem \} from "@\/components\/ui\/toggle-group";/,
      /import \{ Tooltip, TooltipContent, TooltipProvider, TooltipTrigger \} from "@\/components\/ui\/tooltip";/,
      /<FieldGroup className="contents">/,
      /<DashboardFieldCombobox[\s\S]*label="데이터셋"/s,
      /<ToggleGroup[\s\S]*type="single"[\s\S]*value=\{type\}/s,
      /if \(!nextType\) return;/,
      /<TooltipTrigger asChild>[\s\S]*<ToggleGroupItem/s,
      /<FieldError>\{formError \?\? validationMessage\}<\/FieldError>/,
    ],
    forbiddenPatterns: [
      /IconOptionGrid/,
      /createPortal/,
      /widgetTypeTooltip/,
    ],
  },
  {
    name: "Dashboard edit uses shadcn Slider for radial range",
    file: "src/pages/dashboard/runtime/WidgetConfigPanel.tsx",
    patterns: [
      /import \{ Slider \} from "@\/components\/ui\/slider";/,
      /aria-label="radial chart 표시 범위"/,
      /minStepsBetweenThumbs=\{1\}/,
      /onValueChange=\{\(\[min = 0, max = 100\]\) => patchCurrentConfig\(\{ min, max \}\)\}/,
      /value=\{\[radialRangeStart, radialRangeEnd\]\}/,
      /최솟값은 최댓값보다 작아야 합니다/,
    ],
  },
  {
    name: "Dashboard widget settings use the shared searchable combobox",
    file: "src/pages/dashboard/runtime/WidgetConfigPanel.tsx",
    patterns: [
      /import \{ DashboardFieldCombobox, type DashboardComboboxOption \} from "\.\/DashboardFieldCombobox";/,
      /function WidgetSelectField\([\s\S]*?<DashboardFieldCombobox/,
      /Children\.toArray\(children\)\.flatMap/,
      /child\.type !== "option"/,
      /label="데이터셋"[\s\S]*?options=\{datasets\.map/,
      /className=\{cn\("asklake-widget-select", selectClassName\)\}/,
      /<strong className="min-w-0 max-w-full break-words">/,
    ],
    forbiddenPatterns: [
      /<select/,
      /WidgetSelectModeContext/,
      /fieldSelectMode/,
      /<Filter className="size-4 shrink-0 text-slate-500"/,
    ],
  },
  {
    name: "Dashboard edit toolbar separates active tools from action buttons",
    file: "src/pages/dashboard/runtime/DashboardEditToolbar.tsx",
    patterns: [
      /import \{ ButtonGroup \} from "@\/components\/ui\/button-group";/,
      /import \{ ToggleGroup, ToggleGroupItem \} from "@\/components\/ui\/toggle-group";/,
      /<ToggleGroup[\s\S]*?type="single"[\s\S]*?value=\{assistantActive \? "assistant" : "cursor"\}/,
      /<ButtonGroup aria-label="위젯 추가">/,
      /<ButtonGroup aria-label="편집 기록">/,
    ],
    forbiddenPatterns: [
      /from "@\/components\/ui\/action-group";/,
    ],
  },
  {
    name: "Dashboard widget combobox supports filtering and keyboard selection",
    file: "src/pages/dashboard/runtime/DashboardFieldCombobox.tsx",
    patterns: [
      /role="combobox"/,
      /className=\{cn\("min-w-0 w-full", fieldClassName\)\}/,
      /asklake-widget-combobox w-full min-w-0 max-w-full justify-between overflow-hidden text-left/,
      /placeholder=\{`\$\{label\} 검색`\}/,
      /event\.key === "Enter" && filteredOptions\.length === 1/,
      /role="listbox"/,
      /role="option"/,
      /import \{ ChevronDown, Search \} from "lucide-react";/,
      /"size-2 shrink-0 rounded-full bg-current"/,
    ],
    forbiddenPatterns: [
      /<Check className=\{option\.value === value/,
    ],
  },
  {
    name: "Dashboard dataset sidebar uses shadcn-compatible tree states",
    file: "src/pages/dashboard/runtime/DatasetSidebar.tsx",
    patterns: [
      /from "@\/components\/kibo-ui\/tree";/,
      /import \{ Alert, AlertDescription, AlertTitle \} from "@\/components\/ui\/alert";/,
      /import \{ Empty, EmptyDescription, EmptyHeader, EmptyTitle \} from "@\/components\/ui\/empty";/,
      /import \{ ScrollArea \} from "@\/components\/ui\/scroll-area";/,
      /import \{ Skeleton \} from "@\/components\/ui\/skeleton";/,
      /<TreeProvider[\s\S]*showLines/,
      /<TreeView aria-label="Dashboard dataset tree"/,
      /data-dashboard-dataset-node=\{item\.kind\}/,
    ],
    forbiddenPatterns: [
      /react-arborist/,
      /<TreePanel/,
    ],
  },
  {
    name: "Dashboard list reuses Jobs shadcn table composition",
    file: "src/pages/dashboard/components/DashboardTable.tsx",
    patterns: [
      /import \{ Avatar, AvatarFallback \} from "@\/components\/ui\/avatar";/,
      /DataTableStackedCell/,
      /DataTableCellPrimary/,
      /DataTableCellSecondary/,
      /header: "대시보드"/,
      /header: "마지막 수정"/,
      /header: "생성 일시"/,
      /header: "소유자"/,
      /<Avatar size="lg">/,
      /min-h-\[72px\] w-full justify-start rounded-none/,
      /onRowClick=\{\(row\) => onOpenDetail\(row\.original\)\}/,
      /event\.stopPropagation\(\);[\s\S]*onRequestDelete\(row\.original\);/,
    ],
    forbiddenPatterns: [
      /dashboard-row-tag/,
      /dashboard-row-link/,
      /header: "상태"/,
      /<StatusBadge/,
    ],
  },
  {
    name: "DataTable supports keyboard-accessible row navigation",
    file: "src/components/ui/data-table.tsx",
    patterns: [
      /onRowClick\?: \(row: Row<TData>\) => void;/,
      /role=\{onRowClick \? "link" : undefined\}/,
      /tabIndex=\{onRowClick \? 0 : undefined\}/,
      /event\.key !== "Enter" && event\.key !== " "/,
      /data-row-navigation=\{onRowClick \? "true" : undefined\}/,
      /data-row-navigation=\{onRowClick \? "true" : undefined\}[\s\S]*event\.stopPropagation\(\);[\s\S]*onRowClick\(row\);/,
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
      /const nextDatasetId = patch\.datasetId \?\? widget\.datasetId \?\? selectedDatasetId \?\? null;/,
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
    name: "Dashboard assistant renders conversation with shadcn Bubble",
    file: "src/pages/dashboard/runtime/DashboardAssistantPanel.tsx",
    patterns: [
      /import \{ Bubble, BubbleContent, BubbleGroup \} from "@\/components\/ui\/bubble";/,
      /<BubbleGroup aria-live="polite" className="asklake-assistant-messages">/,
      /import \{ motion, useReducedMotion \} from "motion\/react";/,
      /initial=\{shouldReduceMotion[\s\S]*?x: message\.role === "user" \? 28 : -28,[\s\S]*?y: 6,/,
      /transition=\{shouldReduceMotion[\s\S]*?damping: 28, mass: 0\.8, stiffness: 260, type: "spring"/,
      /align=\{message\.role === "user" \? "end" : "start"\}/,
      /variant=\{message\.role === "user" \? "default" : "secondary"\}/,
      /<BubbleContent className="whitespace-pre-wrap">\{message\.text\}<\/BubbleContent>/,
    ],
  },
  {
    name: "Bubble variants render with the AskLake white theme palette",
    file: "src/components/ui/bubble.tsx",
    patterns: [
      /\*:data-\[slot=bubble-content\]:bg-blue-600 \*:data-\[slot=bubble-content\]:text-white/,
      /\*:data-\[slot=bubble-content\]:border-slate-200 \*:data-\[slot=bubble-content\]:bg-white \*:data-\[slot=bubble-content\]:text-slate-900/,
      /\*:data-\[slot=bubble-content\]:bg-slate-100 \*:data-\[slot=bubble-content\]:text-slate-700/,
      /\*:data-\[slot=bubble-content\]:bg-blue-50 \*:data-\[slot=bubble-content\]:text-blue-950/,
      /\*:data-\[slot=bubble-content\]:border-red-200 \*:data-\[slot=bubble-content\]:bg-red-50 \*:data-\[slot=bubble-content\]:text-red-700/,
      /bg-slate-100[^\n]+text-slate-900[^\n]+ring-white/,
    ],
  },
  {
    name: "Schema Transform emits Spark-compatible identifier quoting",
    file: "src/components/etl/SchemaTransformEditor.jsx",
    patterns: [
      /const columnName = col\.name;/,
      /return `\$\{col\.transform\} AS \\\`\$\{col\.name\}\\\``;/,
      /return `\$\{expr\} AS \\\`\$\{col\.name\}\\\``;/,
      /return `\\\`\$\{columnName\}\\\` IS NOT NULL`;/,
    ],
    forbiddenPatterns: [
      /AS "\$\{col\.name\}"/,
      /return `"\$\{columnName\}" IS NOT NULL`;/,
    ],
  },
  {
    name: "Frontend defaults to the live dashboard Assistant API",
    file: "src/services/dashboardAssistantService.ts",
    patterns: [
      /VITE_DASHBOARD_ASSISTANT_API_PATH \?\? "\/api\/dashboards\/assistant"/,
    ],
  },
  {
    name: "Frontend defaults to live API mode",
    file: "src/services/apiClient.ts",
    patterns: [
      /VITE_USE_MOCK_API \?\? "false"/,
    ],
  },
  {
    name: "Dashboard status labels stay Korean",
    file: "src/utils/statusMeta.ts",
    patterns: [
      /draft: \{ label: "초안" \}/,
      /published: \{ label: "게시됨" \}/,
      /"초안": "draft"/,
      /"게시됨": "published"/,
    ],
  },
  {
    name: "Dashboard list fixtures stay empty",
    file: "src/pages/dashboard/dashboardListData.ts",
    patterns: [
      /defaultDashboardCards: SavedDashboardCard\[\] = \[\]/,
    ],
    forbiddenPatterns: [
      /dash_sales_demo/,
      /매출 분석 데모/,
    ],
  },
  {
    name: "Dashboard canvas uses shadcn ScrollArea instead of a native scrollbar",
    file: "src/pages/dashboard/runtime/DashboardRuntimeShell.tsx",
    patterns: [
      /import \{ ScrollArea \} from "@\/components\/ui\/scroll-area";/,
      /className="asklake-dashboard-canvas-scroll-area"/,
      /scrollbars="both"/,
      /viewportProps=\{\{ className: "asklake-dashboard-canvas-scroll-viewport" \}\}/,
    ],
  },
  {
    name: "Dashboard empty edit stage fills the initial workspace",
    file: "src/styles/dashboard-runtime.css",
    patterns: [
      /\.asklake-dashboard-canvas-scroll-area\s*\{[^}]*min-height:\s*0;/s,
      /\.asklake-dashboard-canvas-scroll-viewport\s*>\s*div\s*\{[^}]*min-height:\s*100%;/s,
      /\.asklake-dashboard-canvas-wrap\s*\{[^}]*background:\s*#ffffff;/s,
      /\.asklake-dashboard-edit-stage\s*\{[^}]*display:\s*flex;/s,
      /\.asklake-dashboard-edit-stage\s*\{[^}]*min-height:\s*100%;/s,
      /\.asklake-dashboard-edit-stage\s*>\s*\.asklake-dashboard-empty-canvas\s*\{[^}]*min-height:\s*460px;/s,
      /\.asklake-dashboard-edit-stage\s*>\s*\.asklake-dashboard-empty-canvas\s*\{[^}]*flex:\s*1 1 auto;/s,
    ],
  },
  {
    name: "Dashboard published view keeps explicit share copy and shadcn empty actions",
    file: "src/pages/dashboard/runtime/DashboardRuntimeShell.tsx",
    patterns: [
      /const copyShareLink = async \(\) =>/,
      /navigator\.clipboard\.writeText\(shareLink\)/,
      /document\.execCommand\("copy"\)/,
      /<Button type="button" onClick=\{\(\) => void copyShareLink\(\)\}>/,
      /\{\(mode === "draft" \|\| pages\.length > 0\) \? \(/,
    ],
    forbiddenPatterns: [
      /현재 대시보드 링크를 복사했습니다/,
    ],
  },
  {
    name: "ETL schedule uses one conditional shadcn settings surface",
    file: "src/pages/etl/EtlPages.tsx",
    patterns: [
      /<Card className="overflow-hidden" size="none">/,
      /<div aria-label="실행 방식" className="grid gap-4 md:grid-cols-2" role="group">/,
      /<ScheduleModeCard[\s\S]*selected=\{selectedOption === "skip"\}[\s\S]*title="직접 실행"/,
      /<ScheduleModeCard[\s\S]*selected=\{selectedOption === "repeat"\}[\s\S]*title="반복 실행"/,
      /aria-pressed=\{selected\}/,
      /selectedOption === "repeat" && <RepeatSettings/,
      /<FieldSet>/,
      /<Switch[\s\S]*id="schedule-retry-enabled"/,
      /<Separator \/>/,
      /onOverlapPolicyChange=/,
      /normalizeScheduleTimezone\(draftSchedule\.timezone\)/,
    ],
    forbiddenPatterns: [
      /파이프라인의 실행 시간, 반복 여부, 실행 정책을 설정합니다\./,
      /저장만 할지, 정해진 주기로 자동 실행할지 선택합니다\./,
      /자동 예약 없이 저장하고 필요할 때 Job 목록에서 직접 실행합니다\./,
      /<h2>직접 실행 정책<\/h2>/,
      />스케줄 없음</,
      /다음 실행 없음/,
      /schedule-config-/,
      /description="필요할 때 Job 목록에서 실행합니다\."/,
      /description="정해진 주기마다 자동으로 데이터를 처리합니다\."/,
    ],
  },
  {
    name: "Continuous execution history uses durable sessions and guarded live polling",
    file: "src/pages/ingest/JobsPages.tsx",
    patterns: [
      /props\.job\.executionMode === "continuous"/,
      /getContinuousSessions\(job\.id\)/,
      /getContinuousSessionBatches\(job\.id, nextSelectedId, 100\)/,
      /inFlightRef\.current/,
      /requestSequenceRef\.current/,
      /document\.visibilityState === "hidden"/,
      /schedule\(result\.ok \? 3000/,
      /title="스트림 세션 이력"/,
      /title="세션 Batch 상세"/,
      /label="세션 누적 적재"/,
      /label="현재 데이터셋"/,
      /function ContinuousDagModal\(/,
      /title="Streaming DAG"/,
      /etl\.continuous\.session_dag_opened/,
      /etl\.continuous\.batch_dag_opened/,
      /rowActionsHeader="DAG"/,
    ],
  },
  {
    name: "Continuous Kafka creation skips the scheduler and keeps stream controls explicit",
    file: "src/App.tsx",
    patterns: [
      /\["source", \.\.\.\(requiresRecordParsing \? \["recordParsing" as const\] : \[\]\), "schema", "permission", "target", "review"\]/,
      /labels\.filter\(\(step\) => step !== "스케줄"\)/,
      /continuousKafkaDraft \? "permission" : lastScheduleFlow/,
    ],
  },
  {
    name: "Continuous Kafka source exposes compact advanced stream settings",
    file: "src/pages/etl/EtlPages.tsx",
    patterns: [
      /고급 설정/,
      /label="시작 위치"/,
      /label="Trigger 간격"/,
      /label="Micro-batch 최대 메시지"/,
      /getSourceConnectorDefaults\(\)/,
      /\["Broker \/ Endpoint", defaultKafkaBroker\]/,
    ],
  },
  {
    name: "Database source connection discovery stays separate from target preview",
    file: "src/pages/etl/EtlPages.tsx",
    patterns: [
      /Collections: "탐색 가능한 컬렉션"/,
      /Tables: "탐색 가능한 테이블"/,
      /PostgreSQL:[\s\S]*testItems: \[\["Endpoint", "Not tested"\], \["Database", "Pending"\], \["Target discovery", "After connection"\]\]/,
      /MongoDB:[\s\S]*testItems: \[\["Endpoint", "Not tested"\], \["Database", "Pending"\], \["Target discovery", "After connection"\]\]/,
      /const requiresAssetSelectionForPreview = \["File \/ S3", "MongoDB", "PostgreSQL"\]\.includes\(activeSourceType\);/,
      /if \(!\["File \/ S3", "MongoDB", "PostgreSQL"\]\.includes\(activeSourceType\)\)/,
      /const result = await listSourceAssets\(activeSourceType, editableFields, ""\);/,
      /\(requiresAssetSelectionForPreview && !selectedAssetPath\)/,
      /schema: \{ columns: \[\], sampleRows: \[\], summary: "" \}/,
    ],
  },
  {
    name: "Schema required state stays separate from explicit quality and null-guard rules",
    file: "src/components/etl/SchemaTransformEditor.jsx",
    patterns: [
      /property === "notNull" \? \{ nullGuardExplicit: Boolean\(value\) \}/,
      /nullGuardExplicit: nextRequired \? Boolean\(existing\.nullGuardExplicit\) : false/,
      /nullGuardExplicit: nextRequired \? hasNullGuard \|\| Boolean\(existing\.nullGuardExplicit\) : false/,
    ],
  },
  {
    name: "Schema rule summary counts only configured quality rules",
    file: "src/services/schemaRuleSummary.ts",
    patterns: [
      /qualityRuleCount: enabledQualityRules\.length/,
      /requiredColumnCount/,
    ],
    forbiddenPatterns: [
      /enabledQualityRules\.length \+ requiredColumnCount/,
    ],
  },
  {
    name: "Kafka target controls expose only runtime-supported layer and format combinations",
    file: "src/pages/etl/EtlPages.tsx",
    patterns: [
      /const KAFKA_SNAPSHOT_TARGET_LAYER_OPTIONS: TargetLayer\[\] = \["RAW", "BRONZE", "SILVER"\]/,
      /const KAFKA_SNAPSHOT_TARGET_FORMAT_OPTIONS: TargetFileFormat\[\] = \["jsonl"\]/,
      /const KAFKA_CONTINUOUS_TARGET_FORMAT_OPTIONS: TargetFileFormat\[\] = \["parquet"\]/,
      /targetLayerOptions\.map/,
      /targetFormatOptions\.map/,
    ],
  },
  {
    name: "Continuous Kafka creation stores lifecycle metadata instead of a batch schedule",
    file: "src/services/draftPipelineContract.ts",
    patterns: [
      /const continuousKafka = draft\.source\.executionMode === "continuous"/,
      /scheduleLabel: continuousKafka \? "스케줄링 건너뛰기" : draft\.schedule\.label/,
      /scheduleSummary: continuousKafka \? "실시간 스트림은 작업 생성 후 시작\/중지로 제어"/,
    ],
  },
  {
    name: "ETL create and edit use the canonical Rule contract with legacy hydration",
    file: "src/services/draftPipelineContract.ts",
    patterns: [
      /const ruleCompilation = compileRuleContract\(\{/,
      /ruleContractVersion: RULE_CONTRACT_VERSION/,
      /rules: ruleCompilation\.rules/,
      /transformOutputColumns: ruleCompilation\.outputSchema/,
      /const canonicalRules = job\.rules\?\.length/,
      /canonicalRulesFromLegacy\(/,
      /legacyRulesFromCanonical\(canonicalRules\)/,
      /if \(patch\.rules !== undefined\)/,
    ],
  },
  {
    name: "ETL review accepts no-rule pass-through and reports compiler issues",
    file: "src/services/reviewApi.ts",
    patterns: [
      /const ruleCompilation = compileRuleContract\(\{/,
      /const processingReady = ruleCompilation\.status === "pass"/,
      /ruleCompilation,/,
      /"규칙 없음 · 원본 스키마 그대로 통과"/,
      /ruleCompilation\.issues\[0\]\?\.message/,
    ],
    forbiddenPatterns: [
      /Boolean\(request\.ruleSummary\.trim\(\)\)/,
      /Continuous에서는 transform\/quality rule을 제거하세요/,
    ],
  },
  {
    name: "Continuous schema editing exposes only streaming-safe canonical transforms and Preview",
    file: "src/pages/etl/SchemaTransformWorkbench.tsx",
    patterns: [
      /ensureRequiredFieldTransformSteps\(targetSchema, transformSteps\)/,
      /const nextSteps = buildTransformSteps\(nextTargetSchema\)/,
      /allowSqlTransform=\{!continuous && !isKafka\}/,
      /portableTransforms=\{continuous \|\| isKafka\}/,
      /transformsDisabled=\{false\}/,
      /streaming-safe canonical Rule/,
      /disabled=\{previewPending \|\| sampleRows\.length === 0\}/,
    ],
    forbiddenPatterns: [
      /실시간 규칙은 다음 compiler 페이즈 전까지 pass-through/,
      /실시간 규칙 Preview는 streaming compiler/,
    ],
  },
  {
    name: "Kafka field rules keep portable transforms, schema edits, quality, and failure policy together",
    file: "src/components/etl/TransformFunctionModal.jsx",
    patterns: [
      /const qualityRulePayload = \(targetColumn\)/,
      /const applyPortableFieldRules = \(\) =>/,
      /portable \? applyPortableFieldRules : applyFieldRules/,
      /<TabsTrigger value="quality">품질 검사<\/TabsTrigger>/,
      /<TabsTrigger value="failure">실패 처리<\/TabsTrigger>/,
      /Kafka Snapshot과 실시간 실행에서 동일하게 지원되는 변환만 표시합니다/,
    ],
    forbiddenPatterns: [
      /if \(portable\) \{/,
      /<SelectItem value="float">/,
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
  check.forbiddenPatterns?.forEach((pattern, index) => {
    if (pattern.test(contents)) {
      failures.push(`${check.name}: forbidden pattern #${index + 1} found in ${check.file}`);
    }
  });
}

if (failures.length > 0) {
  console.error("UI regression verification failed:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`UI regression verification passed (${checks.length} checks).`);
