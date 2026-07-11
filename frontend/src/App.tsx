import { useEffect, useMemo, useState } from "react";
import type React from "react";
import { BookOpen, CircleHelp, Database, History, LogOut, Settings, ShieldCheck, Workflow } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import asklakeLogo from "./assets/asklake-logo.png";
import { flowTabs, wizardFlows } from "./data/appShellData";
import { Sidebar } from "./components/layout/Sidebar";
import { Topbar } from "./components/layout/Topbar";
import { Stepper } from "./components/layout/Stepper";
import { Footer } from "./components/layout/Footer";
import { CatalogDetailPage, CatalogPage } from "./pages/catalog/CatalogPage";
import { SqlAnalysisPage } from "./pages/sql/SqlAnalysisPage";
import { DashboardPage } from "./pages/dashboard/DashboardPage";
import { ModulePlaceholderPage } from "./pages/ModulePlaceholderPage";
import { JobDetailPage, JobRunsPage, JobsLandingPage } from "./pages/ingest/JobsPages";
import { PermissionPage, ReviewPage, RuleApplicationPage, SchedulePage, SchemaInferencePage, SourceConnectionPage, TargetPage } from "./pages/etl/EtlPages";
import { useAuditLogs } from "./hooks/useAuditLogs";
import { useAskLakeData } from "./hooks/useAskLakeData";
import { Avatar, AvatarFallback } from "./components/ui/avatar";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { IconButton } from "./components/ui/icon-button";
import { Skeleton } from "./components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip";
import type { AuditEntry, AuditTargetType, CatalogDataset, DashboardEntry, FlowId, JobRowData, NavId, NavItem, ScheduleFlowId } from "./types";
import type { DashboardRuntimeMode } from "./types";

type PlaceholderFlow = Extract<FlowId, "ai" | "admin">;
type PlaceholderAction = "requirements" | "status" | "primary";
const scheduleFlows: ScheduleFlowId[] = ["repeat", "manual"];

function isScheduleFlow(flow: FlowId): flow is ScheduleFlowId {
  return scheduleFlows.includes(flow as ScheduleFlowId);
}

const placeholderAuditConfig: Record<PlaceholderFlow, { targetType: AuditTargetType; actions: Record<PlaceholderAction, { action: string; apiPath: string }> }> = {
  ai: {
    targetType: "ai_module",
    actions: {
      requirements: { action: "rag.requirements.opened", apiPath: "/api/rag/requirements" },
      status: { action: "rag.integration.status_recorded", apiPath: "/api/rag/integration-status" },
      primary: { action: "rag.integration.pending", apiPath: "/api/rag/datasets" },
    },
  },
  admin: {
    targetType: "admin_module",
    actions: {
      requirements: { action: "admin.requirements.opened", apiPath: "/api/admin/requirements" },
      status: { action: "admin.integration.status_recorded", apiPath: "/api/admin/integration-status" },
      primary: { action: "admin.integration.pending", apiPath: "/api/audit-logs" },
    },
  },
};

const emptyDatasetId = "dataset_not_selected";
const emptyJobId = "JOB-NONE";

type DashboardRouteState =
  | { dashboardId: string; runtimeMode: DashboardRuntimeMode; view: "runtime" }
  | { view: "list" };

type AppRouteState = {
  dashboardRoute: DashboardRouteState | null;
  datasetId?: string;
  flow: FlowId;
  jobId?: string;
};

type FlowPathContext = {
  dashboardEntry?: DashboardEntry;
  lastScheduleFlow?: ScheduleFlowId;
  selectedDataset?: CatalogDataset;
  selectedJob?: JobRowData;
};

const defaultScheduleFlow: ScheduleFlowId = "repeat";

function parseDashboardRoute(pathname: string): DashboardRouteState | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "dashboards") return null;
  if (segments.length === 1) return { view: "list" };
  if (segments.length === 2) return { dashboardId: decodeURIComponent(segments[1]), runtimeMode: "published", view: "runtime" };
  if (segments.length === 3 && segments[2] === "edit") return { dashboardId: decodeURIComponent(segments[1]), runtimeMode: "draft", view: "runtime" };
  return null;
}

