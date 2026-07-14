import {
  Database,
  Maximize2,
  Plus,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  Table2,
} from "lucide-react";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { DatasetStatusBadge } from "../../catalog/CatalogPage";
import type { CatalogDataset, SavedDashboardCard, SqlResultDraft } from "../../../types";
import { dashboardStatusMeta } from "../../../utils/statusMeta";
import {
  DashboardChartCard,
  DashboardChartModal,
  DashboardDeleteModal,
  DashboardFooterMeta,
  DashboardWorkspaceHeader,
} from "../DashboardParts";
import type { ExpandedChart } from "../DashboardParts";
import { DashboardLegacyChart } from "./DashboardLegacyChart";
import type { DashboardLegacyModel } from "./dashboardLegacyModel";

export function DashboardLegacyDetailView({
  activeDashboardTitle,
  activeSqlResult,
  dataset,
  deleteRequested,
  expandedChart,
  isPublished,
  model,
  onBackToList,
  onCancelDelete,
  onChangeFilter,
  onCloseExpandedChart,
  onConfirmDelete,
  onCreateDashboard,
  onDraftEdit,
  onExport,
  onFullscreen,
  onOpenDashboard,
  onOpenExpandedChart,
  onPublish,
  onRequestDelete,
  onSave,
  onShare,
  onViewPublished,
  period,
  segment,
  selectedDashboard,
  sidebarDashboards,
}: {
  activeDashboardTitle: string;
  activeSqlResult: SqlResultDraft | null;
  dataset: CatalogDataset;
  deleteRequested: boolean;
  expandedChart: ExpandedChart | null;
  isPublished: boolean;
  model: DashboardLegacyModel;
  onBackToList: () => void;
  onCancelDelete: () => void;
  onChangeFilter: (period: string, segment?: string) => void;
  onCloseExpandedChart: () => void;
  onConfirmDelete: () => void;
  onCreateDashboard: () => void;
  onDraftEdit: () => void;
  onExport: () => void;
  onFullscreen: () => void;
  onOpenDashboard: (dashboard: SavedDashboardCard) => void;
  onOpenExpandedChart: (kind: ExpandedChart["kind"], title: string, subtitle: string) => void;
  onPublish: () => void;
  onRequestDelete: (target: string) => void;
  onSave: () => void;
  onShare: () => void;
  onViewPublished: () => void;
  period: string;
  segment: string;
  selectedDashboard: SavedDashboardCard | null;
  sidebarDashboards: SavedDashboardCard[];
}) {
  return (
    <div className="dashboard-page dashboard-detail-page">
      <DashboardWorkspaceHeader
        isPublished={isPublished}
        onBackToList={onBackToList}
        onDraftEdit={onDraftEdit}
        onExport={onExport}
        onFullscreen={onFullscreen}
        onPublish={onPublish}
        onSave={onSave}
        onShare={onShare}
        onViewPublished={onViewPublished}
        primaryTitle={selectedDashboard
          ? dashboardStatusMeta[selectedDashboard.status].label
          : isPublished
            ? "Published"
            : "Draft"}
        title={activeDashboardTitle}
      />

      <section className="dashboard-publish-card">
        <div>
          <strong>팀원이나 외부 협업자와 대시보드를 공유하고 권한을 관리하세요.</strong>
          <span>링크가 있는 조직 내 모든 사용자가 이 대시보드를 볼 수 있습니다.</span>
        </div>
        <button className="secondary-button" type="button" onClick={onShare}><Share2 size={16} /> Share</button>
      </section>

      <header className="dashboard-header compact">
        <div>
          <span>Dashboards</span>
          <h1>대시보드 개요</h1>
          <p>{activeSqlResult
            ? `${activeSqlResult.datasetName} SQL 결과 위젯을 배치한 게시용 대시보드입니다.`
            : `${dataset.name} 데이터셋과 SQL 결과 위젯을 함께 배치한 게시용 대시보드입니다.`}</p>
        </div>
      </header>

      <section className="dashboard-filter-bar">
        <div className="dashboard-filter-title">
          <SlidersHorizontal size={16} />
          <strong>필터</strong>
        </div>
        <SegmentedTabs
          ariaLabel="대시보드 기간 필터"
          className="dashboard-segmented"
          items={["오늘", "최근 7일", "최근 30일"].map((item) => ({ label: item, value: item }))}
          value={period}
          onValueChange={(item) => onChangeFilter(item)}
        />
        <label>
          <span>채널</span>
          <select value={segment} onChange={(event) => onChangeFilter(period, event.target.value)}>
            <option>전체 채널</option>
            <option>Mobile</option>
            <option>Web</option>
            <option>Partner</option>
          </select>
        </label>
        <button className="secondary-button" type="button" onClick={onCreateDashboard}><Plus size={16} /> 새 대시보드</button>
      </section>

      <section className="dashboard-metric-grid">
        {activeSqlResult ? (
          <article className="dashboard-metric-card">
            <span>SQL 결과 행 수</span>
            <strong>{activeSqlResult.rowCount.toLocaleString()}</strong>
            <div><small>실행된 쿼리의 실제 결과</small></div>
          </article>
        ) : <div className="dashboard-empty-state">실행된 SQL 결과가 없습니다.</div>}
      </section>

      <div className="dashboard-layout">
        <main className="dashboard-canvas">
          <section className="dashboard-chart-card dashboard-category-card">
            <div className="dashboard-card-header">
              <div>
                <span>CHART</span>
                <h2>카테고리별 매출 (KRW)</h2>
                <p>전자제품 · 의류 · 식료품 · 가구 · 취미용품</p>
              </div>
              <div className="dashboard-widget-toolbar">
                <button type="button" onClick={() => onOpenExpandedChart("category", "카테고리별 매출 (KRW)", "전자제품 · 의류 · 식료품 · 가구 · 취미용품")}><Maximize2 size={16} /></button>
                <button type="button" onClick={() => onRequestDelete("category-sales")}>삭제</button>
              </div>
            </div>
            <DashboardLegacyChart kind="category" model={model} />
          </section>

          <DashboardChartCard
            title="일별 주문/매출 추이"
            subtitle={`${period} · ${segment}`}
            onOpen={() => onOpenExpandedChart("orders", "일별 주문/매출 추이", `${period} · ${segment}`)}
          >
            <DashboardLegacyChart kind="orders" model={model} />
          </DashboardChartCard>

          <DashboardChartCard
            title="채널별 성과"
            subtitle="주문수 · 매출 · 비중"
            onOpen={() => onOpenExpandedChart("channels", "채널별 성과", "주문수 · 매출 · 비중")}
          >
            <DashboardLegacyChart kind="channels" model={model} />
          </DashboardChartCard>

          <section className="dashboard-table-card">
            <div className="dashboard-card-header">
              <div>
                <span>RESULT TABLE</span>
                <h2>{dataset.name} 샘플 결과</h2>
              </div>
              <Table2 size={18} />
            </div>
            <div className="dashboard-table-scroll">
              <table className="schema-table">
                <thead><tr>{model.columns.slice(0, 5).map((column, index) => <th key={`${column}-${index}`}>{column}</th>)}</tr></thead>
                <tbody>{model.rowsPreview.map((row, rowIndex) => (
                  <tr key={`dashboard-row-${rowIndex}`}>
                    {row.slice(0, 5).map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{cell}</td>)}
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </section>
        </main>

        <aside className="dashboard-side-panel">
          <section>
            <h2>데이터 연결</h2>
            <div className="dashboard-source-card">
              <Database size={18} />
              <strong>{dataset.name}</strong>
              <span>{dataset.layer} · {dataset.rows} rows</span>
              <DatasetStatusBadge dataset={dataset} />
            </div>
          </section>
          <section>
            <h2>대시보드 목록</h2>
            {sidebarDashboards.slice(0, 3).map((dashboard) => (
              <button key={dashboard.id} type="button" onClick={() => onOpenDashboard(dashboard)}>
                <strong>{dashboard.name}</strong>
                <span>{dashboardStatusMeta[dashboard.status].label}</span>
                <small>{dashboard.meta}</small>
              </button>
            ))}
          </section>
          <section>
            <h2>공유 상태</h2>
            <div className="dashboard-share-box">
              <ShieldCheck size={18} />
              <strong>팀 내부 공개</strong>
              <span>analytics, platform 그룹에 읽기 권한이 부여되어 있습니다.</span>
            </div>
          </section>
        </aside>
      </div>
      <DashboardFooterMeta />
      {expandedChart && (
        <DashboardChartModal chart={expandedChart} onClose={onCloseExpandedChart}>
          <DashboardLegacyChart expanded kind={expandedChart.kind} model={model} />
        </DashboardChartModal>
      )}
      {deleteRequested && <DashboardDeleteModal onCancel={onCancelDelete} onDelete={onConfirmDelete} />}
    </div>
  );
}
