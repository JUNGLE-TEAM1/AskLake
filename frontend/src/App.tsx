import { useEffect, useMemo, useState } from "react";
import type React from "react";
import { BookOpen, CircleHelp, Database, History, LogOut, Settings, ShieldCheck, Workflow } from "lucide-react";
import asklakeLogo from "./assets/asklake-logo.png";
import { flowTabs, wizardFlows } from "./data/appShellData";
import { Sidebar } from "./components/layout/Sidebar";
import { Topbar } from "./components/layout/Topbar";
import { Stepper } from "./components/layout/Stepper";
import { Footer } from "./components/layout/Footer";
import { CatalogDetailPage, CatalogPage } from "./pages/catalog/CatalogPage";
import { SqlAnalysisPage } from "./pages/sql/SqlAnalysisPage";
import { DashboardPage } from "./pages/dashboard/DashboardPage";
import { AdminConsolePage } from "./pages/admin/AdminConsolePage";
import { AuthPage } from "./pages/auth/AuthPage";
import { ModulePlaceholderPage } from "./pages/ModulePlaceholderPage";
import { ProfilePage } from "./pages/profile/ProfilePage";
import { JobDetailPage, JobRunsPage, JobsLandingPage, JobsTableDemoPage } from "./pages/ingest/JobsPages";
import { PermissionPage, ReviewPage, RuleApplicationPage, SchedulePage, SchemaInferencePage, SourceConnectionPage, TargetPage } from "./pages/etl/EtlPages";
import { useAuditLogs } from "./hooks/useAuditLogs";
import { useAskLakeData } from "./hooks/useAskLakeData";
import { fetchAuthSession, logout as logoutSession } from "./services/authApi";
import { getQueryRun } from "./services/pipelineApi";
import type { AuditEntry, AuditTargetType, CatalogDataset, CurrentUserResponse, DashboardEntry, FlowId, NavId, NavItem, ScheduleFlowId } from "./types";
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

function parseSqlDashboardContext(dashboardId: string) {
  const runIdMatch = dashboardId.match(/_((?:sql|sql_preview)_[A-Za-z0-9_-]+)$/);
  if (!runIdMatch || runIdMatch.index === undefined) return null;

  const sqlRunId = runIdMatch[1];
  const baseDatasetId = dashboardId.startsWith("dash_")
    ? dashboardId.slice("dash_".length, runIdMatch.index)
    : undefined;

  return {
    baseDatasetId: baseDatasetId || undefined,
    sqlRunId,
  };
}

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
  const sqlContext = parseSqlDashboardContext(route.dashboardId);
  if (sqlContext) {
    return {
      baseDatasetId: sqlContext.baseDatasetId,
      dashboardId: route.dashboardId,
      runtimeMode: route.runtimeMode,
      source: "sql",
      sqlRunId: sqlContext.sqlRunId,
      view: "runtime",
      version,
    };
  }
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

function hasSelectedDataset(dataset: CatalogDataset, datasets: CatalogDataset[]) {
  return dataset.id !== emptyDatasetId && datasets.some((item) => item.id === dataset.id);
}

function hasSelectedJob(jobId: string, jobs: Array<{ id: string }>) {
  return jobId !== emptyJobId && jobs.some((job) => job.id === jobId);
}

