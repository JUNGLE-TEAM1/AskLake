import { useEffect, useMemo, useState } from "react";
import { CircleHelp } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { wizardFlows } from "./data/appShellData";
import { Sidebar } from "./components/layout/Sidebar";
import { Topbar } from "./components/layout/Topbar";
import { Stepper } from "./components/layout/Stepper";
import { CatalogDetailPage, CatalogPage, type CatalogView } from "./pages/catalog/CatalogPage";
import { SqlAnalysisPage } from "./pages/sql/SqlAnalysisPage";
import { DashboardPage } from "./pages/dashboard/DashboardPage";
import { AdminConsolePage } from "./pages/admin/AdminConsolePage";
import { AuthPage } from "./pages/auth/AuthPage";
import { ProfilePage } from "./pages/profile/ProfilePage";
import { JobDetailPage } from "./pages/ingest/jobs/JobDetailPage";
import { JobRunsPage } from "./pages/ingest/jobs/JobRunsPage";
import { JobsLandingPage } from "./pages/ingest/jobs/JobsLandingPage";
import { PermissionPage } from "./pages/etl/PermissionPage";
import { RecordParsingPage } from "./pages/etl/RecordParsingPage";
import { ReviewPage } from "./pages/etl/ReviewPage";
import { RuleApplicationPage } from "./pages/etl/RuleApplicationPage";
import { SchedulePage } from "./pages/etl/SchedulePage";
import { SchemaInferencePage } from "./pages/etl/SchemaInferencePage";
import { SourceConnectionPage } from "./pages/etl/SourceConnectionPage";
import { TargetPage } from "./pages/etl/TargetPage";
import { buildEtlWizardSteps, etlFlowFromRoute, etlFlowPath, etlStyleRoute } from "./pages/etl/stepRegistry";
import { useAuditLogs } from "./hooks/useAuditLogs";
import { useAskLakeWorkspace } from "./state/asklake/useAskLakeWorkspace";
import { useJobRouteHydration } from "./state/asklake/useJobRouteHydration";
import { fetchAuthSession, logout as logoutSession } from "./services/authApi";
import { canNavigateToWizardStep } from "./utils/wizardNavigation";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { Skeleton } from "./components/ui/skeleton";
import type { CatalogDataset, CurrentUserResponse, DashboardEntry, DraftPipeline, FlowId, JobRowData, NavId, NavItem, ScheduleFlowId } from "./types";
import type { DashboardRuntimeMode } from "./types";

const scheduleFlows: ScheduleFlowId[] = ["repeat", "manual"];
const editableWizardFlows: FlowId[] = ["source", "recordParsing", "schema", "repeat", "manual", "permission", "target"];

function isScheduleFlow(flow: FlowId): flow is ScheduleFlowId {
  return scheduleFlows.includes(flow as ScheduleFlowId);
}

function isContinuousKafkaDraft(draft: DraftPipeline) {
  return draft.source.executionMode === "continuous"
    && ["Stream / Kafka", "Kafka JSON"].includes(draft.source.sourceType);
}
const emptyDatasetId = "dataset_not_selected";
const emptyJobId = "JOB-NONE";

type DashboardRouteState =
  | { dashboardId: string; runtimeMode: DashboardRuntimeMode; view: "runtime" }
  | { view: "list" };

type AppRouteState = {
  catalogView?: CatalogView;
  dashboardRoute: DashboardRouteState | null;
  datasetId?: string;
  flow: FlowId;
  jobId?: string;
  unknownPath?: string;
};

type FlowPathContext = {
  dashboardEntry?: DashboardEntry;
  catalogView?: CatalogView;
  lastScheduleFlow?: ScheduleFlowId;
  selectedDataset?: CatalogDataset;
  selectedJob?: JobRowData;
};

const defaultScheduleFlow: ScheduleFlowId = "repeat";

function parseDashboardRoute(pathname: string): DashboardRouteState | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "dashboards") return null;
  if (segments.length === 1) return { view: "list" };
  const dashboardId = decodePathSegment(segments[1]);
  if (!dashboardId) return null;
  if (segments.length === 2) return { dashboardId, runtimeMode: "published", view: "runtime" };
  if (segments.length === 3 && segments[2] === "edit") return { dashboardId, runtimeMode: "draft", view: "runtime" };
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

function parseCatalogView(search: string): CatalogView {
  return new URLSearchParams(search).get("view") === "semantic" ? "semantic" : "catalog";
}

