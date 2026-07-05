import { useEffect, useState } from "react";
import {
  Database,
  Maximize2,
  Plus,
  Search,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  Table2,
} from "lucide-react";
import { DatasetStatusBadge } from "../catalog/CatalogPage";
import {
  DashboardChartCard,
  DashboardChartModal,
  DashboardDeleteModal,
  DashboardFooterMeta,
  DashboardWidgetPreview,
  DashboardWorkspaceHeader,
  defaultDashboardCards,
} from "./DashboardParts";
import type { ExpandedChart, SavedDashboardCard } from "./DashboardParts";
import type { AuditResult, CatalogDataset, DashboardEntry, DashboardView, DashboardWidgetType, SqlResultDraft } from "../../types";
import { dashboardStatusMeta, normalizeDashboardStatus } from "../../utils/statusMeta";

export function DashboardPage({ dataset, entry, sqlResult, onAction }: { dataset: CatalogDataset; entry: DashboardEntry; sqlResult: SqlResultDraft | null; onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void }) {
  const [view, setView] = useState<DashboardView>(entry.view);
  const [builderWidgets, setBuilderWidgets] = useState<DashboardWidgetType[]>([]);
  const [isPublished, setIsPublished] = useState(false);
  const [selectedWidgetType, setSelectedWidgetType] = useState<DashboardWidgetType>("bar");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [expandedChart, setExpandedChart] = useState<ExpandedChart | null>(null);
  const [period, setPeriod] = useState("최근 7일");
  const [segment, setSegment] = useState("전체 채널");
  const [savedDashboards, setSavedDashboards] = useState<SavedDashboardCard[]>(() => {
    const stored = window.localStorage.getItem("asklake.dashboardCards");
    if (!stored) return defaultDashboardCards;
    try {
      const cards = JSON.parse(stored) as SavedDashboardCard[];
      return cards.map((card) => ({ ...card, status: normalizeDashboardStatus(card.status) }));
    } catch {
      return defaultDashboardCards;
    }
  });
  const activeSqlResult = entry.source === "sql" && sqlResult?.datasetId === dataset.id ? sqlResult : null;
  const dashboardTitle = activeSqlResult ? `${activeSqlResult.datasetName} SQL Result Dashboard` : "Sales Analytics Demo 2026-06-26 22:04:05";
  const dashboardId = `dash_${dataset.id}_${activeSqlResult?.runId ?? "draft"}`;
  const sourceRunId = activeSqlResult?.runId;
  const dashboardColumns = activeSqlResult?.columns.length ? activeSqlResult.columns : dataset.schema.slice(0, 5).map(([column]) => column);
  const dashboardRowsPreview = activeSqlResult?.rows.length ? activeSqlResult.rows : dataset.sampleRows;
  const metricCards = [
    ["총 주문", "128,420", "+12.4%", "SQL 결과 기준"],
    ["매출", "₩8.2억", "+8.1%", "집계 mart 반영"],
    ["전환율", "4.8%", "-0.3%", "모바일 유입 감소"],
    ["품질 점수", dataset.quality, "안정", dataset.lastUpdated],
  ];
  const barSeries = [62, 84, 71, 96, 78, 88, 104];
  const channelRows = [
    ["Mobile", "62,140", "₩3.9억", "48.4%"],
    ["Web", "41,880", "₩2.7억", "32.6%"],
    ["Partner", "24,400", "₩1.6억", "19.0%"],
  ];
  const categorySales = [
    ["전자제품", 124500],
    ["의류", 93375],
    ["식료품", 62250],
    ["가구", 31125],
    ["취미용품", 68500],
  ];
  const widgetTypes: Array<{ id: DashboardWidgetType; label: string; desc: string }> = [
    { id: "kpi", label: "KPI", desc: "핵심 수치 카드" },
    { id: "bar", label: "막대 차트", desc: "카테고리 비교" },
    { id: "line", label: "라인 차트", desc: "시간 추이" },
    { id: "donut", label: "도넛 차트", desc: "비중 분포" },
    { id: "table", label: "결과 테이블", desc: "행 데이터" },
  ];
  const primaryColumn = dashboardColumns[0] ?? "id";
  const secondaryColumn = dashboardColumns[1] ?? primaryColumn;
  const metricColumn = dashboardColumns[2] ?? secondaryColumn;
  const widgetConfig: Record<DashboardWidgetType, { title: string; fields: Array<[string, string]> }> = {
    kpi: { title: `${metricColumn} KPI`, fields: [["Metric", metricColumn], ["Aggregation", "COUNT"], ["Format", "Number"]] },
    bar: { title: `${secondaryColumn}별 ${metricColumn}`, fields: [["X축", secondaryColumn], ["Y축", metricColumn], ["집계", "SUM"]] },
    line: { title: `${primaryColumn} 추이`, fields: [["X축", primaryColumn], ["Y축", metricColumn], ["Granularity", "Auto"]] },
    donut: { title: `${secondaryColumn} 비중`, fields: [["Dimension", secondaryColumn], ["Metric", metricColumn], ["Aggregation", "SUM"]] },
    table: { title: "SQL 결과 테이블", fields: [["Columns", dashboardColumns.slice(0, 4).join(", ")], ["Rows", String(activeSqlResult?.rowCount ?? dataset.sampleRows.length)], ["Sort", `${primaryColumn} ASC`]] },
  };
  const snapshotWidgets: DashboardWidgetType[] = builderWidgets.length ? builderWidgets : activeSqlResult ? ["table", "bar"] : ["bar", "line", "donut", "table"];
  const sqlResultSnapshot = activeSqlResult ? {
    columns: activeSqlResult.columns,
    query: activeSqlResult.query,
    rowCount: activeSqlResult.rowCount,
    runId: activeSqlResult.runId,
  } : undefined;

  useEffect(() => {
    setView(entry.view);
    if (entry.source === "sql" && sqlResult?.datasetId === dataset.id) {
      setBuilderWidgets(["table", "bar"]);
    }
    if (entry.view === "builder") {
      onAction(entry.source === "sql" ? "dashboard.builder.opened_from_sql" : "dashboard.builder.opened_from_catalog", "/api/dashboards/builder", dataset.id);
    }
  }, [dataset.id, entry.source, entry.version, entry.view, sqlResult?.datasetId]);

  useEffect(() => {
    window.localStorage.setItem("asklake.dashboardCards", JSON.stringify(savedDashboards));
  }, [savedDashboards]);

  const changeFilter = (nextPeriod: string, nextSegment = segment) => {
    setPeriod(nextPeriod);
    setSegment(nextSegment);
    onAction("dashboard.filter.changed", "/api/dashboards/filters", dataset.id);
  };

  const openBuilder = () => {
    setView("builder");
    onAction("dashboard.create_clicked", "/api/dashboards", dataset.id);
  };

  const backToList = () => {
    setView("list");
    onAction("dashboard.list_opened", "/api/dashboards", dataset.id);
  };

  const openDetail = (name = dashboardTitle) => {
    setView("detail");
    onAction("dashboard.opened", `/api/dashboards/${dashboardId}`, name);
  };

  const upsertDashboard = (status: SavedDashboardCard["status"]) => {
    const nextCard: SavedDashboardCard = {
      datasetId: dataset.id,
      id: dashboardId,
      meta: `${Math.max(builderWidgets.length, activeSqlResult ? 2 : 1)}개 위젯 · ${sourceRunId ? `sourceRunId ${sourceRunId}` : `${dataset.layer} source`}`,
      name: dashboardTitle,
      owner: dataset.owner,
      sourceRunId,
      sqlResult: sqlResultSnapshot,
      status,
      tags: activeSqlResult ? "SQL Result · Dashboard" : `${dataset.layer} · Dashboard`,
      updated: "방금 전",
      widgets: snapshotWidgets,
    };
    setSavedDashboards((cards) => [nextCard, ...cards.filter((card) => card.id !== nextCard.id)]);
    return nextCard;
  };

  const addWidgetToCanvas = () => {
    setBuilderWidgets((widgets) => [...widgets, selectedWidgetType]);
    onAction("dashboard.widget.added_to_canvas", "/api/dashboards/widgets", selectedWidgetType);
  };

  const removeBuilderWidget = (index: number) => {
    setBuilderWidgets((widgets) => widgets.filter((_, widgetIndex) => widgetIndex !== index));
    onAction("dashboard.widget.removed_from_canvas", "/api/dashboards/widgets", dataset.id);
  };

  const publishDashboard = () => {
    setIsPublished(true);
    upsertDashboard("published");
    onAction("dashboard.published", `/api/dashboards/${dashboardId}/publish`, dashboardId);
  };

  const saveDashboard = () => {
    upsertDashboard(isPublished ? "published" : "draft");
    onAction("dashboard.saved", `/api/dashboards/${dashboardId}`, dashboardId);
  };

  const shareDashboard = () => {
    const shareUrl = `${window.location.origin}/dashboards/${encodeURIComponent(dashboardTitle)}`;
    void navigator.clipboard?.writeText(shareUrl);
    onAction("dashboard.shared", "/api/dashboards/share", dataset.id);
  };

  const exportDashboard = () => {
    const payload = {
      datasetId: dataset.id,
      id: dashboardId,
      exportedAt: new Date().toISOString(),
      filters: { period, segment },
      sourceRunId,
      sqlResult: sqlResultSnapshot ?? null,
      status: isPublished ? "published" : "draft",
      title: dashboardTitle,
      widgets: snapshotWidgets,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${dashboardTitle.replace(/[^a-z0-9가-힣_-]+/gi, "_")}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    onAction("dashboard.exported", `/api/dashboards/${dashboardId}/export`, dashboardId);
  };

  const openDashboardFullscreen = () => {
    setExpandedChart({ kind: "category", subtitle: `${period} · ${segment}`, title: "대시보드 전체화면" });
    onAction("dashboard.fullscreen_opened", "/api/dashboards/fullscreen", dataset.id);
  };

  const openPublishedView = () => {
    setView("detail");
    onAction("dashboard.published_view_opened", `/api/dashboards/${dashboardId}/published`, dashboardId);
  };

  const requestDelete = (target: string) => {
    setDeleteTarget(target);
    onAction("dashboard.widget.delete_requested", "/api/dashboards/widgets", target);
  };

  const confirmDelete = () => {
    if (deleteTarget) onAction("dashboard.widget.deleted", "/api/dashboards/widgets", deleteTarget);
    setDeleteTarget(null);
  };

  const openExpandedChart = (kind: ExpandedChart["kind"], title: string, subtitle: string) => {
    setExpandedChart({ kind, subtitle, title });
    onAction("dashboard.chart.expanded", `/api/dashboards/charts/${kind}`, dataset.id);
  };

  const renderChart = (kind: ExpandedChart["kind"], expanded = false) => {
    if (kind === "category") {
      return (
        <div className={expanded ? "dashboard-category-chart expanded" : "dashboard-category-chart"}>
          <div className="dashboard-axis-labels">
            {["124500", "93375", "62250", "31125", "0"].map((label) => <span key={label}>{label}</span>)}
          </div>
          <div className="dashboard-category-bars">
            {categorySales.map(([label, value]) => (
              <span key={label} style={{ height: `${Math.max(28, Number(value) / (expanded ? 720 : 1200))}px` }}>
                <i>{label}</i>
              </span>
            ))}
          </div>
        </div>
      );
    }

    if (kind === "channels") {
      return (
        <div className={expanded ? "dashboard-donut-area expanded" : "dashboard-donut-area"}>
          <div className="dashboard-donut" />
          <div className="dashboard-channel-list">
            {channelRows.map(([name, orders, revenue, share]) => (
              <p key={name}><span>{name}</span><strong>{orders}</strong><em>{revenue}</em><small>{share}</small></p>
            ))}
          </div>
        </div>
      );
    }

    return (
      <div className={expanded ? "dashboard-bar-chart expanded" : "dashboard-bar-chart"} aria-label="일별 주문 막대 차트">
        {barSeries.map((value, index) => (
          <span key={value + index} style={{ height: `${Math.max(26, expanded ? value * 1.5 : value)}px` }}>
            <i>{["월", "화", "수", "목", "금", "토", "일"][index]}</i>
          </span>
        ))}
      </div>
    );
  };

  if (view === "list") {
    return (
      <div className="dashboard-page dashboard-list-page">
        <header className="dashboard-header">
          <div>
            <span>Dashboards</span>
            <h1>대시보드</h1>
            <p>SQL 쿼리와 데이터셋을 기반으로 위젯을 만들고 게시된 대시보드를 관리합니다.</p>
          </div>
          <div className="dashboard-header-actions">
            <button className="secondary-button" type="button" onClick={() => onAction("dashboard.list.filter_changed", "/api/dashboards/filters", "sample-gallery")}>샘플 갤러리 보기</button>
            <button className="primary-button" type="button" onClick={openBuilder}><Plus size={16} /> 대시보드 만들기</button>
          </div>
        </header>

        <section className="dashboard-intro-card">
          <div>
            <h2>대시보드 시작하기</h2>
            <p>Databricks 대시보드를 사용하여 데이터를 시각화하고 인사이트를 공유하세요. SQL 쿼리를 작성하여 위젯을 만들고 레이아웃을 자유롭게 조정할 수 있습니다.</p>
          </div>
          <button className="secondary-button" type="button" onClick={() => onAction("dashboard.docs_opened", "/api/dashboards/docs", "dashboard-docs")}>문서 더 보기</button>
        </section>

        <section className="dashboard-list-toolbar">
          {["최근 기록", "팀 활동", "모든 소유자", "태그 필터"].map((filter) => (
            <button key={filter} type="button" onClick={() => onAction("dashboard.list.filter_changed", "/api/dashboards/filters", filter)}>{filter}</button>
          ))}
          <div className="dashboard-list-search">
            <Search size={16} />
            <span>대시보드 검색...</span>
          </div>
        </section>

        <section className="dashboard-table-list">
          <div className="dashboard-list-count">전체 {savedDashboards.length}개 중 1-{savedDashboards.length}개 표시</div>
          <div className="dashboard-table-scroll">
            <table className="schema-table">
              <thead>
                <tr>
                  <th>이름</th>
                  <th>소유자</th>
                  <th>마지막 수정</th>
                  <th>작업</th>
                </tr>
              </thead>
              <tbody>
                {savedDashboards.map((dashboard) => (
                  <tr key={dashboard.id}>
                    <td>
                      <button className="dashboard-row-link" type="button" onClick={() => openDetail(dashboard.name)}>{dashboard.name}</button>
                      <span className="dashboard-row-tags">{dashboard.tags} · {dashboardStatusMeta[dashboard.status].label}</span>
                    </td>
                    <td>{dashboard.owner}</td>
                    <td>{dashboard.updated}</td>
                    <td><button className="ghost-link" type="button" onClick={() => openDetail(dashboard.name)}>게시된 대시보드 보기</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="dashboard-pagination">
            <button type="button" onClick={() => onAction("dashboard.list.page_previous", "/api/dashboards?page=previous", "dashboards")}>이전</button>
            <span>1</span>
            <button type="button" onClick={() => onAction("dashboard.list.page_next", "/api/dashboards?page=next", "dashboards")}>다음</button>
          </div>
        </section>
      </div>
    );
  }

  if (view === "builder") {
    return (
      <div className="dashboard-page dashboard-builder-page">
        <DashboardWorkspaceHeader
          isPublished={isPublished}
          onBackToList={backToList}
          onExport={exportDashboard}
          onFullscreen={openDashboardFullscreen}
          onPublish={publishDashboard}
          onSave={saveDashboard}
          onShare={shareDashboard}
          onViewPublished={openPublishedView}
          primaryTitle={isPublished ? "Published" : "Draft"}
          title={isPublished ? dashboardTitle : activeSqlResult ? `${activeSqlResult.datasetName} SQL Result Draft` : "SQL Result Dashboard Draft"}
        />
        <div className="dashboard-builder-layout">
          <aside className="dashboard-builder-side">
            <section>
              <h2>{activeSqlResult ? "SQL Result" : "Data"}</h2>
              <div className="dashboard-source-card">
                <Database size={18} />
                <strong>{activeSqlResult ? activeSqlResult.datasetName : dataset.name}</strong>
                <span>{activeSqlResult ? `${activeSqlResult.rowCount} result rows · ${activeSqlResult.columns.length} columns` : `${dataset.layer} · ${dataset.rows} rows`}</span>
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
                {widgetTypes.map((widget) => (
                  <button className={selectedWidgetType === widget.id ? "active" : ""} key={widget.id} type="button" onClick={() => {
                    setSelectedWidgetType(widget.id);
                    onAction("dashboard.widget.type_selected", "/api/dashboards/widgets/types", widget.id);
                  }}>
                    <strong>{widget.label}</strong>
                    <span>{widget.desc}</span>
                  </button>
                ))}
              </div>
            </section>
            <section>
              <h2>Field mapping</h2>
              <div className="dashboard-field-map">
                {widgetConfig[selectedWidgetType].fields.map(([label, value]) => (
                  <p key={label}><span>{label}</span><strong>{value}</strong></p>
                ))}
              </div>
            </section>
          </aside>
          <main className={builderWidgets.length ? "dashboard-builder-canvas has-widgets" : "dashboard-builder-canvas"}>
            <section className="dashboard-widget-preview-panel">
              <div className="dashboard-card-header">
                <div>
                  <span>WIDGET PREVIEW</span>
                  <h2>{widgetConfig[selectedWidgetType].title}</h2>
                  <p>{activeSqlResult ? `${activeSqlResult.datasetName} · SQL result` : `${dataset.name} · ${dataset.layer} source`}</p>
                </div>
                <button type="button" onClick={addWidgetToCanvas}><Plus size={16} /></button>
              </div>
              <DashboardWidgetPreview columns={dashboardColumns} rows={dashboardRowsPreview} type={selectedWidgetType} />
              <button className="primary-button" type="button" onClick={addWidgetToCanvas}><Plus size={16} /> 캔버스에 추가</button>
            </section>
            <section className="dashboard-canvas-draft">
              <div className="dashboard-card-header">
                <div>
                  <span>DRAFT CANVAS</span>
                  <h2>추가된 위젯</h2>
                </div>
                <button className="secondary-button" type="button" disabled={!builderWidgets.length} onClick={() => {
                  setView("detail");
                  onAction("dashboard.preview_opened", "/api/dashboards/preview", dataset.id);
                }}>대시보드 미리보기</button>
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
                        <strong>{widgetConfig[type].title}</strong>
                        <span>{widgetTypes.find((widget) => widget.id === type)?.label} · {activeSqlResult ? activeSqlResult.datasetName : dataset.name}</span>
                      </div>
                      <DashboardWidgetPreview columns={dashboardColumns} compact rows={dashboardRowsPreview} type={type} />
                      <div className="dashboard-draft-actions">
                        <button type="button" onClick={() => {
                          setSelectedWidgetType(type);
                          onAction("dashboard.widget.settings_opened", "/api/dashboards/widgets/settings", type);
                        }}>설정</button>
                        <button type="button" onClick={() => removeBuilderWidget(index)}>삭제</button>
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
          <DashboardChartModal chart={expandedChart} onClose={() => setExpandedChart(null)}>
            {renderChart(expandedChart.kind, true)}
          </DashboardChartModal>
        )}
      </div>
    );
  }

  return (
    <div className="dashboard-page dashboard-detail-page">
      <DashboardWorkspaceHeader
        isPublished={isPublished}
        onBackToList={backToList}
        onDraftEdit={() => {
          setView("builder");
          onAction("dashboard.draft_edit_opened", "/api/dashboards/draft", dataset.id);
        }}
        onExport={exportDashboard}
        onFullscreen={openDashboardFullscreen}
        onPublish={publishDashboard}
        onSave={saveDashboard}
        onShare={shareDashboard}
        onViewPublished={openPublishedView}
        primaryTitle={isPublished ? "Published" : "Draft"}
        title={dashboardTitle}
      />

      <section className="dashboard-publish-card">
        <div>
          <strong>팀원이나 외부 협업자와 대시보드를 공유하고 권한을 관리하세요.</strong>
          <span>링크가 있는 조직 내 모든 사용자가 이 대시보드를 볼 수 있습니다.</span>
        </div>
        <button className="secondary-button" type="button" onClick={shareDashboard}><Share2 size={16} /> Share</button>
      </section>

      <header className="dashboard-header compact">
        <div>
          <span>Dashboards</span>
          <h1>대시보드 개요</h1>
          <p>{activeSqlResult ? `${activeSqlResult.datasetName} SQL 결과 위젯을 배치한 게시용 대시보드입니다.` : `${dataset.name} 데이터셋과 SQL 결과 위젯을 함께 배치한 게시용 대시보드입니다.`}</p>
        </div>
      </header>

      <section className="dashboard-filter-bar">
        <div className="dashboard-filter-title">
          <SlidersHorizontal size={16} />
          <strong>필터</strong>
        </div>
        <div className="dashboard-segmented">
          {["오늘", "최근 7일", "최근 30일"].map((item) => (
            <button className={period === item ? "active" : ""} key={item} type="button" onClick={() => changeFilter(item)}>{item}</button>
          ))}
        </div>
        <label>
          <span>채널</span>
          <select value={segment} onChange={(event) => changeFilter(period, event.target.value)}>
            <option>전체 채널</option>
            <option>Mobile</option>
            <option>Web</option>
            <option>Partner</option>
          </select>
        </label>
        <button className="secondary-button" type="button" onClick={() => {
          setBuilderWidgets([]);
          setIsPublished(false);
          setView("builder");
          onAction("dashboard.created", "/api/dashboards", dataset.id);
        }}><Plus size={16} /> 새 대시보드</button>
      </section>

      <section className="dashboard-metric-grid">
        {metricCards.map(([label, value, delta, note]) => (
          <article className="dashboard-metric-card" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <div>
              <em className={delta.startsWith("-") ? "down" : ""}>{delta}</em>
              <small>{note}</small>
            </div>
          </article>
        ))}
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
                <button type="button" onClick={() => openExpandedChart("category", "카테고리별 매출 (KRW)", "전자제품 · 의류 · 식료품 · 가구 · 취미용품")}><Maximize2 size={16} /></button>
                <button type="button" onClick={() => requestDelete("category-sales")}>삭제</button>
              </div>
            </div>
            {renderChart("category")}
          </section>

          <DashboardChartCard title="일별 주문/매출 추이" subtitle={`${period} · ${segment}`} onOpen={() => openExpandedChart("orders", "일별 주문/매출 추이", `${period} · ${segment}`)}>
            {renderChart("orders")}
          </DashboardChartCard>

          <DashboardChartCard title="채널별 성과" subtitle="주문수 · 매출 · 비중" onOpen={() => openExpandedChart("channels", "채널별 성과", "주문수 · 매출 · 비중")}>
            {renderChart("channels")}
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
                <thead><tr>{dashboardColumns.slice(0, 5).map((column, index) => <th key={`${column}-${index}`}>{column}</th>)}</tr></thead>
                <tbody>{dashboardRowsPreview.map((row, rowIndex) => <tr key={`dashboard-row-${rowIndex}`}>{row.slice(0, 5).map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{cell}</td>)}</tr>)}</tbody>
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
            {savedDashboards.slice(0, 3).map((dashboard) => (
              <button key={dashboard.id} type="button" onClick={() => openDetail(dashboard.name)}>
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
        <DashboardChartModal chart={expandedChart} onClose={() => setExpandedChart(null)}>
          {renderChart(expandedChart.kind, true)}
        </DashboardChartModal>
      )}
      {deleteTarget && <DashboardDeleteModal onCancel={() => setDeleteTarget(null)} onDelete={confirmDelete} />}
    </div>
  );
}
