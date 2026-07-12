import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const read = (path) => readFileSync(resolve(root, path), "utf8");

const checks = [
  {
    name: "SQL analysis uses Dashboard widget settings, a Nessie popover, and an in-dialog Job wizard",
    file: "src/pages/sql/SqlAnalysisPage.tsx",
    patterns: [
      /className="sql-workspace grid min-w-0 content-start gap-3"/,
      /className="sql-query-panel grid gap-4 p-5"/,
      /className=\{cn\("sql-result-panel grid gap-4 p-5", resultDraft && "has-result"\)\}/,
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
    name: "SQL chart configurator reuses the Dashboard WidgetConfigPanel",
    file: "src/pages/sql/SqlChartConfigurator.tsx",
    patterns: [
      /import \{ WidgetConfigPanel \} from "\.\.\/dashboard\/runtime\/WidgetConfigPanel";/,
      /const datasets = useMemo\(\(\) => sources\.map\(toConfigDataset\), \[sources\]\);/,
      /<WidgetConfigPanel/,
      /datasets=\{datasets\}/,
      /fieldSelectMode="dropdown"/,
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
    name: "Mock Nessie SQL generation follows common chart dimensions and metrics",
    file: "src/services/queryAiService.ts",
    patterns: [
      /\[\/채널\|channel\/, \/channel\/\]/,
      /\[\/주문\|order\/, \/\^\(orders\?\|order_count\)\$\/\]/,
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
    name: "SQL workspace height matches the dataset panel in all result states",
    file: "src/styles/sql.css",
    patterns: [
      /--sql-workspace-height:\s*min\(860px, calc\(100dvh - 24px\)\);/,
      /\.sql-dataset-panel[\s\S]*height:\s*var\(--sql-workspace-height\);/,
      /\.sql-workspace[\s\S]*height:\s*var\(--sql-workspace-height\);/,
      /\.sql-result-panel\.has-result[\s\S]*grid-template-rows:\s*max-content minmax\(0, 1fr\);/,
      /\.sql-result-toolbar[\s\S]*display:\s*flex;/,
      /\.sql-result-toolbar[\s\S]*flex-wrap:\s*wrap;/,
      /\.sql-ai-popover[\s\S]*width:\s*min\(440px, calc\(100vw - 32px\)\);/,
      /@media \(max-width: 860px\)[\s\S]*\.sql-dataset-panel[\s\S]*height:\s*min\(720px, 80dvh\);/,
      /@media \(max-width: 860px\)[\s\S]*\.sql-workspace[\s\S]*grid-column:\s*1;/,
      /\.sql-result-scroll[\s\S]*height:\s*100%;/,
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
      /aria-label="전체 타겟 컬럼 선택"/,
      /aria-label=\{`\$\{col\.name\} 선택`\}/,
      /targetSchema\.filter\(\(c\) => !selectedAfter\.has\(targetColumnKey\(c\)\)\)/,
    ],
    forbiddenPatterns: [/const moveAllToLeft =/, /aria-label="Remove all target columns"/],
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
      /import \{ Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue \} from "@\/components\/ui\/select";/,
      /import \{ ToggleGroup, ToggleGroupItem \} from "@\/components\/ui\/toggle-group";/,
      /import \{ Tooltip, TooltipContent, TooltipProvider, TooltipTrigger \} from "@\/components\/ui\/tooltip";/,
      /<FieldGroup className="contents">/,
      /<Select[\s\S]*<SelectGroup>[\s\S]*<SelectItem/s,
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
      /WidgetSelectModeContext = createContext<"combobox" \| "dropdown">\("combobox"\)/,
      /selectMode === "dropdown"/,
      /<DropdownMenuTrigger asChild>/,
      /<DropdownMenuRadioGroup/,
      /const selectValue = value \|\| widgetEmptySelectValue;/,
      /<DropdownMenuLabel>\{String\(props\.label\)\} 필터<\/DropdownMenuLabel>/,
      /<WidgetSelectModeContext\.Provider value=\{fieldSelectMode\}>/,
    ],
    forbiddenPatterns: [
      /<select/,
      /<Filter className="size-4 shrink-0 text-slate-500"/,
    ],
  },
  {
    name: "Dashboard edit toolbar separates active tools from action buttons",
    file: "src/pages/dashboard/runtime/DashboardRuntimeView.tsx",
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
    name: "Dashboard list fixtures and status labels stay localized",
    file: "src/pages/dashboard/dashboardListData.ts",
    patterns: [
      /name: "매출 분석 데모/,
      /tags: "영업 · 매출 · 데모"/,
      /name: "마케팅 캠페인 수익률 추적"/,
      /name: "데이터 품질 운영 현황"/,
      /owner: "관리자"/,
    ],
    forbiddenPatterns: [
      /name: "Sales Analytics Demo/,
      /tags: "Marketing · ROI"/,
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
    ],
  },
  {
    name: "Continuous Kafka creation skips the scheduler and keeps stream controls explicit",
    file: "src/App.tsx",
    patterns: [
      /\["source", "schema", "permission", "target", "review"\]/,
      /steps\.filter\(\(step\) => step !== "스케줄"\)/,
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
