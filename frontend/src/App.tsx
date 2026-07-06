import { useEffect, useMemo, useState } from "react";
import type React from "react";
import { BookOpen, CircleHelp, Database, History, LogOut, Settings, ShieldCheck, Workflow } from "lucide-react";
import { flowTabs, navItems, wizardFlows } from "./data/appShellData";
import { Sidebar } from "./components/layout/Sidebar";
import { Topbar } from "./components/layout/Topbar";
import { Stepper } from "./components/layout/Stepper";
import { Footer } from "./components/layout/Footer";
import { CatalogDetailPage, CatalogPage } from "./pages/catalog/CatalogPage";
import { SqlAnalysisPage } from "./pages/sql/SqlAnalysisPage";
import { DashboardPage } from "./pages/dashboard/DashboardPage";
import { ModulePlaceholderPage } from "./pages/ModulePlaceholderPage";
import { JobDagPage, JobDetailPage, JobRunsPage, JobsLandingPage } from "./pages/ingest/JobsPages";
import { PermissionPage, ReviewPage, RuleApplicationPage, SchedulePage, SchemaInferencePage, SourceConnectionPage, TargetPage } from "./pages/etl/EtlPages";
import { useAuditLogs } from "./hooks/useAuditLogs";
import { useAskLakeData } from "./hooks/useAskLakeData";
import type { AuditEntry, AuditTargetType, CatalogDataset, DashboardEntry, FlowId, NavId, NavItem, ScheduleFlowId, SqlResultDraft } from "./types";
import type { DashboardRuntimeMode } from "./types";

type PlaceholderFlow = Extract<FlowId, "ai" | "admin">;
type PlaceholderAction = "requirements" | "status" | "primary";
const scheduleFlows: ScheduleFlowId[] = ["repeat", "manual", "once"];

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

function hasSelectedDataset(dataset: CatalogDataset, datasets: CatalogDataset[]) {
  return dataset.id !== emptyDatasetId && datasets.some((item) => item.id === dataset.id);
}

function hasSelectedJob(jobId: string, jobs: Array<{ id: string }>) {
  return jobId !== emptyJobId && jobs.some((job) => job.id === jobId);
}

