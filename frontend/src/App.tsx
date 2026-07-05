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
    commandPendingByJobId,
    createPipeline,
    datasets,
    draftPipeline,
    handleJobCommand,
    jobExecutionEvidence,
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
      <main className="main-shell">
        <Topbar auditLogs={auditLogs} auditOpen={auditOpen} onAuditToggle={() => setAuditOpen((open) => !open)} onRefresh={() => writeAuditLog("etl.job.status_refreshed", "/api/etl/jobs", "jobs")} />
        {toast && <div className={`app-toast ${toast.tone}`}>{toast.message}</div>}
        {apiPending && <div className="app-api-pending">API 요청 처리 중...</div>}
        {wizardFlows.includes(activeFlow) && <Stepper activeIndex={current?.stepIndex ?? 0} />}
        <section className={activeFlow === "jobs" ? "page-body jobs-body" : "page-body"}>
          {activeFlow === "jobs" && <JobsLandingPage commandPendingByJobId={commandPendingByJobId} jobs={jobs} onCommand={handleJobCommand} onCreate={() => moveToFlow("source")} onDetail={openJobDetail} onRuns={() => moveToFlow("jobRuns")} onDag={() => moveToFlow("jobDag")} onAction={writeAuditLog} />}
          {activeFlow === "jobDetail" && <JobDetailPage commandPending={commandPendingByJobId[selectedJob.id]} job={selectedJob} onCommand={handleJobCommand} onBack={() => moveToFlow("jobs")} onEdit={() => moveToFlow("source")} onRuns={() => moveToFlow("jobRuns")} onDag={() => moveToFlow("jobDag")} onAction={writeAuditLog} />}
          {activeFlow === "jobRuns" && <JobRunsPage commandPending={commandPendingByJobId[selectedJob.id]} evidence={jobExecutionEvidence[selectedJob.id]} job={selectedJob} onCommand={handleJobCommand} onBack={() => moveToFlow("jobDetail")} onDag={() => moveToFlow("jobDag")} onAction={writeAuditLog} />}
          {activeFlow === "jobDag" && <JobDagPage commandPending={commandPendingByJobId[selectedJob.id]} evidence={jobExecutionEvidence[selectedJob.id]} job={selectedJob} onCommand={handleJobCommand} onBack={() => moveToFlow("jobDetail")} onEdit={() => moveToFlow("rules")} onRuns={() => moveToFlow("jobRuns")} onAction={writeAuditLog} />}
          {activeFlow === "source" && <SourceConnectionPage draft={draftPipeline} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow("jobs")} onNext={() => moveToFlow("schema")} onSave={() => saveDraft("source")} onAction={writeAuditLog} onNotify={showToast} />}
          {activeFlow === "schema" && <SchemaInferencePage draft={draftPipeline} onDraftChange={updateDraftPipeline} onPrev={() => moveToFlow("source")} onNext={() => moveToFlow("rules")} onSave={() => saveDraft("schema")} onAction={writeAuditLog} onNotify={showToast} />}
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