function parseAppRoute(pathname: string, currentScheduleFlow: ScheduleFlowId = defaultScheduleFlow, search = ""): AppRouteState {
  const dashboardRoute = parseDashboardRoute(pathname);
  if (dashboardRoute) return { dashboardRoute, flow: "dashboard" };

  const segments = pathname.split("/").filter(Boolean);
  const [area, id, action] = segments;

  if (!area) return { dashboardRoute: null, flow: "jobs" };
  if (area === "dashboards") return { dashboardRoute: null, flow: "jobs", unknownPath: pathname };
  if (area === "jobs") {
    const jobId = decodePathSegment(id);
    if (jobId && action === "runs") return { dashboardRoute: null, flow: "jobRuns", jobId };
    if (jobId) return { dashboardRoute: null, flow: "jobDetail", jobId };
    return { dashboardRoute: null, flow: "jobs", unknownPath: pathname };
  }
  if (area === "etl") {
    const etlFlow = etlFlowFromRoute(id, action, segments.length, currentScheduleFlow);
    if (etlFlow) return { dashboardRoute: null, flow: etlFlow };
    return { dashboardRoute: null, flow: "jobs", unknownPath: pathname };
  }
  if (area === "catalog") {
    const datasetId = decodePathSegment(id);
    if (datasetId) return { dashboardRoute: null, datasetId, flow: "catalogDetail" };
    return { catalogView: parseCatalogView(search), dashboardRoute: null, flow: "catalog" };
  }
  if (area === "sql") return { dashboardRoute: null, flow: "sql" };
  if (area === "semantic-layer") return { catalogView: "semantic", dashboardRoute: null, flow: "catalog" };
  if (area === "admin") return { dashboardRoute: null, flow: "admin" };
  if (area === "profile") return { dashboardRoute: null, flow: "profile" };
  if (area === "login") return { dashboardRoute: null, flow: "login" };

  return { dashboardRoute: null, flow: "jobs", unknownPath: pathname };
}