function dashboardEntryFromRoute(route: DashboardRouteState, version: number): DashboardEntry {
  if (route.view === "list") return { source: "sidebar", view: "list", version };
  return {
    dashboardId: route.dashboardId,
    runtimeMode: route.runtimeMode,
    source: "internal",
    view: "runtime",
    version,
  };
}

function getDashboardPath(dashboardId: string, mode: DashboardRuntimeMode) {
  const encodedId = encodeURIComponent(dashboardId);
  return mode === "draft" ? `/dashboards/${encodedId}/edit` : `/dashboards/${encodedId}`;
}

function decodePathSegment(segment?: string) {
  if (!segment) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function encodePathSegment(segment: string) {
  return encodeURIComponent(segment);
}

function parseAppRoute(pathname: string, currentScheduleFlow: ScheduleFlowId = defaultScheduleFlow): AppRouteState {
  const dashboardRoute = parseDashboardRoute(pathname);
  if (dashboardRoute) return { dashboardRoute, flow: "dashboard" };

  const segments = pathname.split("/").filter(Boolean);
  const [area, id, action] = segments;

  if (!area) return { dashboardRoute: null, flow: "jobs" };
  if (area === "jobs") {
    const jobId = decodePathSegment(id);
    if (jobId && action === "runs") return { dashboardRoute: null, flow: "jobRuns", jobId };
    if (jobId) return { dashboardRoute: null, flow: "jobDetail", jobId };
    return { dashboardRoute: null, flow: "jobs" };
  }
  if (area === "etl") {
    if (id === "source") return { dashboardRoute: null, flow: "source" };
    if (id === "schema") return { dashboardRoute: null, flow: "schema" };
    if (id === "rules") return { dashboardRoute: null, flow: "rules" };
    if (id === "schedule") return { dashboardRoute: null, flow: currentScheduleFlow };
    if (id === "permission") return { dashboardRoute: null, flow: "permission" };
    if (id === "target") return { dashboardRoute: null, flow: "target" };
    if (id === "review") return { dashboardRoute: null, flow: "review" };
    return { dashboardRoute: null, flow: "jobs" };
  }
  if (area === "catalog") {
    const datasetId = decodePathSegment(id);
    if (datasetId) return { dashboardRoute: null, datasetId, flow: "catalogDetail" };
    return { dashboardRoute: null, flow: "catalog" };
  }
  if (area === "sql") return { dashboardRoute: null, flow: "sql" };
  if (area === "ai") return { dashboardRoute: null, flow: "ai" };
  if (area === "admin") return { dashboardRoute: null, flow: "admin" };

  return { dashboardRoute: null, flow: "jobs" };
}

function getFlowPath(flow: FlowId, context: FlowPathContext = {}) {
  if (flow === "jobs") return "/jobs";
  if (flow === "jobDetail" && context.selectedJob && context.selectedJob.id !== emptyJobId) return `/jobs/${encodePathSegment(context.selectedJob.id)}`;
  if (flow === "jobRuns" && context.selectedJob && context.selectedJob.id !== emptyJobId) return `/jobs/${encodePathSegment(context.selectedJob.id)}/runs`;
  if (flow === "source") return "/etl/source";
  if (flow === "schema") return "/etl/schema";
  if (flow === "rules") return "/etl/rules";
  if (isScheduleFlow(flow)) return "/etl/schedule";
  if (flow === "permission") return "/etl/permission";
  if (flow === "target") return "/etl/target";
  if (flow === "review") return "/etl/review";
  if (flow === "catalog") return "/catalog";
  if (flow === "catalogDetail" && context.selectedDataset && context.selectedDataset.id !== emptyDatasetId) return `/catalog/${encodePathSegment(context.selectedDataset.id)}`;
  if (flow === "sql") return "/sql";
  if (flow === "dashboard") {
    const entry = context.dashboardEntry;
    if (entry?.view === "runtime" && entry.dashboardId && entry.runtimeMode) return getDashboardPath(entry.dashboardId, entry.runtimeMode);
    return "/dashboards";
  }
  if (flow === "ai") return "/ai";
  if (flow === "admin") return "/admin";
  return "/jobs";
}

function buildMissingJobFromRoute(jobId: string): JobRowData {
  return {
    id: jobId,
    lastRun: "-",
    lastState: "목록에서 찾을 수 없음",
    name: "선택한 Job을 찾을 수 없음",
    nextRun: "-",
    owner: "-",
    schedule: "-",
    source: "-",
    status: "paused",
    tag: "Missing",
    target: "-",
  };
}

function buildMissingDatasetFromRoute(datasetId: string): CatalogDataset {
  return {
    description: "목록에서 찾을 수 없는 데이터셋입니다.",
    downstream: [],
    freshness: "stale",
    id: datasetId,
    lastUpdated: "-",
    layer: "RAW",
    materializationRuns: [],
    name: "선택한 데이터셋을 찾을 수 없음",
    nextRefresh: "-",
    owner: "-",
    quality: "-",
    rag: false,
    rows: "-",
    sampleRows: [],
    schema: [],
    size: "-",
    source: "-",
    status: "approval_required",
    tags: [],
    upstream: [],
  };
}

function hasSelectedDataset(dataset: CatalogDataset, datasets: CatalogDataset[]) {
  return dataset.id !== emptyDatasetId && datasets.some((item) => item.id === dataset.id);
}

function hasSelectedJob(jobId: string, jobs: Array<{ id: string }>) {
  return jobId !== emptyJobId && jobs.some((job) => job.id === jobId);
}

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const initialRoute = parseAppRoute(window.location.pathname, defaultScheduleFlow);
  const [activeFlow, setActiveFlow] = useState<FlowId>(initialRoute.flow);
  const [lastScheduleFlow, setLastScheduleFlow] = useState<ScheduleFlowId>(() => isScheduleFlow(initialRoute.flow) ? initialRoute.flow : defaultScheduleFlow);
  const [dashboardEntry, setDashboardEntry] = useState<DashboardEntry>(() => (
    initialRoute.dashboardRoute ? dashboardEntryFromRoute(initialRoute.dashboardRoute, 0) : { source: "sidebar", view: "list", version: 0 }
  ));
  const [sqlInitialDatasetId, setSqlInitialDatasetId] = useState<string | null>(null);
  const { auditLogs, auditOpen, auditSignal, setAuditOpen, showToast, toast, writeAuditLog } = useAuditLogs();
  const changeFlowFromData = (flow: FlowId) => {
    const nextFlow = flow === "rules" ? lastScheduleFlow : flow;
    const nextScheduleFlow = isScheduleFlow(nextFlow) ? nextFlow : lastScheduleFlow;
    if (isScheduleFlow(nextFlow)) {
      setLastScheduleFlow(nextFlow);
    }
    setActiveFlow(nextFlow);

    const nextPath = getFlowPath(nextFlow, { dashboardEntry, lastScheduleFlow: nextScheduleFlow });
    if (location.pathname !== nextPath) {
      navigate(nextPath);
    }
  };
  const {
    apiPending,
    createPipeline,
    dataError,
    dataLoading,
    deleteMaterializationRun,
    datasets,
    draftPipeline,
    filterJobs,
    handleJobCommand,
    jobExecutionEvidence,
    jobListFacets,
    jobsLoading,
    jobs,
    prepareSqlDatasetJobDraft,
    runsByJobId,
    selectedDataset,
    selectedJob,
    selectedRunIdByJobId,
    selectRunForJob,
    setSelectedDataset,
    setSelectedJob,
    setSqlResultDraft,
    sqlResultDraft,
    updateDraftPipeline,
  } = useAskLakeData({ onFlowChange: changeFlowFromData, showToast, writeAuditLog });
  const current = useMemo(() => flowTabs.find((tab) => tab.id === activeFlow), [activeFlow]);
  const activeNavId = useMemo<NavId>(() => {
    if (activeFlow === "catalog" || activeFlow === "catalogDetail") return "catalog";
    if (activeFlow === "sql") return "sql";
    if (activeFlow === "dashboard") return "dashboard";
    if (activeFlow === "ai") return "ai";
    if (activeFlow === "admin") return "admin";
    return "ingest";
  }, [activeFlow]);
  const hasShellRows = jobs.length > 0 || datasets.length > 0;
  const isIngestShellFlow = activeFlow === "jobs";
  const shouldBlockForInitialData = dataLoading && !hasShellRows && !isIngestShellFlow;
  const shouldBlockForInitialError = !dataLoading && Boolean(dataError) && !hasShellRows && !isIngestShellFlow;
  const pendingMessage = dataLoading ? "DB 데이터 동기화 중..." : "API 요청 처리 중...";
  const selectedDatasetAvailable = hasSelectedDataset(selectedDataset, datasets);
  const selectedJobAvailable = hasSelectedJob(selectedJob.id, jobs);
  const requiresSelectedJob = activeFlow === "jobDetail" || activeFlow === "jobRuns";
  const requiresSelectedDataset = activeFlow === "catalogDetail" || (activeFlow === "dashboard" && dashboardEntry.view === "builder");
  const canRenderActiveFlow = (!requiresSelectedJob || selectedJobAvailable) && (!requiresSelectedDataset || selectedDatasetAvailable);
  const sqlInitialDataset = useMemo(
    () => sqlInitialDatasetId
      ? datasets.find((item) => item.id === sqlInitialDatasetId) ?? (selectedDataset.id === sqlInitialDatasetId ? selectedDataset : null)
      : null,
    [datasets, selectedDataset, sqlInitialDatasetId],
  );
  const shouldRenderAppContent = !shouldBlockForInitialData && !shouldBlockForInitialError && canRenderActiveFlow;
  const wizardStepFlows = useMemo<FlowId[]>(
    () => ["source", "schema", lastScheduleFlow, "permission", "target", "review"],
    [lastScheduleFlow],
  );
  const routeState = useMemo(
    () => parseAppRoute(location.pathname, lastScheduleFlow),
    [lastScheduleFlow, location.pathname],
  );

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 });
  }, [activeFlow, selectedJob?.id]);

  useEffect(() => {
    if (routeState.dashboardRoute) {
      setDashboardEntry((entry) => dashboardEntryFromRoute(routeState.dashboardRoute!, entry.version + 1));
    }
    if (isScheduleFlow(routeState.flow)) {
      setLastScheduleFlow(routeState.flow);
    }
    setActiveFlow((flow) => flow === routeState.flow ? flow : routeState.flow);
  }, [routeState]);

  useEffect(() => {
    if (!routeState.jobId) return;
    const matchedJob = jobs.find((job) => job.id === routeState.jobId);
    const nextJob = matchedJob ?? buildMissingJobFromRoute(routeState.jobId);
    setSelectedJob((job) => (
      job === nextJob || (job.id === nextJob.id && job.name === nextJob.name && job.lastState === nextJob.lastState)
        ? job
        : nextJob
    ));
  }, [jobs, routeState.jobId, setSelectedJob]);

  useEffect(() => {
    if (!routeState.datasetId) return;
    const matchedDataset = datasets.find((dataset) => dataset.id === routeState.datasetId);
    const nextDataset = matchedDataset ?? buildMissingDatasetFromRoute(routeState.datasetId);
    setSelectedDataset((dataset) => (
      dataset === nextDataset || (dataset.id === nextDataset.id && dataset.name === nextDataset.name && dataset.status === nextDataset.status)
        ? dataset
        : nextDataset
    ));
  }, [datasets, routeState.datasetId, setSelectedDataset]);

  const moveToFlow = (flow: FlowId, context: FlowPathContext = {}) => {
    if (flow === "rules") {
      moveToFlow(lastScheduleFlow, context);
      return;
    }
    const nextScheduleFlow = isScheduleFlow(flow) ? flow : lastScheduleFlow;
    if (isScheduleFlow(flow)) {
      setLastScheduleFlow(flow);
    }
    const nextPath = getFlowPath(flow, {
      dashboardEntry: context.dashboardEntry ?? dashboardEntry,
      lastScheduleFlow: nextScheduleFlow,
      selectedDataset: context.selectedDataset ?? selectedDataset,
      selectedJob: context.selectedJob ?? selectedJob,
    });
    if (location.pathname !== nextPath) {
      navigate(nextPath);
    }
    setActiveFlow(flow);
  };

  const navigateWizardStep = (stepIndex: number) => {
    const nextFlow = wizardStepFlows[stepIndex];
    if (!nextFlow || nextFlow === activeFlow) return;
    moveToFlow(nextFlow);
  };

  const saveDraft = (flow: FlowId) => {
    writeAuditLog("etl.job.draft_saved", "/api/etl/jobs", `draft:${flow}`);
    showToast("설정이 임시 저장되었습니다.");
  };

  const navigateSidebar = (item: NavItem) => {
    writeAuditLog("ui.menu.clicked", `/app/${item.id}`, item.label);
    if (item.id === "sql") {
      setSqlInitialDatasetId(null);
      setSqlResultDraft(null);
    }
    if (item.id === "dashboard") {
      const nextDashboardEntry: DashboardEntry = { source: "sidebar", view: "list", version: dashboardEntry.version + 1 };
      setDashboardEntry(nextDashboardEntry);
      moveToFlow(item.flow, { dashboardEntry: nextDashboardEntry });
      return;
    }
    moveToFlow(item.flow);
  };

  const navigateIngestLanding = () => {
    writeAuditLog("ui.brand.clicked", "/app/ingest", "AskLake");
    setDashboardEntry((entry) => ({ source: "sidebar", view: "list", version: entry.version + 1 }));
    moveToFlow("jobs");
  };

  const openDatasetInSqlWithSelection = (dataset: CatalogDataset) => {
    setSqlInitialDatasetId(dataset.id);
    setSelectedDataset(dataset);
    setSqlResultDraft(null);
    writeAuditLog("catalog.open_in_sql.clicked", `/api/catalog/datasets/${dataset.id}/query`, dataset.id, "success", { targetType: "dataset" });
    moveToFlow("sql", { selectedDataset: dataset });
  };

  const navigateDashboardRuntime = (dashboardId: string, mode: DashboardRuntimeMode) => {
    const nextDashboardEntry: DashboardEntry = {
      dashboardId,
      runtimeMode: mode,
      source: "internal",
      view: "runtime",
      version: dashboardEntry.version + 1,
    };
    setDashboardEntry(nextDashboardEntry);
    moveToFlow("dashboard", { dashboardEntry: nextDashboardEntry });
  };

  const openJobDetailWithRoute = (job: JobRowData) => {
    setSelectedJob(job);
    writeAuditLog("etl.job.detail_opened", `/api/etl/jobs/${job.id}`, job.id);
    moveToFlow("jobDetail", { selectedJob: job });
  };

  const openJobRunsWithRoute = (job: JobRowData) => {
    setSelectedJob(job);
    writeAuditLog("etl.job.runs_opened", `/api/etl/jobs/${job.id}/runs`, job.id);
    moveToFlow("jobRuns", { selectedJob: job });
  };

  const recordPlaceholderAction = (flow: PlaceholderFlow, actionType: PlaceholderAction) => {
    const config = placeholderAuditConfig[flow];
    const { action, apiPath } = config.actions[actionType];
    writeAuditLog(action, apiPath, flow, "success", { targetType: config.targetType });
  };

  if (activeFlow === "rules") {
    return (
      <RuleBuilderShell
        auditOpen={auditOpen}
        auditLogs={auditLogs}
        auditCount={auditLogs.length}
        onAccount={() => writeAuditLog("ui.account_opened", "/app/account", "demo.user@asklake.local", "success", { targetType: "ui" })}
        onAuditToggle={() => setAuditOpen((open) => !open)}
        onDocs={() => {
          writeAuditLog("etl.builder.docs_opened", "/docs/etl-builder", "rule-application", "success", { targetType: "ui" });
          showToast("ETL Builder 도움말을 확인할 수 있도록 기록했습니다.", "info");
        }}
        onLogout={() => {
          writeAuditLog("ui.logout_requested", "/app/logout", "demo.user@asklake.local", "success", { targetType: "ui" });
          showToast("데모 환경에서는 로그아웃 요청만 기록됩니다.", "info");
        }}
        onBrandClick={navigateIngestLanding}
        onNavigate={(flow, label) => {
          writeAuditLog("ui.builder_menu.clicked", `/app/${flow}`, label);
          moveToFlow(flow);
        }}
        onRefresh={() => writeAuditLog("etl.job.status_refreshed", "/api/etl/jobs/customer_review_gold", "customer_review_gold")}
      >
        {toast && <div className={`app-toast ${toast.tone}`}>{toast.message}</div>}
        {apiPending && <div className="app-api-pending">API 요청 처리 중...</div>}
        <RuleApplicationPage draft={draftPipeline} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow("schema")} onNext={() => moveToFlow(lastScheduleFlow)} onSave={() => saveDraft("rules")} onAction={writeAuditLog} onNotify={showToast} />
      </RuleBuilderShell>
    );
  }

  return (
    <div className="app-shell" data-last-action={auditSignal}>
      <Sidebar
        activeNavId={activeNavId}
        canAccessAdmin
        onAccount={() => writeAuditLog("ui.account_opened", "/app/account", "demo.user@asklake.local", "success", { targetType: "ui" })}
        onBrandClick={navigateIngestLanding}
        onNavigate={navigateSidebar}
      />
      <main className={activeFlow === "schema" ? "main-shell schema-shell" : "main-shell"}>
        <Topbar auditLogs={auditLogs} auditOpen={auditOpen} onAuditToggle={() => setAuditOpen((open) => !open)} onRefresh={() => writeAuditLog("etl.job.status_refreshed", "/api/etl/jobs", "jobs")} />
        {toast && <div className={`app-toast ${toast.tone}`}>{toast.message}</div>}
        {(apiPending || (dataLoading && (hasShellRows || isIngestShellFlow))) && <div className="app-api-pending">{pendingMessage}</div>}
        {wizardFlows.includes(activeFlow) && <Stepper activeIndex={current?.stepIndex ?? 0} onStepSelect={navigateWizardStep} />}
        <section className={activeFlow === "jobs" ? "page-body jobs-body" : activeFlow === "schema" ? "page-body schema-body" : activeFlow === "sql" ? "page-body sql-body" : "page-body"}>
          {shouldBlockForInitialData && (
            <div aria-label="데이터를 불러오는 중" className="module-placeholder-page" role="status">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-9 w-full max-w-md" />
              <Skeleton className="h-5 w-full max-w-xl" />
            </div>
          )}
          {shouldBlockForInitialError && (
            <Alert className="mx-auto max-w-3xl border-red-200 bg-red-50 text-red-800" variant="destructive">
              <CircleHelp />
              <AlertTitle>DB API 연결을 확인해 주세요.</AlertTitle>
              <AlertDescription>{dataError}</AlertDescription>
            </Alert>
          )}
          {!dataLoading && !dataError && !canRenderActiveFlow && (
            <div className="module-placeholder-page">
              <span>EMPTY STATE</span>
              <h1>먼저 실제 데이터를 선택해주세요</h1>
              <p>목록에서 Job 또는 Dataset을 선택하거나, 새 파이프라인을 생성하고 실행해 주세요.</p>
            </div>
          )}
          {shouldRenderAppContent && (
            <>
          {activeFlow === "jobs" && <JobsLandingPage jobListFacets={jobListFacets} jobsLoading={jobsLoading} jobs={jobs} onCommand={handleJobCommand} onCreate={() => moveToFlow("source")} onDetail={openJobDetailWithRoute} onFilter={filterJobs} onRuns={openJobRunsWithRoute} onAction={writeAuditLog} />}
          {activeFlow === "jobDetail" && <JobDetailPage job={selectedJob} onCommand={handleJobCommand} onBack={() => moveToFlow("jobs")} onRuns={() => openJobRunsWithRoute(selectedJob)} />}
          {activeFlow === "jobRuns" && <JobRunsPage evidence={jobExecutionEvidence[selectedJob.id]} job={selectedJob} onCommand={handleJobCommand} onBack={() => moveToFlow("jobDetail")} onAction={writeAuditLog} />}
          {activeFlow === "source" && <SourceConnectionPage draft={draftPipeline} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow("jobs")} onNext={() => moveToFlow("schema")} onSave={() => saveDraft("source")} onAction={writeAuditLog} onNotify={showToast} />}
          {activeFlow === "schema" && <SchemaInferencePage draft={draftPipeline} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow("source")} onNext={() => moveToFlow(lastScheduleFlow)} onSave={() => saveDraft("schema")} onAction={writeAuditLog} onNotify={showToast} />}
          {isScheduleFlow(activeFlow) && <SchedulePage draftSchedule={draftPipeline.schedule} mode={activeFlow} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow("schema")} onModeChange={moveToFlow} onNext={() => moveToFlow("permission")} onSave={() => saveDraft(activeFlow)} />}
          {activeFlow === "target" && <TargetPage draft={draftPipeline} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow("permission")} onNext={() => moveToFlow("review")} onSave={() => saveDraft("target")} />}
          {activeFlow === "permission" && <PermissionPage draft={draftPipeline} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow(lastScheduleFlow)} onNext={() => moveToFlow("target")} onSave={() => saveDraft("permission")} />}
          {activeFlow === "review" && <ReviewPage createPending={apiPending} draft={draftPipeline} onEdit={moveToFlow} onSave={() => saveDraft("review")} onCreate={createPipeline} />}
          {activeFlow === "catalog" && <CatalogPage datasets={datasets} error={dataError} loading={dataLoading} selectedDataset={selectedDataset} onAction={writeAuditLog} onMaterializationRunDelete={deleteMaterializationRun} onOpenSql={openDatasetInSqlWithSelection} />}
          {activeFlow === "catalogDetail" && <CatalogDetailPage dataset={selectedDataset} onAction={writeAuditLog} onBack={() => moveToFlow("catalog")} onLineage={() => writeAuditLog("catalog.lineage.opened", `/api/catalog/datasets/${selectedDataset.id}/lineage`, selectedDataset.id)} onOpenSql={() => openDatasetInSqlWithSelection(selectedDataset)} />}
          {activeFlow === "sql" && <SqlAnalysisPage cachedResult={sqlResultDraft} dataset={sqlInitialDataset} datasets={datasets} onAction={writeAuditLog} onPrepareDatasetJob={prepareSqlDatasetJobDraft} onResultChange={setSqlResultDraft} />}
          {activeFlow === "dashboard" && <DashboardPage dataset={selectedDataset} datasets={datasets} entry={dashboardEntry} sqlResult={sqlResultDraft} onAction={writeAuditLog} onRuntimeNavigate={navigateDashboardRuntime} />}
          {activeFlow === "ai" && <ModulePlaceholderPage flow="ai" title="AI 활용" owner="확장 예정" description="Lake 데이터를 RAG 데이터셋으로 만들고 권한 기반 자연어 질의를 제공하는 영역입니다." onRequirements={() => recordPlaceholderAction("ai", "requirements")} onStatusRecord={() => recordPlaceholderAction("ai", "status")} onPrimary={() => recordPlaceholderAction("ai", "primary")} />}
          {activeFlow === "admin" && <ModulePlaceholderPage flow="admin" title="관리" owner="확장 예정" description="사용자, 그룹, API 권한과 감사 로그를 관리하는 운영 영역입니다." onRequirements={() => recordPlaceholderAction("admin", "requirements")} onStatusRecord={() => recordPlaceholderAction("admin", "status")} onPrimary={() => recordPlaceholderAction("admin", "primary")} />}
            </>
          )}
        </section>
        <Footer />
      </main>
    </div>
  );
}

