import { useEffect, useMemo, useState } from "react";
import { flowTabs, navItems, wizardFlows } from "./data/mockData";
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
import type { AuditTargetType, CatalogDataset, DashboardEntry, FlowId, NavId, NavItem, ScheduleFlowId, SqlResultDraft } from "./types";

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

export function App() {
  const [activeFlow, setActiveFlow] = useState<FlowId>("jobs");
  const [lastScheduleFlow, setLastScheduleFlow] = useState<ScheduleFlowId>("repeat");
  const [dashboardEntry, setDashboardEntry] = useState<DashboardEntry>({ source: "sidebar", view: "list", version: 0 });
  const { auditLogs, auditOpen, auditSignal, setAuditOpen, showToast, toast, writeAuditLog } = useAuditLogs();
  const {
    apiPending,
    createPipeline,
    datasets,
    draftPipeline,
    handleJobCommand,
    jobs,
    openDataset,
    openDatasetInSql,
    openJobDetail,
    selectedDataset,
    selectedJob,
    setSelectedDataset,
    setSqlResultDraft,
    sqlResultDraft,
    updateDraftPipeline,
  } = useAskLakeData({ onFlowChange: setActiveFlow, showToast, writeAuditLog });
  const current = useMemo(() => flowTabs.find((tab) => tab.id === activeFlow), [activeFlow]);
  const activeNavId = useMemo<NavId>(() => {
    if (activeFlow === "catalog" || activeFlow === "catalogDetail") return "catalog";
    if (activeFlow === "sql") return "sql";
    if (activeFlow === "dashboard") return "dashboard";
    if (activeFlow === "ai") return "ai";
    if (activeFlow === "admin") return "admin";
    return "ingest";
  }, [activeFlow]);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 });
  }, [activeFlow, selectedJob.id]);

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
      setDashboardEntry((entry) => ({ source: "sidebar", view: "list", version: entry.version + 1 }));
    }
    moveToFlow(item.flow);
  };

  const openDashboardBuilder = (source: DashboardEntry["source"], action: string, apiPath: string, dataset: CatalogDataset = selectedDataset) => {
    setSelectedDataset(dataset);
    writeAuditLog(action, apiPath, dataset.id);
    setDashboardEntry((entry) => ({ source, view: "builder", version: entry.version + 1 }));
    moveToFlow("dashboard");
  };

  const openDashboardFromSql = (result: SqlResultDraft) => {
    setSqlResultDraft(result);
    openDashboardBuilder("sql", "analysis.dashboard.create_requested", "/api/dashboards", selectedDataset);
  };

  const recordPlaceholderAction = (flow: PlaceholderFlow, actionType: PlaceholderAction) => {
    const config = placeholderAuditConfig[flow];
    const { action, apiPath } = config.actions[actionType];
    writeAuditLog(action, apiPath, flow, "success", { targetType: config.targetType });
  };

  return (
    <div className="app-shell" data-last-action={auditSignal}>
      <Sidebar activeNavId={activeNavId} onAccount={() => writeAuditLog("ui.account_opened", "/app/account", "demo.user@asklake.local", "success", { targetType: "ui" })} onNavigate={navigateSidebar} />
      <main className="main-shell">
        <Topbar auditLogs={auditLogs} auditOpen={auditOpen} onAuditToggle={() => setAuditOpen((open) => !open)} onRefresh={() => writeAuditLog("etl.job.status_refreshed", "/api/etl/jobs", "jobs")} />
        {toast && <div className={`app-toast ${toast.tone}`}>{toast.message}</div>}
        {apiPending && <div className="app-api-pending">API 요청 처리 중...</div>}
        {wizardFlows.includes(activeFlow) && <Stepper activeIndex={current?.stepIndex ?? 0} />}
        <section className={activeFlow === "jobs" ? "page-body jobs-body" : "page-body"}>
          {activeFlow === "jobs" && <JobsLandingPage jobs={jobs} onCommand={handleJobCommand} onCreate={() => moveToFlow("source")} onDetail={openJobDetail} onRuns={() => moveToFlow("jobRuns")} onDag={() => moveToFlow("jobDag")} onAction={writeAuditLog} />}
          {activeFlow === "jobDetail" && <JobDetailPage job={selectedJob} onCommand={handleJobCommand} onBack={() => moveToFlow("jobs")} onEdit={() => moveToFlow("source")} onRuns={() => moveToFlow("jobRuns")} onDag={() => moveToFlow("jobDag")} onAction={writeAuditLog} />}
          {activeFlow === "jobRuns" && <JobRunsPage job={selectedJob} onCommand={handleJobCommand} onBack={() => moveToFlow("jobDetail")} onDag={() => moveToFlow("jobDag")} onAction={writeAuditLog} />}
          {activeFlow === "jobDag" && <JobDagPage job={selectedJob} onCommand={handleJobCommand} onBack={() => moveToFlow("jobDetail")} onEdit={() => moveToFlow("rules")} onRuns={() => moveToFlow("jobRuns")} onAction={writeAuditLog} />}
          {activeFlow === "source" && <SourceConnectionPage draft={draftPipeline} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow("jobs")} onNext={() => moveToFlow("schema")} onSave={() => saveDraft("source")} onAction={writeAuditLog} onNotify={showToast} />}
          {activeFlow === "schema" && <SchemaInferencePage draft={draftPipeline} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow("source")} onNext={() => moveToFlow("rules")} onSave={() => saveDraft("schema")} onAction={writeAuditLog} onNotify={showToast} />}
          {activeFlow === "rules" && <RuleApplicationPage onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow("schema")} onNext={() => moveToFlow(lastScheduleFlow)} onSave={() => saveDraft("rules")} onAction={writeAuditLog} onNotify={showToast} />}
          {isScheduleFlow(activeFlow) && <SchedulePage draftRetryPolicy={draftPipeline.schedule.retryPolicy} draftScheduleLabel={draftPipeline.schedule.label} mode={activeFlow} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow("rules")} onModeChange={moveToFlow} onNext={() => moveToFlow("permission")} onSave={() => saveDraft(activeFlow)} />}
          {activeFlow === "target" && <TargetPage draft={draftPipeline} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow("permission")} onNext={() => moveToFlow("review")} onSave={() => saveDraft("target")} />}
          {activeFlow === "permission" && <PermissionPage draft={draftPipeline} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow(lastScheduleFlow)} onNext={() => moveToFlow("target")} onSave={() => saveDraft("permission")} />}
          {activeFlow === "review" && <ReviewPage createPending={apiPending} draft={draftPipeline} onEdit={moveToFlow} onSave={() => saveDraft("review")} onCreate={createPipeline} />}
          {activeFlow === "catalog" && <CatalogPage datasets={datasets} selectedDataset={selectedDataset} onAction={writeAuditLog} onDatasetOpen={openDataset} onOpenSql={openDatasetInSql} />}
          {activeFlow === "catalogDetail" && <CatalogDetailPage dataset={selectedDataset} onAction={writeAuditLog} onBack={() => moveToFlow("catalog")} onCreateDashboard={() => openDashboardBuilder("catalog", "catalog.dashboard.create_requested", `/api/catalog/datasets/${selectedDataset.id}/dashboards`)} onLineage={() => writeAuditLog("catalog.lineage.opened", `/api/catalog/datasets/${selectedDataset.id}/lineage`, selectedDataset.id)} onOpenSql={() => openDatasetInSql(selectedDataset)} />}
          {activeFlow === "sql" && <SqlAnalysisPage dataset={selectedDataset} datasets={datasets} onAction={writeAuditLog} onResultChange={setSqlResultDraft} onDashboard={openDashboardFromSql} />}
          {activeFlow === "dashboard" && <DashboardPage dataset={selectedDataset} entry={dashboardEntry} sqlResult={sqlResultDraft} onAction={writeAuditLog} />}
          {activeFlow === "ai" && <ModulePlaceholderPage flow="ai" title="AI 활용" owner="확장 예정" description="Lake 데이터를 RAG 데이터셋으로 만들고 권한 기반 자연어 질의를 제공하는 영역입니다." onRequirements={() => recordPlaceholderAction("ai", "requirements")} onStatusRecord={() => recordPlaceholderAction("ai", "status")} onPrimary={() => recordPlaceholderAction("ai", "primary")} />}
          {activeFlow === "admin" && <ModulePlaceholderPage flow="admin" title="관리" owner="확장 예정" description="사용자, 그룹, API 권한과 감사 로그를 관리하는 운영 영역입니다." onRequirements={() => recordPlaceholderAction("admin", "requirements")} onStatusRecord={() => recordPlaceholderAction("admin", "status")} onPrimary={() => recordPlaceholderAction("admin", "primary")} />}
        </section>
        <Footer />
      </main>
    </div>
  );
}