export function App() {
  const initialDashboardRoute = parseDashboardRoute(window.location.pathname);
  const initialJobsTableDemoRoute = window.location.pathname === "/jobs-table-demo";
  const initialProfileRoute = window.location.pathname === "/profile";
  const initialAdminRoute = window.location.pathname === "/admin";
  const initialLoginRoute = window.location.pathname === "/login";
  const [activeFlow, setActiveFlow] = useState<FlowId>(initialDashboardRoute ? "dashboard" : initialJobsTableDemoRoute ? "jobsTableDemo" : initialProfileRoute ? "profile" : initialAdminRoute ? "admin" : initialLoginRoute ? "login" : "jobs");
  const [currentUser, setCurrentUser] = useState<CurrentUserResponse | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [lastScheduleFlow, setLastScheduleFlow] = useState<ScheduleFlowId>("repeat");
  const [dashboardEntry, setDashboardEntry] = useState<DashboardEntry>(() => (
    initialDashboardRoute ? dashboardEntryFromRoute(initialDashboardRoute, 0) : { source: "sidebar", view: "list", version: 0 }
  ));
  const [hydratingSqlRunId, setHydratingSqlRunId] = useState<string | null>(null);
  const [sqlInitialDatasetId, setSqlInitialDatasetId] = useState<string | null>(null);
  const { auditLogs, auditOpen, auditSignal, setAuditOpen, showToast, toast, writeAuditLog } = useAuditLogs();
  const {
    apiPending,
    createPipeline,
    dataError,
    dataLoading,
    datasets,
    deleteMaterializationRun,
    draftPipeline,
    handleJobCommand,
    jobExecutionEvidence,
    jobs,
    openDatasetInSql,
    openJobDetail,
    openJobRuns,
    prepareSqlDatasetJobDraft,
    runsByJobId,
    selectedDataset,
    selectedJob,
    selectedRunIdByJobId,
    selectRunForJob,
    setSqlResultDraft,
    sqlResultDraft,
    updateDraftPipeline,
  } = useAskLakeData({ onFlowChange: setActiveFlow, showToast, writeAuditLog });
  const current = useMemo(() => flowTabs.find((tab) => tab.id === activeFlow), [activeFlow]);
  const activeNavId = useMemo<NavId | null>(() => {
    if (activeFlow === "catalog" || activeFlow === "catalogDetail") return "catalog";
    if (activeFlow === "sql") return "sql";
    if (activeFlow === "dashboard") return "dashboard";
    if (activeFlow === "ai") return "ai";
    if (activeFlow === "admin") return "admin";
    if (activeFlow === "profile") return null;
    if (activeFlow === "login") return null;
    return "ingest";
  }, [activeFlow]);
  const hasShellRows = jobs.length > 0 || datasets.length > 0;
  const isIngestShellFlow = activeFlow === "jobs" || activeFlow === "jobsTableDemo";
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
  const isAuthProtectedFlow = activeFlow === "profile" || activeFlow === "admin";
  const shouldBlockForAuthCheck = isAuthProtectedFlow && !authChecked;
  const shouldShowAuthGate = isAuthProtectedFlow && authChecked && !currentUser;
  const wizardStepFlows = useMemo<FlowId[]>(
    () => ["source", "schema", lastScheduleFlow, "permission", "target", "review"],
    [lastScheduleFlow],
  );

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 });
  }, [activeFlow, selectedJob?.id]);

  useEffect(() => {
    let active = true;
    fetchAuthSession()
      .then((session) => {
        if (!active) return;
        setCurrentUser(session.user);
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
    if (activeFlow !== "dashboard" || dashboardEntry.source !== "sql" || !dashboardEntry.sqlRunId) return undefined;
    if (sqlResultDraft?.runId === dashboardEntry.sqlRunId) return undefined;

    const sqlRunId = dashboardEntry.sqlRunId;
    let cancelled = false;
    setHydratingSqlRunId(sqlRunId);
    void getQueryRun(sqlRunId)
      .then((result) => {
        if (cancelled) return;
        setSqlResultDraft(result);
        setSqlInitialDatasetId(result.baseDatasetId ?? result.datasetId);
        writeAuditLog("dashboard.sql_result_context_hydrated", `/api/query/runs/${sqlRunId}`, sqlRunId);
      })
      .catch(() => {
        if (cancelled) return;
        writeAuditLog("dashboard.sql_result_context_hydrate_failed", `/api/query/runs/${sqlRunId}`, sqlRunId, "failed");
      })
      .finally(() => {
        if (!cancelled) setHydratingSqlRunId(null);
      });

    return () => {
      cancelled = true;
    };
  }, [activeFlow, dashboardEntry.source, dashboardEntry.sqlRunId, setSqlResultDraft, sqlResultDraft?.runId, writeAuditLog]);

  useEffect(() => {
    const handlePopState = () => {
      const route = parseDashboardRoute(window.location.pathname);
      if (route) {
        setDashboardEntry((entry) => dashboardEntryFromRoute(route, entry.version + 1));
        setActiveFlow("dashboard");
        return;
      }
      if (window.location.pathname === "/profile") {
        setActiveFlow("profile");
        return;
      }
      if (window.location.pathname === "/admin") {
        setActiveFlow("admin");
        return;
      }
      if (window.location.pathname === "/login") {
        setActiveFlow("login");
        return;
      }
      setActiveFlow(window.location.pathname === "/jobs-table-demo" ? "jobsTableDemo" : "jobs");
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const moveToFlow = (flow: FlowId) => {
    if (flow === "rules") {
      setActiveFlow(lastScheduleFlow);
      return;
    }
    if (isScheduleFlow(flow)) {
      setLastScheduleFlow(flow);
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
      if (window.location.pathname !== "/dashboards") window.history.pushState(null, "", "/dashboards");
      setDashboardEntry((entry) => ({ source: "sidebar", view: "list", version: entry.version + 1 }));
    } else if (item.id === "admin") {
      if (window.location.pathname !== "/admin") window.history.pushState(null, "", "/admin");
    } else if (window.location.pathname.startsWith("/dashboards") || window.location.pathname === "/jobs-table-demo" || window.location.pathname === "/profile" || window.location.pathname === "/admin" || window.location.pathname === "/login") {
      window.history.pushState(null, "", "/");
    }
    moveToFlow(item.flow);
  };

  const openJobsTableDemo = () => {
    writeAuditLog("etl.jobs.table_demo_opened", "/jobs-table-demo", "jobs-table-demo", "success", { targetType: "ui" });
    if (window.location.pathname !== "/jobs-table-demo") window.history.pushState(null, "", "/jobs-table-demo");
    moveToFlow("jobsTableDemo");
  };

  const closeJobsTableDemo = () => {
    writeAuditLog("etl.jobs.table_demo_closed", "/api/etl/jobs", "jobs-table-demo", "success", { targetType: "ui" });
    if (window.location.pathname === "/jobs-table-demo") window.history.pushState(null, "", "/");
    moveToFlow("jobs");
  };

  const navigateIngestLanding = () => {
    writeAuditLog("ui.brand.clicked", "/app/ingest", "AskLake");
    if (window.location.pathname !== "/") window.history.pushState(null, "", "/");
    setDashboardEntry((entry) => ({ source: "sidebar", view: "list", version: entry.version + 1 }));
    moveToFlow("jobs");
  };

  const openProfilePage = () => {
    if (!currentUser) {
      openLoginPage();
      return;
    }
    writeAuditLog("ui.account_opened", "/api/users/me", currentUser.email, "success", { targetType: "ui" });
    if (window.location.pathname !== "/profile") window.history.pushState(null, "", "/profile");
    moveToFlow("profile");
  };

  const openLoginPage = () => {
    writeAuditLog("ui.login_opened", "/api/auth/session", "login", "success", { targetType: "ui" });
    if (window.location.pathname !== "/login") window.history.pushState(null, "", "/login");
    moveToFlow("login");
  };

  const handleAuthenticated = (user: CurrentUserResponse) => {
    setCurrentUser(user);
    showToast(`${user.displayName} 계정으로 로그인되었습니다.`, "success");
    if (window.location.pathname !== "/profile") window.history.pushState(null, "", "/profile");
    moveToFlow("profile");
  };

  const handleLogout = () => {
    logoutSession()
      .then(() => {
        setCurrentUser(null);
        writeAuditLog("auth.logout.succeeded", "/api/auth/logout", "session", "success", { targetType: "ui" });
        showToast("로그아웃되었습니다.", "info");
        if (window.location.pathname === "/profile" || window.location.pathname === "/admin") {
          window.history.pushState(null, "", "/login");
          moveToFlow("login");
        }
      })
      .catch(() => {
        writeAuditLog("auth.logout.failed", "/api/auth/logout", "session", "failed", { targetType: "ui" });
        showToast("로그아웃 요청에 실패했습니다.", "info");
      });
  };

  const openDatasetInSqlWithSelection = (dataset: CatalogDataset) => {
    setSqlInitialDatasetId(dataset.id);
    openDatasetInSql(dataset);
  };

  const reopenSqlAnalysisFromDashboard = () => {
    const targetDatasetId = dashboardEntry.baseDatasetId ?? sqlResultDraft?.baseDatasetId ?? sqlResultDraft?.datasetId ?? null;
    setSqlInitialDatasetId(targetDatasetId);
    if (window.location.pathname.startsWith("/dashboards")) window.history.pushState(null, "", "/");
    writeAuditLog("dashboard.sql_result_context_reopen_sql", "/api/query/runs", dashboardEntry.sqlRunId ?? "sql-result");
    moveToFlow("sql");
  };

  const navigateDashboardRuntime = (dashboardId: string, mode: DashboardRuntimeMode) => {
    const path = getDashboardPath(dashboardId, mode);
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
    setDashboardEntry((entry) => ({
      dashboardId,
      runtimeMode: mode,
      source: "internal",
      view: "runtime",
      version: entry.version + 1,
    }));
    moveToFlow("dashboard");
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
        onAccount={openProfilePage}
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
        onAccount={openProfilePage}
        onBrandClick={navigateIngestLanding}
        onNavigate={navigateSidebar}
      />
      <main className={activeFlow === "schema" ? "main-shell schema-shell" : "main-shell"}>
        <Topbar auditLogs={auditLogs} auditOpen={auditOpen} currentUser={currentUser} onAccount={openProfilePage} onAuditToggle={() => setAuditOpen((open) => !open)} onLogin={openLoginPage} onLogout={handleLogout} onRefresh={() => writeAuditLog("etl.job.status_refreshed", "/api/etl/jobs", "jobs")} />
        {toast && <div className={`app-toast ${toast.tone}`}>{toast.message}</div>}
        {(apiPending || (dataLoading && (hasShellRows || isIngestShellFlow))) && <div className="app-api-pending">{pendingMessage}</div>}
        {wizardFlows.includes(activeFlow) && <Stepper activeIndex={current?.stepIndex ?? 0} onStepSelect={navigateWizardStep} />}
        <section className={activeFlow === "jobs" ? "page-body jobs-body" : activeFlow === "schema" ? "page-body schema-body" : activeFlow === "sql" ? "page-body sql-body" : "page-body"}>
          {shouldBlockForAuthCheck && (
            <div className="module-placeholder-page">
              <span>SESSION</span>
              <h1>세션을 확인하는 중입니다</h1>
              <p>로그인 상태를 확인한 뒤 계정 화면을 표시합니다.</p>
            </div>
          )}
          {shouldShowAuthGate && (
            <AuthPage onAction={writeAuditLog} onAuthenticated={handleAuthenticated} />
          )}
          {!shouldBlockForAuthCheck && !shouldShowAuthGate && shouldBlockForInitialData && (
            <div className="module-placeholder-page">
              <span>POSTGRES</span>
              <h1>DB 데이터를 불러오는 중입니다</h1>
              <p>Docker Postgres에 seed된 AskLake 데이터를 API 서버에서 가져오고 있습니다.</p>
            </div>
          )}
          {!shouldBlockForAuthCheck && !shouldShowAuthGate && shouldBlockForInitialError && (
            <div className="module-placeholder-page">
              <span>POSTGRES ERROR</span>
              <h1>DB API 연결을 확인해주세요</h1>
              <p>{dataError}</p>
            </div>
          )}
          {!shouldBlockForAuthCheck && !shouldShowAuthGate && !dataLoading && !dataError && !canRenderActiveFlow && (
            <div className="module-placeholder-page">
              <span>EMPTY STATE</span>
              <h1>먼저 실제 데이터를 선택해주세요</h1>
              <p>목록에서 Job 또는 Dataset을 선택하거나, 새 파이프라인을 생성하고 실행해 주세요.</p>
            </div>
          )}
          {!shouldBlockForAuthCheck && !shouldShowAuthGate && shouldRenderAppContent && (
            <>
          {activeFlow === "jobs" && <JobsLandingPage jobs={jobs} onCommand={handleJobCommand} onCreate={() => moveToFlow("source")} onDetail={openJobDetail} onRuns={openJobRuns} onTableDemo={openJobsTableDemo} onAction={writeAuditLog} />}
          {activeFlow === "jobsTableDemo" && <JobsTableDemoPage jobs={jobs} onBack={closeJobsTableDemo} onCommand={handleJobCommand} onCreate={() => moveToFlow("source")} onRuns={openJobRuns} onDetail={openJobDetail} onAction={writeAuditLog} />}
          {activeFlow === "jobDetail" && <JobDetailPage job={selectedJob} onCommand={handleJobCommand} onBack={() => moveToFlow("jobs")} onEdit={() => moveToFlow("source")} onRuns={() => openJobRuns(selectedJob)} onAction={writeAuditLog} />}
          {activeFlow === "jobRuns" && <JobRunsPage evidence={jobExecutionEvidence[selectedJob.id]} job={selectedJob} onCommand={handleJobCommand} onBack={() => moveToFlow("jobDetail")} onAction={writeAuditLog} />}
          {activeFlow === "source" && <SourceConnectionPage draft={draftPipeline} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow("jobs")} onNext={() => moveToFlow("schema")} onSave={() => saveDraft("source")} onAction={writeAuditLog} onNotify={showToast} />}
          {activeFlow === "schema" && <SchemaInferencePage draft={draftPipeline} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow("source")} onNext={() => moveToFlow(lastScheduleFlow)} onSave={() => saveDraft("schema")} onAction={writeAuditLog} onNotify={showToast} />}
          {isScheduleFlow(activeFlow) && <SchedulePage draftSchedule={draftPipeline.schedule} mode={activeFlow} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow("schema")} onModeChange={moveToFlow} onNext={() => moveToFlow("permission")} onSave={() => saveDraft(activeFlow)} />}
          {activeFlow === "target" && <TargetPage draft={draftPipeline} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow("permission")} onNext={() => moveToFlow("review")} onSave={() => saveDraft("target")} />}
          {activeFlow === "permission" && <PermissionPage draft={draftPipeline} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow(lastScheduleFlow)} onNext={() => moveToFlow("target")} onSave={() => saveDraft("permission")} />}
          {activeFlow === "review" && <ReviewPage createPending={apiPending} draft={draftPipeline} onEdit={moveToFlow} onSave={() => saveDraft("review")} onCreate={createPipeline} />}
          {activeFlow === "catalog" && <CatalogPage datasets={datasets} selectedDataset={selectedDataset} onAction={writeAuditLog} onMaterializationRunDelete={deleteMaterializationRun} onOpenSql={openDatasetInSqlWithSelection} />}
          {activeFlow === "catalogDetail" && <CatalogDetailPage dataset={selectedDataset} onAction={writeAuditLog} onBack={() => moveToFlow("catalog")} onLineage={() => writeAuditLog("catalog.lineage.opened", `/api/catalog/datasets/${selectedDataset.id}/lineage`, selectedDataset.id)} onOpenSql={() => openDatasetInSqlWithSelection(selectedDataset)} />}
          {activeFlow === "sql" && <SqlAnalysisPage cachedResult={sqlResultDraft} dataset={sqlInitialDataset} datasets={datasets} onAction={writeAuditLog} onPrepareDatasetJob={prepareSqlDatasetJobDraft} onResultChange={setSqlResultDraft} />}
          {activeFlow === "dashboard" && <DashboardPage dataset={selectedDataset} datasets={datasets} entry={dashboardEntry} isHydratingSqlResult={hydratingSqlRunId === dashboardEntry.sqlRunId} sqlResult={sqlResultDraft} onAction={writeAuditLog} onMissingSqlResult={reopenSqlAnalysisFromDashboard} onRuntimeNavigate={navigateDashboardRuntime} />}
          {activeFlow === "profile" && <ProfilePage onAction={writeAuditLog} />}
          {activeFlow === "login" && <AuthPage onAction={writeAuditLog} onAuthenticated={handleAuthenticated} />}
          {activeFlow === "ai" && <ModulePlaceholderPage flow="ai" title="AI 활용" owner="확장 예정" description="Lake 데이터를 RAG 데이터셋으로 만들고 권한 기반 자연어 질의를 제공하는 영역입니다." onRequirements={() => recordPlaceholderAction("ai", "requirements")} onStatusRecord={() => recordPlaceholderAction("ai", "status")} onPrimary={() => recordPlaceholderAction("ai", "primary")} />}
          {activeFlow === "admin" && <AdminConsolePage onAction={writeAuditLog} />}
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
        <div className="etl-builder-header-actions">
          <div className="audit-menu">
            <button className={auditOpen ? "icon-button active" : "icon-button"} type="button" aria-label="최근 API 호출" onClick={onAuditToggle}>
              <CircleHelp size={19} />
              {auditCount > 0 && <span className="audit-dot" />}
            </button>
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
          <button className="icon-button" type="button" aria-label="문서" onClick={onDocs}>
            <BookOpen size={19} />
          </button>
          <button className="icon-button" type="button" aria-label="새로고침" onClick={onRefresh}>
            <History size={19} />
          </button>
          <button className="etl-builder-avatar" type="button" aria-label="계정" onClick={onAccount} />
        </div>
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
