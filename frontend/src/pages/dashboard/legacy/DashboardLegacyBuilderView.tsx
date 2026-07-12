import { Database, Plus } from "lucide-react";
import { PreviewPanel } from "@/components/ui/preview-panel";
import { SelectableCard } from "@/components/ui/selectable-card";
import type { CatalogDataset, DashboardWidgetType, SqlResultDraft } from "../../../types";
import {
  DashboardChartModal,
  DashboardFooterMeta,
  DashboardWidgetPreview,
  DashboardWorkspaceHeader,
} from "../DashboardParts";
import type { ExpandedChart } from "../DashboardParts";
import { DashboardLegacyChart } from "./DashboardLegacyChart";
import type { DashboardLegacyModel } from "./dashboardLegacyModel";

export function DashboardLegacyBuilderView({
  activeSqlResult,
  builderWidgets,
  dataset,
  expandedChart,
  isPublished,
  model,
  onAddWidget,
  onBackToList,
  onCloseExpandedChart,
  onExport,
  onFullscreen,
  onOpenPreview,
  onOpenWidgetSettings,
  onPublish,
  onRemoveWidget,
  onSave,
  onSelectWidgetType,
  onShare,
  onViewPublished,
  selectedWidgetType,
}: {
  activeSqlResult: SqlResultDraft | null;
  builderWidgets: DashboardWidgetType[];
  dataset: CatalogDataset;
  expandedChart: ExpandedChart | null;
  isPublished: boolean;
  model: DashboardLegacyModel;
  onAddWidget: () => void;
  onBackToList: () => void;
  onCloseExpandedChart: () => void;
  onExport: () => void;
  onFullscreen: () => void;
  onOpenPreview: () => void;
  onOpenWidgetSettings: (type: DashboardWidgetType) => void;
  onPublish: () => void;
  onRemoveWidget: (index: number) => void;
  onSave: () => void;
  onSelectWidgetType: (type: DashboardWidgetType) => void;
  onShare: () => void;
  onViewPublished: () => void;
  selectedWidgetType: DashboardWidgetType;
}) {
  return (
    <div className="dashboard-page dashboard-builder-page">
      <DashboardWorkspaceHeader
        isPublished={isPublished}
        onBackToList={onBackToList}
        onExport={onExport}
        onFullscreen={onFullscreen}
        onPublish={onPublish}
        onSave={onSave}
        onShare={onShare}
        onViewPublished={onViewPublished}
        primaryTitle={isPublished ? "Published" : "Draft"}
        title={isPublished
          ? model.dashboardTitle
          : activeSqlResult
            ? `${activeSqlResult.datasetName} SQL Result Draft`
            : "SQL Result Dashboard Draft"}
      />
      <div className="dashboard-builder-layout">
        <aside className="dashboard-builder-side">
          <section>
            <h2>{activeSqlResult ? "SQL Result" : "Data"}</h2>
            <div className="dashboard-source-card">
              <Database size={18} />
              <strong>{activeSqlResult ? activeSqlResult.datasetName : dataset.name}</strong>
              <span>{activeSqlResult
                ? `${activeSqlResult.rowCount} result rows · ${activeSqlResult.columns.length} columns`
                : `${dataset.layer} · ${dataset.rows} rows`}</span>
            </div>
          </section>
          {activeSqlResult && (
            <section>
              <h2>Query source</h2>
              <div className="dashboard-field-map">
                <p><span>Run ID</span><strong>{activeSqlResult.runId}</strong></p>
                <p><span>Executed</span><strong>{new Date(activeSqlResult.executedAt).toLocaleTimeString()}</strong></p>
                <p><span>Columns</span><strong>{activeSqlResult.columns.slice(0, 3).join(", ")}</strong></p>
              </div>
            </section>
          )}
          <section>
            <h2>Untitled page</h2>
            <p>제목 없는 페이지</p>
          </section>
          <section>
            <h2>Widget type</h2>
            <div className="dashboard-widget-type-list">
              {model.widgetTypes.map((widget) => (
                <SelectableCard
                  className="dashboard-widget-type-card"
                  description={widget.desc}
                  key={widget.id}
                  selected={selectedWidgetType === widget.id}
                  title={widget.label}
                  onClick={() => onSelectWidgetType(widget.id)}
                />
              ))}
            </div>
          </section>
          <section>
            <h2>Field mapping</h2>
            <div className="dashboard-field-map">
              {model.widgetConfig[selectedWidgetType].fields.map(([label, value]) => (
                <p key={label}><span>{label}</span><strong>{value}</strong></p>
              ))}
            </div>
          </section>
        </aside>
        <main className={builderWidgets.length ? "dashboard-builder-canvas has-widgets" : "dashboard-builder-canvas"}>
          <PreviewPanel
            actions={<button type="button" onClick={onAddWidget}><Plus size={16} /></button>}
            className="dashboard-widget-preview-panel"
            description={activeSqlResult
              ? `${activeSqlResult.datasetName} · SQL result`
              : `${dataset.name} · ${dataset.layer} source`}
            eyebrow="WIDGET PREVIEW"
            headerClassName="dashboard-card-header"
            title={model.widgetConfig[selectedWidgetType].title}
          >
            <DashboardWidgetPreview
              columns={model.columns}
              rows={model.rowsPreview}
              type={selectedWidgetType}
            />
            <button className="primary-button" type="button" onClick={onAddWidget}><Plus size={16} /> 캔버스에 추가</button>
          </PreviewPanel>
          <section className="dashboard-canvas-draft">
            <div className="dashboard-card-header">
              <div>
                <span>DRAFT CANVAS</span>
                <h2>추가된 위젯</h2>
              </div>
              <button className="secondary-button" type="button" disabled={!builderWidgets.length} onClick={onOpenPreview}>대시보드 미리보기</button>
            </div>
            {builderWidgets.length === 0 ? (
              <div className="dashboard-empty-dropzone">
                <strong>아직 추가된 위젯이 없습니다.</strong>
                <span>왼쪽에서 유형과 필드를 확인한 뒤 캔버스에 추가하세요.</span>
              </div>
            ) : (
              <div className="dashboard-draft-widget-grid">
                {builderWidgets.map((type, index) => (
                  <article className="dashboard-draft-widget" key={`${type}-${index}`}>
                    <div>
                      <strong>{model.widgetConfig[type].title}</strong>
                      <span>{model.widgetTypes.find((widget) => widget.id === type)?.label} · {activeSqlResult ? activeSqlResult.datasetName : dataset.name}</span>
                    </div>
                    <DashboardWidgetPreview
                      columns={model.columns}
                      compact
                      rows={model.rowsPreview}
                      type={type}
                    />
                    <div className="dashboard-draft-actions">
                      <button type="button" onClick={() => onOpenWidgetSettings(type)}>설정</button>
                      <button type="button" onClick={() => onRemoveWidget(index)}>삭제</button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </main>
      </div>
      <DashboardFooterMeta />
      {expandedChart && (
        <DashboardChartModal chart={expandedChart} onClose={onCloseExpandedChart}>
          <DashboardLegacyChart expanded kind={expandedChart.kind} model={model} />
        </DashboardChartModal>
      )}
    </div>
  );
}
