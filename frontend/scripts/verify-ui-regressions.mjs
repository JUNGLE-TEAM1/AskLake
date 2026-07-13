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
  return path.endsWith(".css") ? readCssWithLocalImports(filePath) : readFileSync(filePath, "utf8");
};

const checks = [
  {
    name: "SQL analysis uses Dashboard widget settings, a Nessie popover, and an in-dialog Job wizard",
    file: "src/pages/sql/SqlAnalysisPage.tsx",
    patterns: [
      /className="sql-workspace grid min-w-0 content-start gap-3"/,
      /className="sql-query-panel grid gap-4 p-5"/,
      /className=\{cn\("sql-result-panel grid gap-4 p-5", visibleResult && "has-result"\)\}/,
      /className="focus-visible:ring-0 focus-visible:ring-offset-0"[\s\S]*id="sql-query-editor"/,
      /limit: previewRowLimit,/,
      /<TabsTrigger value="tables"><Table2 \/> 분석 테이블<\/TabsTrigger>/,
      /<TabsTrigger value="chart"><BarChart3 \/> 차트 생성하기<\/TabsTrigger>/,
      /<SqlChartConfigurator/,
      /leadingAlign="center"/,
      /const handleSqlAssistantOpenChange = \(nextOpen: boolean\) =>/,
      /<SqlAiWriterDialog/,
      /<SqlAiWriterDialog[\s\S]*<Button type="button" onClick=\{resetQuery\}/,
      /className="sql-result-toolbar"/,
      /aria-label="차트 보기"[\s\S]*차트 보기/,
      /aria-label="데이터 미리보기"[\s\S]*데이터 미리보기/,
      /<SqlChartEmptyState \/>/,
      /<SqlJobWizardDialog/,
      /onCreate=\{createDerivedDatasetJob\}/,
      /onCreateDatasetJob: \(request: CreateDerivedDatasetRequest\) => Promise<boolean>;/,
      /<PanelHeader[\s\S]*title="선택 데이터셋 기준 SQL"/,
      /<ActionGroup density="compact" wrap="wrap">/,
      /import \{ ScrollArea \} from "@\/components\/ui\/scroll-area";/,
      /<ScrollArea className="sql-result-scroll" scrollbars="both" type="always">/,
      /<DialogTitle>SQL 결과 전체 보기<\/DialogTitle>/,
      /<SqlResultChart chartConfig=\{chartConfig\} source=\{activeChartSource\} \/>/,
      /const visiblePreflightSummary = preflightSummary\?\.tone === "success" \? null : preflightSummary;/,
      /estimate\.estimateSource === "iceberg_metadata"\) return "Iceberg 메타데이터 기준"/,
    ],
    forbiddenPatterns: [
      /import \{ Slider \} from "@\/components\/ui\/slider";/,
      /<Slider/,
      /AI로 차트 만들기/,
      /최근 동일 쿼리 실행 기준/,
      /최근 Dataset 실행 기준/,
      /예상 실행 시간/,
      /예상 남은 시간/,
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
    file: "src/pages/sql/SqlJobWizardDialog.tsx",
    patterns: [
      /function buildPermissionSummary\(accessScope: SqlJobWizardAccessScope\)/,
      /accessScope,\s*permissionSummary: buildPermissionSummary\(accessScope\)/s,
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
    name: "Mock SQL Job creation preserves wizard schedule, governance, and storage settings",
    file: "src/services/mockApi.ts",
    patterns: [
      /permissionSummary: draftPipeline\.permission\.summary/,
      /schedulePolicy: \{/,
      /scheduleSummary: draftPipeline\.schedule\.summary/,
      /compression: draftPipeline\.target\.compression/,
      /partitionColumns: draftPipeline\.target\.partitionColumns/,
      /storagePath: draftPipeline\.target\.storagePath/,
      /description: draftPipeline\.target\.description\?\.trim\(\)/,
    ],
  },
  {
    name: "SQL workspace preserves editor and result viewport height in all result states",
    file: "src/styles/sql.css",
    patterns: [
      /--sql-workspace-height:\s*clamp\(820px, calc\(100dvh - 24px\), 900px\);/,
      /\.sql-dataset-panel[\s\S]*height:\s*var\(--sql-workspace-height\);/,
      /\.sql-workspace[\s\S]*height:\s*auto;[\s\S]*min-height:\s*var\(--sql-workspace-height\);[\s\S]*max-height:\s*none;/,
      /\.sql-workspace[\s\S]*grid-template-rows:\s*max-content auto;/,
      /\.sql-result-panel\s*\{[\s\S]*min-height:\s*360px;/,
      /\.sql-result-panel\.has-result[\s\S]*height:\s*640px;[\s\S]*min-height:\s*640px;[\s\S]*max-height:\s*640px;[\s\S]*grid-template-rows:\s*max-content minmax\(0, 1fr\);/,
      /\.sql-result-toolbar[\s\S]*display:\s*flex;/,
      /\.sql-result-toolbar[\s\S]*flex-wrap:\s*wrap;/,
      /\.sql-editor-surface\s*\{[\s\S]*min-height:\s*276px;/,
      /\.sql-editor-surface textarea\s*\{[\s\S]*min-height:\s*276px;/,
      /\.sql-ai-popover[\s\S]*width:\s*min\(440px, calc\(100vw - 32px\)\);/,
      /@media \(max-width: 860px\)[\s\S]*\.sql-dataset-panel[\s\S]*height:\s*min\(720px, 80dvh\);/,
      /@media \(max-width: 860px\)[\s\S]*\.sql-workspace[\s\S]*grid-column:\s*1;/,
      /@media \(max-width: 860px\)[\s\S]*\.sql-result-panel,[\s\S]*\.sql-result-panel\.has-result[\s\S]*height:\s*auto;[\s\S]*min-height:\s*0;[\s\S]*max-height:\s*none;/,
      /\.sql-result-scroll[\s\S]*height:\s*100%;/,
    ],
    forbiddenPatterns: [
      /\.sql-query-panel\.has-run/,
      /\.sql-editor-surface[\s\S]*height:\s*144px;/,
    ],
  },
  {
    name: "SQL Trino result failures expose retries",
    file: "src/pages/sql/SqlAnalysisPage.tsx",
    patterns: [
      /setTrinoResultRetryCursor\(cursor\);/,
      /setTrinoResultRetryTargetIndex\(trinoResultPageIndex\);/,
      /const retryTrinoResultPage = async \(\) => \{/,
      /결과를 불러오지 못했습니다\./,
    ],
  },
  {
    name: "SQL Trino timeline preserves actual runtime stats in the completed execution stage",
    file: "src/pages/sql/SqlAnalysisPage.tsx",
    patterns: [
      /const completedQuerySummary = \[/,
      /run\.stats\?\.processedBytes != null \? formatEstimateBytes\(run\.stats\.processedBytes\) : null/,
      /run\.stats\?\.peakMemoryBytes != null \? `피크 \$\{formatEstimateBytes\(run\.stats\.peakMemoryBytes\)\}` : null/,
      /summary=\{queryStageStatus === "completed"[\s\S]*completedQuerySummary/,
      /처리 행 <strong>\{formatMetricNumber\(run\.stats\?\.processedRows\)\}<\/strong>/,
    ],
  },
  {
    name: "SQL query evaluation and three-stage Trino timeline distinguish execution, first result, and collection",
    file: "src/pages/sql/SqlAnalysisPage.tsx",
    patterns: [
      /const activeQueryEstimate = queryEstimateKey === queryValidationKey \? queryEstimate : null;/,
      /setTimeout\(\(\) => \{[\s\S]*estimateSqlQueryRun\(baseDataset, query, \[\.\.\.referenceDatasetIds\]\.sort\(\)\)/,
      /className=\{`sql-query-evaluation \$\{activeQueryEstimate\?\.riskLevel \?\? "neutral"\}`\}/,
      /if \(estimate\.estimateSource === "conservative_bound"\) return "보수적 추정";/,
      /보수적 예상 스캔량/,
      /Trino plan \$\{formatEstimateBytes\(estimate\.planEstimatedBytes\)\} · 원본 \$\{formatEstimateBytes\(estimate\.knownInputBytes\)\}/,
      /function TrinoExecutionTimeline\(/,
      /className="sql-run-timeline"/,
      /title="쿼리 실행"/,
      /title="첫 결과 준비"/,
      /title=\{collectionStateUnknown \? "전체 결과 상태 확인 중" : "전체 결과 수집"\}/,
      /aria-label="쿼리 실행 진행률"/,
      /queryProgressVisible && \(/,
      /aria-label="전체 결과 수집 진행률"/,
      /collectionProgressVisible && \(/,
      /<ProgressValue className="sql-run-progress-value" maximumFractionDigits=\{1\} \/>/,
      /`Trino \$\{formatDuration\(run\.stats\.elapsedMs\)\}`/,
      /`첫 결과 \$\{formatDuration\(firstResultElapsedMs\)\}`/,
      /`전체 준비 \$\{formatDuration\(totalReadyMs\)\}`/,
      /const firstResultPageUnavailable = \["expired", "unavailable"\]\.includes\(run\.result\?\.storageStatus \?\? ""\);/,
      /firstPageDisplayMs != null\s*[\s\S]*\|\| \(run\.result\?\.availablePageCount \?\? 0\) === 0\s*[\s\S]*\|\| firstResultPageUnavailable/,
      /const firstResultDisplayFailed = firstResultReady && !firstResultDisplayed && Boolean\(firstPageError\);/,
      /window\.requestAnimationFrame\(\(\) => \{/,
      /setTrinoFirstPageDisplayMs\(Math\.max\(0, Math\.round\(performance\.now\(\) - firstPageLoadStartedAt\)\)\)/,
      /대용량 결과 수집/,
      /수집 행/,
      /전체 행/,
      /결과 저장을 마무리하고 있습니다\./,
      /storageFailed \? "결과 저장 실패" : terminalSummary/,
      /\|\| trinoResultPage\s*[\s\S]*\|\| trinoResultPageIndex !== 0/,
      /const retryLoadKey = \["retry", trinoRun\.runId, retryTargetIndex, retryCursor \?\? "first"\]\.join\(":"\);/,
      /const \[trinoSubmissionPending, setTrinoSubmissionPending\] = useState\(false\);/,
      /setTrinoSubmissionPending\(shouldShowTrinoSubmissionTimeline\(usesTrinoRuntime, apiConfig\.useMock\)\);/,
      /className="sql-result-summary"/,
      /className="sql-result-body"/,
    ],
    forbiddenPatterns: [
      /setShowRunProgress/,
      /activeRunProgressPercentage/,
      /sql-run-stage-complete/,
      /전체 실행 진행률/,
      /title="실행 준비"/,
      /title="Trino 대기"/,
      /title="결과 준비 완료"/,
      /indeterminate=\{runProgressPercentage == null\}/,
      /indeterminate=\{collectionProgressPercentage == null\}/,
      /대용량 처리 예상/,
    ],
  },
  {
    name: "SQL Trino timeline derives three stages and measured-only progress in a tested pure model",
    file: "src/pages/sql/trinoExecutionTimeline.ts",
    patterns: [
      /const QUEUED_QUERY_STATES = new Set\(\["PLANNING", "QUEUED", "STARTING", "WAITING"\]\);/,
      /export function shouldShowTrinoSubmissionTimeline/,
      /export function buildTrinoExecutionTimelineModel/,
      /export const PROGRESS_VISIBILITY_DELAY_MS = 2_000;/,
      /const firstResultStageVisible = queryExecutionComplete;/,
      /const collectionStageVisible = queryExecutionComplete && firstResultReady;/,
      /collectionStateUnknown/,
      /storageStatus === "available" \|\| storageStatus === "expired"/,
      /storageFailed[\s\S]*\? "failed"/,
      /\(collectedRows \/ expectedRows\) \* 100/,
      /collectionProgressVisible: collectionActive[\s\S]*PROGRESS_VISIBILITY_DELAY_MS/,
      /queryProgressVisible: queryStageStatus === "active"[\s\S]*PROGRESS_VISIBILITY_DELAY_MS/,
      /const queryActiveElapsedMs = activeElapsed\(run\.startedAt \?\? run\.submittedAt, run\.stats\?\.elapsedMs, nowMs\);/,
      /progressPercentage != null && progressPercentage >= 100[\s\S]*kind: "finalizing"/,
      /milliseconds > 0[\s\S]*kind: "overdue"/,
    ],
    forbiddenPatterns: [
      /const serverValue = run\.result\?\.collectionProgressPercentage;/,
    ],
  },
  {
    name: "SQL three-stage execution timeline uses consistent responsive containers",
    file: "src/styles/sql.css",
    patterns: [
      /\.sql-run-timeline\s*\{[\s\S]*border-top:\s*1px solid #dbe3ef;/,
      /\.sql-run-stage-list\s*\{[\s\S]*display:\s*grid;/,
      /\.sql-run-stage\s*\{[\s\S]*min-height:\s*48px;[\s\S]*border:\s*1px solid #dbe3ef;/,
      /\.sql-run-stage\.active\s*\{[\s\S]*min-height:\s*92px;[\s\S]*border-left:\s*3px solid #2563eb;/,
      /\.sql-run-stage\.completed,\s*\.sql-run-stage\.expired\s*\{[\s\S]*background:\s*#f8fafc;/,
      /\.sql-run-stage-body\s*\{[\s\S]*padding:\s*10px 0 0 23px;/,
      /@media \(max-width: 760px\)[\s\S]*\.sql-run-stage-header-meta\s*\{[\s\S]*width:\s*100%;/,
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.sql-run-stage-spinner/,
    ],
  },
  {
    name: "SQL Query Run history dialog reopens persisted runs without rendering every result inline",
    file: "src/pages/sql/SqlAnalysisPage.tsx",
    patterns: [
      /listTrinoQueryRuns\(\)/,
      /const openTrinoRunHistoryItem = async \(summary: TrinoQueryRunHistoryItem\) => \{/,
      /setHistoryDialogOpen\(true\)/,
      /title="내 실행 이력"/,
      /getTrinoQueryRun\(summary\.runId\)/,
      /toTrinoHistoryItem\(nextRun\),/,
      /onNotify\(message, "info"\)/,
    ],
  },
  {
    name: "Trino SQL uses canonical validation and supports repeat Jobs",
    file: "src/pages/sql/SqlAnalysisPage.tsx",
    patterns: [
      /validateSqlQueryRun\(baseDataset, query, \[\.\.\.referenceDatasetIds\]\.sort\(\)\)/,
      /trinoValidationKey === queryValidationKey/,
      /> 반복 Job 만들기</,
      /onCreateTrinoSqlJob\(request\)/,
      /writeMode: "full_refresh"/,
      /engine=\{trinoJobResultDraft \? "trino" : "compatibility"\}/,
    ],
    forbiddenPatterns: [
      /setTrinoRun\(\(current\) => current \? \{[\s\S]*STATUS_POLL_FAILED/,
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
    name: "SQL analysis uses visible shadcn slider styling",
    file: "src/components/ui/slider.tsx",
    patterns: [
      /data-slot="slider-track"[\s\S]*bg-slate-200[\s\S]*data-\[orientation=horizontal\]:h-2/,
      /data-slot="slider-range"[\s\S]*bg-blue-600/,
      /data-slot="slider-thumb"[\s\S]*border-2 border-blue-600/,
    ],
  },
  {
    name: "SQL dataset browser uses the shared virtualized explorer tree",
    file: "src/pages/sql/SqlDatasetRow.tsx",
    patterns: [
      /import \{ ExplorerTree, type ExplorerTreeNode \} from "@\/components\/ui\/explorer-tree";/,
      /<ExplorerTree<SqlDatasetNode>/,
      /data=\{treeData\}/,
      /data-sql-dataset-row/,
      /initialOpenState=\{\{/,
      /onNodePress=\{\(node\) =>/,
      /selectedDatasetIds: ReadonlySet<string>;/,
      /selected: selectedDatasetIds\.has\(dataset\.id\)/,
      /data-sql-dataset-selected/,
      /onToggle=\{\(nodeId\) =>/,
      /toggleOnRowPress=\{false\}/,
    ],
    forbiddenPatterns: [
      /components\/kibo-ui\/tree/,
      /components\/ui\/tree-view/,
      /StatusBadge/,
      /getTrailing=/,
    ],
  },
  {
    name: "SQL base dataset re-click preserves the active editor context",
    file: "src/pages/sql/SqlAnalysisPage.tsx",
    patterns: [
      /const addSelectedDataset = \(targetDataset: CatalogDataset\) => \{\s*if \(targetDataset\.id === baseDataset\?\.id\) return;/,
      /if \(selectedDatasetIdSet\.has\(targetDataset\.id\)\) \{\s*removeSelectedDataset\(targetDataset\);/,
    ],
  },
  {
    name: "Shared explorer tree composes react-arborist behavior with AskLake row UI",
    file: "src/components/ui/explorer-tree.tsx",
    patterns: [
      /from "react-arborist";/,
      /new ResizeObserver\(updateHeight\)/,
      /<Tree<T>/,
      /disableDrag=\{treeProps\.disableDrag \?\? true\}/,
      /disableDrop=\{treeProps\.disableDrop \?\? true\}/,
      /disableEdit=\{treeProps\.disableEdit \?\? true\}/,
      /aria-expanded=\{node\.isInternal \? node\.isOpen : undefined\}/,
      /aria-selected=\{isSelected \|\| undefined\}/,
      /if \(toggleOnRowPress && node\.isInternal\) node\.toggle\(\);/,
      /node\.handleClick\(event\);/,
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
    file: "src/styles/sql.css",
    patterns: [
      /\.sql-page\.context-collapsed \.sql-workspace\s*\{[^}]*grid-column:\s*1;/s,
      /\.sql-page\.context-collapsed \.sql-workspace\s*\{[^}]*min-width:\s*0;/s,
    ],
  },
  {
    name: "SQL collapsed control stays inside the workspace rail",
    file: "src/pages/sql/SqlAnalysisPage.tsx",
    patterns: [
      /<main className="sql-workspace[\s\S]*contextCollapsed && \([\s\S]*className="sql-context-rail-button"/,
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
      /import \{ ToggleGroup, ToggleGroupItem \} from "@\/components\/ui\/toggle-group";/,
      /import \{ Tooltip, TooltipContent, TooltipProvider, TooltipTrigger \} from "@\/components\/ui\/tooltip";/,
      /<FieldGroup className="contents">/,
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
    ],
    forbiddenPatterns: [
      /<select/,
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
      /placeholder=\{`\$\{label\} 검색`\}/,
      /event\.key === "Enter" && filteredOptions\.length === 1/,
      /role="listbox"/,
      /role="option"/,
    ],
  },
  {
    name: "Dashboard dataset sidebar uses the shared virtualized explorer tree",
    file: "src/pages/dashboard/runtime/DatasetSidebar.tsx",
    patterns: [
      /import \{ ExplorerTree, type ExplorerTreeNode \} from "@\/components\/ui\/explorer-tree";/,
      /import \{ Alert, AlertDescription, AlertTitle \} from "@\/components\/ui\/alert";/,
      /import \{ Empty, EmptyDescription, EmptyHeader, EmptyTitle \} from "@\/components\/ui\/empty";/,
      /import \{ Skeleton \} from "@\/components\/ui\/skeleton";/,
      /<ExplorerTree<DatasetTreeNode>/,
      /ariaLabel="Dashboard dataset tree"/,
      /data-dashboard-dataset-node/,
      /onNodePress=\{\(node: NodeApi<DatasetTreeNode>\) =>/,
    ],
    forbiddenPatterns: [
      /components\/kibo-ui\/tree/,
      /components\/ui\/tree-view/,
      /<TreePanel/,
    ],
  },
  {
    name: "ETL source asset browser uses the shared explorer tree",
    file: "src/pages/etl/SourceAssetTree.tsx",
    patterns: [
      /import \{ ExplorerTree \} from "@\/components\/ui\/explorer-tree";/,
      /<ExplorerTree<SourceAssetTreeNode>/,
      /ariaLabel="소스 에셋 트리"/,
      /onToggle=\{\(nodeId\) =>/,
    ],
    forbiddenPatterns: [/components\/ui\/tree-view/, /<Tree<SourceAssetTreeNode>/],
  },
  {
    name: "S3 and JSON explorers use the shared explorer tree",
    file: "src/components/s3/S3PathField.tsx",
    patterns: [
      /import \{ ExplorerTree, type ExplorerTreeNode \} from "@\/components\/ui\/explorer-tree";/,
      /<ExplorerTree<S3TreeNode>/,
      /ariaLabel="S3 prefix tree"/,
      /onToggle=\{\(nodeId\) =>/,
    ],
    forbiddenPatterns: [/components\/ui\/tree-view/],
  },
  {
    name: "JSON sample hierarchy uses the shared explorer tree",
    file: "src/pages/etl/SourceJsonSampleTree.tsx",
    patterns: [
      /import \{ ExplorerTree, type ExplorerTreeNode \} from "@\/components\/ui\/explorer-tree";/,
      /<ExplorerTree<JsonTreeNode>/,
      /ariaLabel="JSON 샘플 트리"/,
    ],
    forbiddenPatterns: [/components\/ui\/tree-view/],
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
      /align=\{message\.role === "user" \? "end" : "start"\}/,
      /variant=\{message\.role === "user" \? "default" : "secondary"\}/,
      /<BubbleContent className="whitespace-pre-wrap">\{message\.text\}<\/BubbleContent>/,
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
    file: "src/styles/dashboard-runtime-canvas.css",
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
