import type React from "react";
import { Download, Maximize2, Save, Share2 } from "lucide-react";
import type { DashboardStatus, DashboardWidgetType } from "../../types";

export type SavedDashboardCard = {
  datasetId?: string;
  id: string;
  meta: string;
  name: string;
  owner: string;
  sourceRunId?: string;
  status: DashboardStatus;
  tags: string;
  updated: string;
};

export type ExpandedChart = {
  kind: "category" | "orders" | "channels";
  subtitle: string;
  title: string;
};

export const defaultDashboardCards: SavedDashboardCard[] = [
  { id: "dash_sales_demo", name: "Sales Analytics Demo 2026-06-26 22:04:05", tags: "Sales · Revenue · Demo", owner: "Admin User", updated: "2시간 전", status: "published", meta: "최근 7일 · 자동 갱신" },
  { id: "dash_marketing_roi", name: "Marketing Campaign ROI Tracking", tags: "Marketing · ROI", owner: "Jane Doe", updated: "어제", status: "draft", meta: "권한 검토 필요" },
  { id: "dash_qbr", name: "Executive QBR Dashboard", tags: "Executive · Quarterly", owner: "Robert Wilson", updated: "3일 전", status: "published", meta: "GOLD mart 연결" },
  { id: "dash_apac_sales", name: "Regional Sales Performance - APAC", tags: "Regional · Sales", owner: "Sarah Kim", updated: "1주일 전", status: "published", meta: "APAC 영업팀 공유" },
  { id: "dash_inventory_leakage", name: "Inventory Leakage Report", tags: "Inventory · Ops", owner: "Michael Chen", updated: "2주일 전", status: "draft", meta: "운영 검토 중" },
];

export function DashboardWorkspaceHeader({
  isPublished,
  onBackToList,
  onDraftEdit,
  onExport,
  onFullscreen,
  onPublish,
  onSave,
  onShare,
  onViewPublished,
  primaryTitle,
  title,
}: {
  isPublished: boolean;
  onBackToList: () => void;
  onDraftEdit?: () => void;
  onExport: () => void;
  onFullscreen: () => void;
  onPublish: () => void;
  onSave: () => void;
  onShare: () => void;
  onViewPublished: () => void;
  primaryTitle: string;
  title: string;
}) {
  return (
    <header className="dashboard-workspace-header">
      <div>
        <span className={isPublished ? "dashboard-publish-state published" : "dashboard-publish-state"}>{primaryTitle}</span>
        <h1>{title}</h1>
      </div>
      <div className="dashboard-header-actions dashboard-workspace-actions">
        <button className="secondary-button" type="button" onClick={onBackToList}>목록으로</button>
        {onDraftEdit && <button className="secondary-button" type="button" onClick={onDraftEdit}>초안 수정</button>}
        <button className="secondary-button" type="button" onClick={onSave}><Save size={16} /> 저장</button>
        <button className="secondary-button" type="button" onClick={onPublish}>Publish</button>
        <button className="secondary-button" type="button" onClick={onShare}><Share2 size={16} /> Share</button>
        <button className="secondary-button" type="button" onClick={onExport}><Download size={16} /> 내보내기</button>
        <button className="secondary-button" type="button" onClick={onFullscreen}>전체화면</button>
        <button className="primary-button" type="button" onClick={onViewPublished}>게시된 대시보드 보기</button>
      </div>
    </header>
  );
}

export function DashboardFooterMeta() {
  return (
    <footer className="dashboard-meta-footer">
      <span>Region: us-west-2</span>
      <span>Version: 3.4.1-stable</span>
      <span>© 2026 Databricks Inc.</span>
    </footer>
  );
}

export function DashboardWidgetPreview({
  columns,
  compact,
  rows,
  type,
}: {
  columns?: string[];
  compact?: boolean;
  rows?: string[][];
  type: DashboardWidgetType;
}) {
  if (type === "kpi") {
    return (
      <div className={compact ? "dashboard-widget-preview kpi compact" : "dashboard-widget-preview kpi"}>
        <span>총 주문</span>
        <strong>128,420</strong>
        <em>+12.4%</em>
      </div>
    );
  }

  if (type === "line") {
    return (
      <div className={compact ? "dashboard-widget-preview compact" : "dashboard-widget-preview"}>
        <div className="dashboard-line-preview">
          {[32, 48, 42, 64, 58, 82].map((value, index) => <i key={index} style={{ height: `${value}%` }} />)}
        </div>
      </div>
    );
  }

  if (type === "donut") {
    return (
      <div className={compact ? "dashboard-widget-preview compact" : "dashboard-widget-preview"}>
        <div className="dashboard-donut mini" />
      </div>
    );
  }

  if (type === "table") {
    const previewColumns = columns?.length ? columns.slice(0, 3) : ["product_id", "category", "risk"];
    const previewRows = rows?.length ? rows.slice(0, 2).map((row) => row.slice(0, 3)) : [["sku_8842", "appliance", "92"], ["sku_8820", "digital", "89"]];

    return (
      <div className={compact ? "dashboard-widget-preview table compact" : "dashboard-widget-preview table"}>
        <table>
          <thead><tr>{previewColumns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
          <tbody>
            {previewRows.map((row, rowIndex) => (
              <tr key={`preview-row-${rowIndex}`}>
                {previewColumns.map((_, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{row[cellIndex] ?? "-"}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className={compact ? "dashboard-widget-preview compact" : "dashboard-widget-preview"}>
      <div className="dashboard-bar-preview">
        {[68, 52, 88, 44, 72].map((value, index) => <i key={index} style={{ height: `${value}%` }} />)}
      </div>
    </div>
  );
}

export function DashboardDeleteModal({ onCancel, onDelete }: { onCancel: () => void; onDelete: () => void }) {
  return (
    <div className="dashboard-delete-modal" role="dialog" aria-modal="true" aria-label="위젯 삭제">
      <section>
        <h2>위젯 삭제</h2>
        <p>정말로 이 위젯을 대시보드에서 삭제하시겠습니까? 이 작업은 대시보드 레이아웃에서만 해당 요소를 제거하며, 원본 데이터 소스에는 영향을 주지 않습니다. 삭제 후에는 다시 추가해야 합니다.</p>
        <div className="form-actions inline">
          <button className="secondary-button" type="button" onClick={onCancel}>취소</button>
          <button className="primary-button" type="button" onClick={onDelete}>삭제</button>
        </div>
      </section>
    </div>
  );
}

export function DashboardChartModal({ chart, children, onClose }: { chart: ExpandedChart; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="dashboard-chart-modal" role="dialog" aria-modal="true" aria-label={`${chart.title} 확대 보기`}>
      <section>
        <div className="dashboard-chart-modal-header">
          <div>
            <span>EXPANDED CHART</span>
            <h2>{chart.title}</h2>
            <p>{chart.subtitle}</p>
          </div>
          <button type="button" onClick={onClose}>닫기</button>
        </div>
        <div className="dashboard-chart-modal-body">
          {children}
        </div>
      </section>
    </div>
  );
}

export function DashboardChartCard({ children, onOpen, subtitle, title }: { children: React.ReactNode; onOpen: () => void; subtitle: string; title: string }) {
  return (
    <section className="dashboard-chart-card">
      <div className="dashboard-card-header">
        <div>
          <span>CHART</span>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        <button type="button" onClick={onOpen}><Maximize2 size={16} /></button>
      </div>
      {children}
    </section>
  );
}