export function App() {
  const initialDashboardRoute = parseDashboardRoute(window.location.pathname);
  const [activeFlow, setActiveFlow] = useState<FlowId>(initialDashboardRoute ? "dashboard" : "jobs");
  const [lastScheduleFlow, setLastScheduleFlow] = useState<ScheduleFlowId>("repeat");
  const [dashboardEntry, setDashboardEntry] = useState<DashboardEntry>(() => (
    initialDashboardRoute ? dashboardEntryFromRoute(initialDashboardRoute, 0) : { source: "sidebar", view: "list", version: 0 }
  ));
  const { auditLogs, auditOpen, auditSignal, setAuditOpen, showToast, toast, writeAuditLog } = useAuditLogs();
  const {
    apiPending,
    commandPendingByJobId,
    createPipeline,
    createSqlDerivedDataset,
    dataError,
    dataLoading,
    datasets,
    draftPipeline,
    handleJobCommand,
    jobExecutionEvidence,
    jobs,
    openDataset,
    openDatasetInSql,
    openJobDag,
    openJobDetail,
    runsByJobId,
    selectedDataset,
    selectedJob,
    selectedRunIdByJobId,
    selectRunForJob,
    setSelectedDataset,
    setSqlResultDraft,
    sqlResultDraft,
    updateDraftPipeline,
  } = useAskLakeData({ onFlowChange: setActiveFlow, showToast, writeAuditLog });
  const current = useMemo(() => flowTabs.find((tab) => tab.id === activeFlow), [activeFlow]);
  const selectedJobRuns = runsByJobId[selectedJob.id] ?? [];
  const requestedRunId = selectedRunIdByJobId[selectedJob.id];
  const selectedRunId = requestedRunId && selectedJobRuns.some((run) => run.runId === requestedRunId)
    ? requestedRunId
    : selectedJobRuns[0]?.runId;
  const activeNavId = useMemo<NavId>(() => {
    if (activeFlow === "catalog" || activeFlow === "catalogDetail") return "catalog";
    if (activeFlow === "sql") return "sql";
    if (activeFlow === "dashboard") return "dashboard";
    if (activeFlow === "ai") return "ai";
    if (activeFlow === "admin") return "admin";
    return "ingest";
  }, [activeFlow]);
  const selectedDatasetAvailable = hasSelectedDataset(selectedDataset, datasets);
  const selectedJobAvailable = hasSelectedJob(selectedJob.id, jobs);
  const requiresSelectedJob = activeFlow === "jobDetail" || activeFlow === "jobRuns" || activeFlow === "jobDag";
  const requiresSelectedDataset = activeFlow === "catalogDetail" || activeFlow === "sql" || (activeFlow === "dashboard" && dashboardEntry.view === "builder");
  const canRenderActiveFlow = (!requiresSelectedJob || selectedJobAvailable) && (!requiresSelectedDataset || selectedDatasetAvailable);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 });
  }, [activeFlow, selectedJob?.id]);

  useEffect(() => {
    const handlePopState = () => {
      const route = parseDashboardRoute(window.location.pathname);
      if (!route) return;
      setDashboardEntry((entry) => dashboardEntryFromRoute(route, entry.version + 1));
      setActiveFlow("dashboard");
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const moveToFlow = (flow: FlowId) => {
    if (isScheduleFlow(flow)) {
      setLastScheduleFlow(flow);
    }
    setActiveFlow(flow);
  };

  const saveDraft = (flow: FlowId) => {
    writeAuditLog("etl.job.draft_saved", "/api/etl/jobs", `draft:${flow}`);
    showToast("설정이 임시 저장되었습니다.");
  };

  const navigateSidebar = (item: NavItem) => {
    writeAuditLog("ui.menu.clicked", `/app/${item.id}`, item.label);
    if (item.id === "dashboard") {
      if (window.location.pathname !== "/dashboards") window.history.pushState(null, "", "/dashboards");
      setDashboardEntry((entry) => ({ source: "sidebar", view: "list", version: entry.version + 1 }));
    } else if (window.location.pathname.startsWith("/dashboards")) {
      window.history.pushState(null, "", "/");
    }
    moveToFlow(item.flow);
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

  const openDashboardBuilder = (source: DashboardEntry["source"], action: string, apiPath: string, dataset?: CatalogDataset | null) => {
    const targetDataset = dataset ?? selectedDataset;
    if (!targetDataset || !hasSelectedDataset(targetDataset, datasets)) {
      showToast("DB 데이터 로딩 후 다시 시도해주세요.", "info");
      return;
    }

    setSelectedDataset(targetDataset);
    writeAuditLog(action, apiPath, targetDataset.id);
    setDashboardEntry((entry) => ({ source, view: "builder", version: entry.version + 1 }));
    moveToFlow("dashboard");
  };

  const openDashboardFromSql = (result: SqlResultDraft) => {
    if (!selectedDatasetAvailable) {
      showToast("DB 데이터 로딩 후 다시 시도해주세요.", "info");
      return;
    }

    setSqlResultDraft(result);
    openDashboardBuilder("sql", "analysis.dashboard.create_requested", "/api/dashboards", selectedDataset);
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
      <Sidebar activeNavId={activeNavId} onAccount={() => writeAuditLog("ui.account_opened", "/app/account", "demo.user@asklake.local", "success", { targetType: "ui" })} onNavigate={navigateSidebar} />
      <main className={activeFlow === "schema" ? "main-shell schema-shell" : "main-shell"}>
        <Topbar auditLogs={auditLogs} auditOpen={auditOpen} onAuditToggle={() => setAuditOpen((open) => !open)} onRefresh={() => writeAuditLog("etl.job.status_refreshed", "/api/etl/jobs", "jobs")} />
        {toast && <div className={`app-toast ${toast.tone}`}>{toast.message}</div>}
        {apiPending && <div className="app-api-pending">API 요청 처리 중...</div>}
        {wizardFlows.includes(activeFlow) && <Stepper activeIndex={current?.stepIndex ?? 0} />}
        <section className={activeFlow === "jobs" ? "page-body jobs-body" : activeFlow === "schema" ? "page-body schema-body" : "page-body"}>
          {dataLoading && (
            <div className="module-placeholder-page">
              <span>POSTGRES</span>
              <h1>DB 데이터를 불러오는 중입니다</h1>
              <p>Docker Postgres에 seed된 AskLake 데이터를 API 서버에서 가져오고 있습니다.</p>
            </div>
          )}
          {!dataLoading && dataError && (
            <div className="module-placeholder-page">
              <span>POSTGRES ERROR</span>
              <h1>DB API 연결을 확인해주세요</h1>
              <p>{dataError}</p>
            </div>
          )}
          {!dataLoading && !dataError && !canRenderActiveFlow && (
            <div className="module-placeholder-page">
              <span>EMPTY STATE</span>
              <h1>먼저 실제 데이터를 선택해주세요</h1>
              <p>목록에서 Job 또는 Dataset을 선택하거나, 새 파이프라인을 생성하고 실행해 주세요.</p>
            </div>
          )}
          {!dataLoading && !dataError && canRenderActiveFlow && (
            <>
          {activeFlow === "jobs" && <JobsLandingPage commandPendingByJobId={commandPendingByJobId} jobs={jobs} onCommand={handleJobCommand} onCreate={() => moveToFlow("source")} onDetail={openJobDetail} onRuns={() => moveToFlow("jobRuns")} onDag={openJobDag} onAction={writeAuditLog} />}
          {activeFlow === "jobDetail" && <JobDetailPage commandPending={commandPendingByJobId[selectedJob.id]} job={selectedJob} onCommand={handleJobCommand} onBack={() => moveToFlow("jobs")} onEdit={() => moveToFlow("source")} onRuns={() => moveToFlow("jobRuns")} onDag={() => moveToFlow("jobDag")} onAction={writeAuditLog} />}
          {activeFlow === "jobRuns" && <JobRunsPage commandPending={commandPendingByJobId[selectedJob.id]} job={selectedJob} runs={selectedJobRuns} selectedRunId={selectedRunId} onRunSelect={selectRunForJob} onCommand={handleJobCommand} onBack={() => moveToFlow("jobDetail")} onDag={() => moveToFlow("jobDag")} onAction={writeAuditLog} />}
          {activeFlow === "jobDag" && <JobDagPage commandPending={commandPendingByJobId[selectedJob.id]} evidence={jobExecutionEvidence[selectedJob.id]} job={selectedJob} selectedRunId={selectedRunId} onRunSelect={selectRunForJob} onCommand={handleJobCommand} onBack={() => moveToFlow("jobDetail")} onEdit={() => moveToFlow("rules")} onRuns={() => moveToFlow("jobRuns")} onAction={writeAuditLog} />}
          {activeFlow === "source" && <SourceConnectionPage draft={draftPipeline} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow("jobs")} onNext={() => moveToFlow("schema")} onSave={() => saveDraft("source")} onAction={writeAuditLog} onNotify={showToast} />}
          {activeFlow === "schema" && <SchemaInferencePage draft={draftPipeline} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow("source")} onNext={() => moveToFlow("rules")} onSave={() => saveDraft("schema")} onAction={writeAuditLog} onNotify={showToast} />}
          {isScheduleFlow(activeFlow) && <SchedulePage draftRetryPolicy={draftPipeline.schedule.retryPolicy} draftScheduleLabel={draftPipeline.schedule.label} mode={activeFlow} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow("rules")} onModeChange={moveToFlow} onNext={() => moveToFlow("permission")} onSave={() => saveDraft(activeFlow)} />}
          {activeFlow === "target" && <TargetPage draft={draftPipeline} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow("permission")} onNext={() => moveToFlow("review")} onSave={() => saveDraft("target")} />}
          {activeFlow === "permission" && <PermissionPage draft={draftPipeline} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow(lastScheduleFlow)} onNext={() => moveToFlow("target")} onSave={() => saveDraft("permission")} />}
          {activeFlow === "review" && <ReviewPage createPending={apiPending} draft={draftPipeline} onEdit={moveToFlow} onSave={() => saveDraft("review")} onCreate={createPipeline} />}
          {activeFlow === "catalog" && <CatalogPage datasets={datasets} selectedDataset={selectedDataset} onAction={writeAuditLog} onDatasetOpen={openDataset} onOpenSql={openDatasetInSql} />}
          {activeFlow === "catalogDetail" && <CatalogDetailPage dataset={selectedDataset} onAction={writeAuditLog} onBack={() => moveToFlow("catalog")} onCreateDashboard={() => openDashboardBuilder("catalog", "catalog.dashboard.create_requested", `/api/catalog/datasets/${selectedDataset.id}/dashboards`)} onLineage={() => writeAuditLog("catalog.lineage.opened", `/api/catalog/datasets/${selectedDataset.id}/lineage`, selectedDataset.id)} onOpenSql={() => openDatasetInSql(selectedDataset)} />}
          {activeFlow === "sql" && <SqlAnalysisPage dataset={selectedDataset} datasets={datasets} onAction={writeAuditLog} onCreateDashboard={openDashboardFromSql} onCreateDerivedDataset={createSqlDerivedDataset} onResultChange={setSqlResultDraft} />}
          {activeFlow === "dashboard" && <DashboardPage dataset={selectedDataset} entry={dashboardEntry} sqlResult={sqlResultDraft} onAction={writeAuditLog} onRuntimeNavigate={navigateDashboardRuntime} />}
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
        <div className="etl-builder-brand">
          <span className="etl-builder-brand-mark" aria-hidden="true" />
          <strong>AskLake - 데이터셋 생성 ETL 빌더</strong>
        </div>
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