function RuleBuilderShell({
  auditCount,
  auditLogs,
  auditOpen,
  children,
  onAccount,
  onAuditToggle,
  onBrandClick,
  onDocs,
  onLogout,
  onNavigate,
  onRefresh,
}: {
  auditCount: number;
  auditLogs: AuditEntry[];
  auditOpen: boolean;
  children: React.ReactNode;
  onAccount: () => void;
  onAuditToggle: () => void;
  onBrandClick: () => void;
  onDocs: () => void;
  onLogout: () => void;
  onNavigate: (flow: FlowId, label: string) => void;
  onRefresh: () => void;
}) {
  const workspaceItems = [
    { icon: Workflow, label: "파이프라인", flow: "jobs" as FlowId },
    { icon: Database, label: "데이터셋", flow: "catalog" as FlowId },
    { icon: History, label: "실행 이력", flow: "jobRuns" as FlowId },
  ];
  const managementItems = [
    { icon: ShieldCheck, label: "거버넌스", flow: "permission" as FlowId },
    { icon: Settings, label: "설정", flow: "admin" as FlowId },
  ];
  const stepItems = [
    ["1", "소스 연결"],
    ["2", "스키마 추론"],
    ["3", "규칙 적용"],
  ];

  return (
    <div className="etl-builder-shell" data-audit-open={auditOpen}>
      <header className="etl-builder-header">
        <button className="etl-builder-brand" type="button" aria-label="수집/처리 랜딩 페이지로 이동" onClick={onBrandClick}>
          <img src={asklakeLogo} alt="AskLake" />
        </button>
        <nav className="etl-builder-stepper" aria-label="데이터셋 생성 단계">
          {stepItems.map(([index, label], itemIndex) => (
            <span className={index === "3" ? "etl-builder-step active" : "etl-builder-step"} key={index}>
              <span>{index}</span>
              {label}
              {itemIndex < stepItems.length - 1 && <i aria-hidden="true">›</i>}
            </span>
          ))}
        </nav>
        <TooltipProvider delayDuration={300}>
        <div className="etl-builder-header-actions">
          <div className="audit-menu">
            <Tooltip>
              <TooltipTrigger asChild>
                <IconButton className={auditOpen ? "icon-button active" : "icon-button"} label="최근 API 호출" size="sm" type="button" onClick={onAuditToggle}>
                  <CircleHelp />
                  {auditCount > 0 && <span className="audit-dot" />}
                </IconButton>
              </TooltipTrigger>
              <TooltipContent>최근 API 호출</TooltipContent>
            </Tooltip>
            {auditOpen && (
              <section className="audit-popover">
                <div className="audit-popover-header">
                  <strong>최근 API 호출</strong>
                  <span>{auditLogs.length}건</span>
                </div>
                <div className="audit-log-list">
                  {auditLogs.slice(0, 8).map((log) => (
                    <article className="audit-log-item" key={log.request_id}>
                      <div>
                        <strong>{log.action}</strong>
                        <span>{log.api_path}</span>
                      </div>
                      <em>{log.result}</em>
                    </article>
                  ))}
                  {auditLogs.length === 0 && <p>아직 기록된 호출이 없습니다.</p>}
                </div>
              </section>
            )}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton className="icon-button" label="문서" size="sm" type="button" onClick={onDocs}><BookOpen /></IconButton>
            </TooltipTrigger>
            <TooltipContent>문서</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton className="icon-button" label="새로고침" size="sm" type="button" onClick={onRefresh}><History /></IconButton>
            </TooltipTrigger>
            <TooltipContent>새로고침</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton className="p-0" label="계정" size="sm" type="button" onClick={onAccount}>
                <Avatar><AvatarFallback>AL</AvatarFallback></Avatar>
              </IconButton>
            </TooltipTrigger>
            <TooltipContent>계정</TooltipContent>
          </Tooltip>
        </div>
        </TooltipProvider>
      </header>
      <aside className="etl-builder-sidebar">
        <div>
          <p className="etl-builder-nav-heading">작업 공간</p>
          <nav className="etl-builder-nav">
            {workspaceItems.map(({ flow, icon: Icon, label }) => (
              <button key={label} type="button" onClick={() => onNavigate(flow, label)}>
                <Icon size={17} />
                {label}
              </button>
            ))}
          </nav>
          <p className="etl-builder-nav-heading">관리</p>
          <nav className="etl-builder-nav">
            {managementItems.map(({ flow, icon: Icon, label }) => (
              <button key={label} type="button" onClick={() => onNavigate(flow, label)}>
                <Icon size={17} />
                {label}
              </button>
            ))}
          </nav>
        </div>
        <div className="etl-builder-sidebar-foot">
          <button type="button" onClick={onLogout}>
            <LogOut size={16} />
            로그아웃
          </button>
          <span><i /> 시스템 정상</span>
          <span>버전 2.4.0-stable</span>
        </div>
      </aside>
      <main className="etl-builder-main">
        {children}
        <footer className="etl-builder-footer">© 2024 AskLake ETL Builder. All rights reserved.</footer>
      </main>
    </div>
  );
}