function getFlowPath(flow: FlowId, context: FlowPathContext = {}) {
  if (flow === "jobs") return "/jobs";
  if (flow === "jobDetail" && context.selectedJob && context.selectedJob.id !== emptyJobId) return `/jobs/${encodePathSegment(context.selectedJob.id)}`;
  if (flow === "jobRuns" && context.selectedJob && context.selectedJob.id !== emptyJobId) return `/jobs/${encodePathSegment(context.selectedJob.id)}/runs`;
  const etlPath = etlFlowPath(flow);
  if (etlPath) return etlPath;
  if (flow === "catalog") return "/catalog";
  if (flow === "catalogDetail" && context.selectedDataset && context.selectedDataset.id !== emptyDatasetId) return `/catalog/${encodePathSegment(context.selectedDataset.id)}`;
  if (flow === "sql") return "/sql";
  if (flow === "dashboard") {
    const entry = context.dashboardEntry;
    if (entry?.view === "runtime" && entry.dashboardId && entry.runtimeMode) return getDashboardPath(entry.dashboardId, entry.runtimeMode);
    return "/dashboards";
  }
  if (flow === "semantic") return "/semantic-layer";
  if (flow === "admin") return "/admin";
  if (flow === "profile") return "/profile";
  if (flow === "login") return "/login";
  return "/jobs";
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
  const initialRoute = parseAppRoute(window.location.pathname, defaultScheduleFlow, window.location.search);
  const [activeFlow, setActiveFlow] = useState<FlowId>(initialRoute.flow);
  const [completedWizardFlows, setCompletedWizardFlows] = useState<Set<FlowId>>(() => new Set());
  const [currentUser, setCurrentUser] = useState<CurrentUserResponse | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const [lastScheduleFlow, setLastScheduleFlow] = useState<ScheduleFlowId>(() => isScheduleFlow(initialRoute.flow) ? initialRoute.flow : defaultScheduleFlow);
  const [dashboardEntry, setDashboardEntry] = useState<DashboardEntry>(() => (
    initialRoute.dashboardRoute ? dashboardEntryFromRoute(initialRoute.dashboardRoute, 0) : { source: "sidebar", view: "list", version: 0 }
  ));
  const [sqlInitialDatasetId, setSqlInitialDatasetId] = useState<string | null>(null);
  const { auditSignal, showToast, toast, writeAuditLog } = useAuditLogs(currentUser?.email);
  const changeFlowFromData = (flow: FlowId) => {
    const nextFlow = flow === "rules" ? lastScheduleFlow : flow;
    const nextScheduleFlow = isScheduleFlow(nextFlow) ? nextFlow : lastScheduleFlow;
    if (isScheduleFlow(nextFlow)) {
      setLastScheduleFlow(nextFlow);
    }
    if (nextFlow === "source") {
      setCompletedWizardFlows(new Set(editableWizardFlows));
    }
    setActiveFlow(nextFlow);

    const nextPath = getFlowPath(nextFlow, { dashboardEntry, lastScheduleFlow: nextScheduleFlow });
    if (location.pathname !== nextPath) {
      navigate(nextPath);
    }
  };
  const {
    apiPending,
    catalogError,
    catalogLoading,
    createPipeline,
    dataRequirements,
    deleteMaterializationRun,
    datasets,
    draftPipeline,
    filterJobs,
    handleJobCommand,
    jobExecutionEvidence,
    jobListFacets,
    jobsError,
    jobsLoading,
    jobs,
    createSqlDatasetJob,
    createTrinoSqlJob,
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
  } = useAskLakeWorkspace({ activeFlow, enabled: Boolean(currentUser), onFlowChange: changeFlowFromData, showToast, writeAuditLog });
  const canAccessAdmin = currentUser?.role?.toLowerCase() === "admin";
  const activeNavId = useMemo<NavId | null>(() => {
    if (activeFlow === "catalog" || activeFlow === "catalogDetail") return "catalog";
    if (activeFlow === "sql") return "sql";
    if (activeFlow === "dashboard") return "dashboard";
    if (activeFlow === "semantic") return "semantic";
    if (activeFlow === "admin") return canAccessAdmin ? "admin" : null;
    if (activeFlow === "profile" || activeFlow === "login") return null;
    return "ingest";
  }, [activeFlow, canAccessAdmin]);
  const activeDataLoading = dataRequirements.jobs ? jobsLoading : dataRequirements.catalog ? catalogLoading : false;
  const activeDataError = dataRequirements.jobs ? jobsError : dataRequirements.catalog ? catalogError : null;
  const activeDataHasRows = dataRequirements.jobs ? jobs.length > 0 : dataRequirements.catalog ? datasets.length > 0 : true;
  const shouldBlockForInitialData = activeDataLoading && !activeDataHasRows;
  const shouldBlockForInitialError = !activeDataLoading && Boolean(activeDataError) && !activeDataHasRows;
  const pendingMessage = activeDataLoading ? "현재 화면의 데이터를 불러오는 중..." : "API 요청 처리 중...";
  const selectedDatasetAvailable = hasSelectedDataset(selectedDataset, datasets);
  const selectedJobAvailable = hasSelectedJob(selectedJob.id, jobs);
  const selectedJobCatalogDataset = datasets.find((dataset) => dataset.name === selectedJob.target);
  const requiresSelectedJob = activeFlow === "jobDetail" || activeFlow === "jobRuns";
  const requiresSelectedDataset = activeFlow === "catalogDetail" || (activeFlow === "dashboard" && dashboardEntry.view === "builder");
  const canRenderActiveFlow = (!requiresSelectedJob || selectedJobAvailable) && (!requiresSelectedDataset || selectedDatasetAvailable);
  const sqlInitialDataset = useMemo(
    () => sqlInitialDatasetId
      ? datasets.find((item) => item.id === sqlInitialDatasetId) ?? (selectedDataset.id === sqlInitialDatasetId ? selectedDataset : null)
      : null,
    [datasets, selectedDataset, sqlInitialDatasetId],
  );
  const continuousKafkaDraft = isContinuousKafkaDraft(draftPipeline);
  const requiresRecordParsing = Boolean(draftPipeline.source.requiresRecordParsing);
  const isIndependentFlow = activeFlow === "admin" || activeFlow === "profile";
  const shouldRenderAppContent = isIndependentFlow || (!shouldBlockForInitialData && !shouldBlockForInitialError && canRenderActiveFlow);
  const wizardSteps = useMemo(
    () => buildEtlWizardSteps({ continuousKafka: continuousKafkaDraft, requiresRecordParsing, scheduleFlow: lastScheduleFlow }),
    [continuousKafkaDraft, lastScheduleFlow, requiresRecordParsing],
  );
  const wizardStepFlows = useMemo<FlowId[]>(() => wizardSteps.map(({ flow }) => flow), [wizardSteps]);
  const wizardStepLabels = useMemo(() => wizardSteps.map(({ label }) => label), [wizardSteps]);
  const wizardActiveIndex = Math.max(0, wizardStepFlows.indexOf(activeFlow));
  const wizardStepDisabled = useMemo(
    () => wizardStepFlows.map((_, targetIndex) => !canNavigateToWizardStep({
      activeIndex: wizardActiveIndex,
      completedFlows: completedWizardFlows,
      stepFlows: wizardStepFlows,
      targetIndex,
    })),
    [completedWizardFlows, wizardActiveIndex, wizardStepFlows],
  );
  const routeState = useMemo(
    () => parseAppRoute(location.pathname, lastScheduleFlow, location.search),
    [lastScheduleFlow, location.pathname, location.search],
  );
  useJobRouteHydration({
    flow: routeState.flow,
    jobId: routeState.jobId,
    jobs,
    setSelectedJob,
  });

  const changeCatalogView = (view: CatalogView) => {
    const nextPath = view === "semantic" ? "/catalog?view=semantic" : "/catalog";
    writeAuditLog("catalog.view_changed", nextPath, view);
    setActiveFlow("catalog");
    if (`${location.pathname}${location.search}` !== nextPath) navigate(nextPath);
  };

  useEffect(() => {
    if (location.pathname !== "/semantic-layer") return;
    navigate("/catalog?view=semantic", { replace: true });
  }, [location.pathname, navigate]);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 });
  }, [activeFlow, selectedJob?.id]);

  useEffect(() => {
    let active = true;
    fetchAuthSession()
      .then((session) => {
        if (active) setCurrentUser(session.user);
      })
      .catch(() => {
        if (active) setCurrentUser(null);
      })
      .finally(() => {
        if (active) setAuthChecked(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!authChecked || currentUser || activeFlow === "login") return;
    navigate("/login", { replace: true });
    setActiveFlow("login");
  }, [activeFlow, authChecked, currentUser, navigate]);

  useEffect(() => {
    if (!authChecked || !currentUser || activeFlow !== "login") return;
    navigate("/jobs", { replace: true });
    setActiveFlow("jobs");
  }, [activeFlow, authChecked, currentUser, navigate]);

  useEffect(() => {
    if (!authChecked || !currentUser || activeFlow !== "admin" || canAccessAdmin) return;
    navigate("/profile", { replace: true });
    showToast("관리 메뉴는 운영자 계정에서만 사용할 수 있습니다.", "info");
    setActiveFlow("profile");
  }, [activeFlow, authChecked, canAccessAdmin, currentUser, navigate, showToast]);

  useEffect(() => {
    if (routeState.unknownPath) {
      if (location.pathname !== "/jobs") navigate("/jobs", { replace: true });
      setActiveFlow("jobs");
      return;
    }
    if (routeState.dashboardRoute) {
      setDashboardEntry((entry) => dashboardEntryFromRoute(routeState.dashboardRoute!, entry.version + 1));
    }
    if (isScheduleFlow(routeState.flow)) {
      setLastScheduleFlow(routeState.flow);
    }
    setActiveFlow((flow) => flow === routeState.flow ? flow : routeState.flow);
  }, [routeState]);

  useEffect(() => {
    if (!continuousKafkaDraft || !isScheduleFlow(activeFlow)) return;
    const nextPath = getFlowPath("permission");
    navigate(nextPath, { replace: true });
    setActiveFlow("permission");
  }, [activeFlow, continuousKafkaDraft, navigate]);

  useEffect(() => {
    if (activeFlow !== "recordParsing" || requiresRecordParsing) return;
    navigate(getFlowPath("schema"), { replace: true });
    setActiveFlow("schema");
  }, [activeFlow, navigate, requiresRecordParsing]);

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
      moveToFlow(continuousKafkaDraft ? "permission" : lastScheduleFlow, context);
      return;
    }
    const resolvedFlow = continuousKafkaDraft && isScheduleFlow(flow) ? "permission" : flow;
    const nextScheduleFlow = isScheduleFlow(resolvedFlow) ? resolvedFlow : lastScheduleFlow;
    if (isScheduleFlow(resolvedFlow)) {
      setLastScheduleFlow(resolvedFlow);
    }
    const nextPath = getFlowPath(resolvedFlow, {
      dashboardEntry: context.dashboardEntry ?? dashboardEntry,
      lastScheduleFlow: nextScheduleFlow,
      selectedDataset: context.selectedDataset ?? selectedDataset,
      selectedJob: context.selectedJob ?? selectedJob,
    });
    if (location.pathname !== nextPath) {
      navigate(nextPath);
    }
    setActiveFlow(resolvedFlow);
  };

  const navigateWizardStep = (stepIndex: number) => {
    const nextFlow = wizardStepFlows[stepIndex];
    if (!nextFlow || nextFlow === activeFlow || wizardStepDisabled[stepIndex]) return;
    moveToFlow(nextFlow);
  };

  const completeWizardFlowAndMove = (completedFlow: FlowId, nextFlow: FlowId) => {
    setCompletedWizardFlows((current) => {
      const next = new Set(current);
      next.add(completedFlow);
      return next;
    });
    moveToFlow(nextFlow);
  };

  const startNewPipeline = () => {
    setCompletedWizardFlows(new Set());
    moveToFlow("source");
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

  const openProfilePage = () => {
    if (!currentUser) {
      moveToFlow("login");
      return;
    }
    writeAuditLog("ui.account_opened", "/api/users/me", currentUser.email, "success", { targetType: "ui" });
    moveToFlow("profile");
  };

  const handleLogout = async () => {
    if (logoutPending) return;
    setLogoutPending(true);
    try {
      await logoutSession();
      setCurrentUser(null);
      navigate("/login", { replace: true });
      setActiveFlow("login");
    } catch {
      showToast("로그아웃에 실패했습니다. 잠시 후 다시 시도해 주세요.", "info");
    } finally {
      setLogoutPending(false);
    }
  };

  const handleAuthenticated = (user: CurrentUserResponse) => {
    setCurrentUser(user);
    showToast(`${user.profile.displayName || user.displayName} 계정으로 로그인했습니다.`, "success");
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

  if (!authChecked && activeFlow !== "login") {
    return <div className="workspace-route-loading" role="status">로그인 상태를 확인하는 중...</div>;
  }

  if (!currentUser || activeFlow === "login") {
    return <AuthPage onAction={writeAuditLog} onAuthenticated={handleAuthenticated} />;
  }

  return (
    <div className="app-shell" data-last-action={auditSignal}>
      <Sidebar
        activeNavId={activeNavId}
        canAccessAdmin={canAccessAdmin}
        currentUser={currentUser}
        logoutPending={logoutPending}
        onAccount={openProfilePage}
        onBrandClick={navigateIngestLanding}
        onLogout={handleLogout}
        onNavigate={navigateSidebar}
      />
      <main className={activeFlow === "schema" ? "main-shell schema-shell" : "main-shell"}>
        <Topbar />
        {toast && <div className={`app-toast ${toast.tone}`}>{toast.message}</div>}
        {(apiPending || (activeDataLoading && activeDataHasRows)) && <div className="app-api-pending">{pendingMessage}</div>}
        {wizardFlows.includes(activeFlow) && <Stepper activeIndex={wizardActiveIndex} isStepDisabled={(stepIndex) => wizardStepDisabled[stepIndex] ?? true} steps={wizardStepLabels} onStepSelect={navigateWizardStep} />}
        <section className={activeFlow === "jobs" ? "page-body jobs-body" : activeFlow === "schema" ? "page-body schema-body" : activeFlow === "sql" ? "page-body sql-body" : "page-body"} data-etl-route={etlStyleRoute(activeFlow) ?? undefined}>
          {!isIndependentFlow && shouldBlockForInitialData && (
            <div aria-label="데이터를 불러오는 중" className="module-placeholder-page" role="status">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-9 w-full max-w-md" />
              <Skeleton className="h-5 w-full max-w-xl" />
            </div>
          )}
          {!isIndependentFlow && shouldBlockForInitialError && (
            <Alert className="mx-auto max-w-3xl border-red-200 bg-red-50 text-red-800" variant="destructive">
              <CircleHelp />
              <AlertTitle>DB API 연결을 확인해 주세요.</AlertTitle>
              <AlertDescription>{activeDataError}</AlertDescription>
            </Alert>
          )}
          {!activeDataLoading && !activeDataError && !canRenderActiveFlow && (
            <div className="module-placeholder-page">
              <span>EMPTY STATE</span>
              <h1>먼저 실제 데이터를 선택해주세요</h1>
              <p>목록에서 Job 또는 Dataset을 선택하거나, 새 파이프라인을 생성하고 실행해 주세요.</p>
            </div>
          )}
          {shouldRenderAppContent && (
            <>
          {activeFlow === "jobs" && <JobsLandingPage jobListFacets={jobListFacets} jobsLoading={jobsLoading} jobs={jobs} onCommand={handleJobCommand} onCreate={startNewPipeline} onDetail={openJobDetailWithRoute} onFilter={filterJobs} onAction={writeAuditLog} />}
          {activeFlow === "jobDetail" && <JobDetailPage job={selectedJob} onCommand={handleJobCommand} onBack={() => moveToFlow("jobs")} onRuns={() => openJobRunsWithRoute(selectedJob)} />}
          {activeFlow === "jobRuns" && <JobRunsPage catalogDatasetId={selectedJobCatalogDataset?.id} catalogRowCount={selectedJobCatalogDataset?.rows} evidence={jobExecutionEvidence[selectedJob.id]} job={selectedJob} onCommand={handleJobCommand} onBack={() => moveToFlow("jobDetail")} onAction={writeAuditLog} />}
          {activeFlow === "source" && <SourceConnectionPage draft={draftPipeline} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow("jobs")} onNext={() => completeWizardFlowAndMove("source", requiresRecordParsing ? "recordParsing" : "schema")} onSave={() => saveDraft("source")} onAction={writeAuditLog} onNotify={showToast} />}
          {activeFlow === "recordParsing" && <RecordParsingPage draft={draftPipeline} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow("source")} onNext={() => completeWizardFlowAndMove("recordParsing", "schema")} onAction={writeAuditLog} onNotify={showToast} />}
          {activeFlow === "schema" && <SchemaInferencePage draft={draftPipeline} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow(requiresRecordParsing ? "recordParsing" : "source")} onNext={() => completeWizardFlowAndMove("schema", continuousKafkaDraft ? "permission" : lastScheduleFlow)} onSave={() => saveDraft("schema")} onAction={writeAuditLog} onNotify={showToast} />}
          {activeFlow === "rules" && <RuleApplicationPage draft={draftPipeline} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow("schema")} onNext={() => completeWizardFlowAndMove("schema", continuousKafkaDraft ? "permission" : lastScheduleFlow)} onSave={() => saveDraft("rules")} onAction={writeAuditLog} onNotify={showToast} />}
          {isScheduleFlow(activeFlow) && <SchedulePage draftSchedule={draftPipeline.schedule} mode={activeFlow} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow("schema")} onModeChange={moveToFlow} onNext={() => completeWizardFlowAndMove(lastScheduleFlow, "permission")} onSave={() => saveDraft(activeFlow)} />}
          {activeFlow === "target" && <TargetPage draft={draftPipeline} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow("permission")} onNext={() => completeWizardFlowAndMove("target", "review")} onSave={() => saveDraft("target")} />}
          {activeFlow === "permission" && <PermissionPage draft={draftPipeline} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow(continuousKafkaDraft ? "schema" : lastScheduleFlow)} onNext={() => completeWizardFlowAndMove("permission", "target")} onSave={() => saveDraft("permission")} />}
          {activeFlow === "review" && <ReviewPage createPending={apiPending} draft={draftPipeline} onEdit={moveToFlow} onSave={() => saveDraft("review")} onCreate={createPipeline} />}
          {activeFlow === "catalog" && <CatalogPage datasets={datasets} error={catalogError} loading={catalogLoading} onViewChange={changeCatalogView} selectedDataset={selectedDataset} view={routeState.catalogView ?? "catalog"} onAction={writeAuditLog} onOpenSql={openDatasetInSqlWithSelection} />}
          {activeFlow === "catalogDetail" && <CatalogDetailPage dataset={selectedDataset} onAction={writeAuditLog} onBack={() => moveToFlow("catalog")} onLineage={() => writeAuditLog("catalog.lineage.opened", `/api/catalog/datasets/${selectedDataset.id}/lineage`, selectedDataset.id)} onOpenSql={() => openDatasetInSqlWithSelection(selectedDataset)} />}
          {activeFlow === "sql" && <SqlAnalysisPage cachedResult={sqlResultDraft} createPending={apiPending} dataset={sqlInitialDataset} datasets={datasets} onAction={writeAuditLog} onCreateDatasetJob={createSqlDatasetJob} onCreateTrinoSqlJob={createTrinoSqlJob} onResultChange={setSqlResultDraft} />}
          {activeFlow === "dashboard" && <DashboardPage dataset={selectedDataset} entry={dashboardEntry} sqlResult={sqlResultDraft} onAction={writeAuditLog} onRuntimeNavigate={navigateDashboardRuntime} />}
          {activeFlow === "profile" && <ProfilePage onAction={writeAuditLog} />}
          {activeFlow === "admin" && canAccessAdmin && <AdminConsolePage onAction={writeAuditLog} onNotify={showToast} />}
            </>
          )}
        </section>
      </main>
    </div>
  );
}
