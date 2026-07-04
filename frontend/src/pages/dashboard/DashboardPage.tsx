import { useEffect, useMemo, useState } from "react";
import type { LayoutItem } from "react-grid-layout";
import {
  Database,
  Maximize2,
  Plus,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  Table2,
} from "lucide-react";
import { DatasetStatusBadge } from "../catalog/CatalogPage";
import { DashboardCanvas } from "./runtime/DashboardCanvas";
import { DatasetSidebar } from "./runtime/DatasetSidebar";
import { EmptyDashboardCanvas } from "./runtime/EmptyDashboardCanvas";
import { DashboardRuntimeShell } from "./runtime/DashboardRuntimeShell";
import { WidgetFrame } from "./runtime/WidgetFrame";
import { WidgetConfigPanel } from "./runtime/WidgetConfigPanel";
import { useDashboardDatasets } from "./runtime/useDashboardDatasets";
import type { CreateDraftWidgetFormInput } from "./runtime/dashboardRuntimeTypes";
import {
  DashboardChartCard,
  DashboardChartModal,
  DashboardDeleteModal,
  DashboardFooterMeta,
  DashboardWidgetPreview,
  DashboardWorkspaceHeader,
} from "./DashboardParts";
import { DashboardLandingPage } from "./DashboardLandingPage";
import type { ExpandedChart } from "./DashboardParts";
import { defaultDashboardCards } from "./dashboardListData";
import {
  formatDashboardTimestamp,
  hydrateSavedDashboardCards,
  normalizeSavedDashboardCard,
} from "./dashboardListUtils";
import { useDashboardLandingList } from "./useDashboardLandingList";
import {
  createDraftPage,
  createDraftWidget,
  deleteDraftPage,
  ensureDraftDashboard,
  getPublishedDashboard,
  publishDashboard as publishRuntimeDashboard,
  saveDraftLayouts,
} from "../../services/dashboardRuntimeApi";
import { deleteDashboard } from "../../services/dashboardApi";
import { saveDashboardCard } from "../../services/mockApi";
import { ApiError } from "../../types";
import type { AuditResult, CatalogDataset, DashboardEntry, DashboardRuntimeMode, DashboardRuntimeResponse, DashboardRuntimeWidget, DashboardRuntimeWidgetType, DashboardView, DashboardWidgetLayout, DashboardWidgetType, SavedDashboardCard, SqlResultDraft } from "../../types";
import { dashboardStatusMeta } from "../../utils/statusMeta";

const defaultRuntimePages = [
  { id: "page-1", title: "Untitled page" },
  { id: "page-2", title: "제목 없는 페이지" },
];

type RuntimePage = {
  id: string;
  title: string;
};

type RuntimeNotice = {
  message: string;
  tone: "success" | "info" | "error";
};

const draftWidgetLabels: Record<DashboardRuntimeWidgetType, string> = {
  bar_chart: "막대 차트",
  donut_chart: "도넛 차트",
  line_chart: "라인 차트",
  metric: "지표",
  table: "테이블",
};

const defaultDraftWidgetLayout: Record<DashboardRuntimeWidgetType, DashboardWidgetLayout> = {
  bar_chart: { h: 5, minH: 3, minW: 3, w: 6, x: 0, y: 0 },
  donut_chart: { h: 5, minH: 3, minW: 3, w: 4, x: 0, y: 0 },
  line_chart: { h: 5, minH: 3, minW: 3, w: 6, x: 0, y: 0 },
  metric: { h: 3, minH: 2, minW: 2, w: 3, x: 0, y: 0 },
  table: { h: 5, minH: 3, minW: 4, w: 9, x: 0, y: 0 },
};

const draftWidgetPalette: DashboardRuntimeWidgetType[] = ["metric", "bar_chart", "line_chart", "donut_chart", "table"];

export function DashboardPage({
  dataset,
  entry,
  sqlResult,
  onAction,
  onRuntimeNavigate,
}: {
  dataset: CatalogDataset;
  entry: DashboardEntry;
  sqlResult: SqlResultDraft | null;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onRuntimeNavigate?: (dashboardId: string, mode: DashboardRuntimeMode) => void;
}) {
  const [view, setView] = useState<DashboardView>(entry.view);
  const [builderWidgets, setBuilderWidgets] = useState<DashboardWidgetType[]>([]);
  const [isPublished, setIsPublished] = useState(false);
  const [selectedWidgetType, setSelectedWidgetType] = useState<DashboardWidgetType>("bar");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [dashboardDeleteTarget, setDashboardDeleteTarget] = useState<SavedDashboardCard | null>(null);
  const [dashboardDeleteError, setDashboardDeleteError] = useState<string | null>(null);
  const [deletingDashboardId, setDeletingDashboardId] = useState<string | null>(null);
  const [expandedChart, setExpandedChart] = useState<ExpandedChart | null>(null);
  const [period, setPeriod] = useState("최근 7일");
  const [segment, setSegment] = useState("전체 채널");
  const [runtimeSelection, setRuntimeSelection] = useState<{ dashboardId: string; mode: DashboardRuntimeMode }>(() => ({
    dashboardId: entry.dashboardId ?? "dash_sales_demo",
    mode: entry.runtimeMode ?? "published",
  }));
  const [publishedRuntime, setPublishedRuntime] = useState<DashboardRuntimeResponse | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [draftRuntime, setDraftRuntime] = useState<DashboardRuntimeResponse | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [dashboardListRefreshKey, setDashboardListRefreshKey] = useState(0);
  const [isAddingRuntimePage, setIsAddingRuntimePage] = useState(false);
  const [isCreatingDatasetWidget, setIsCreatingDatasetWidget] = useState(false);
  const [isPublishingRuntime, setIsPublishingRuntime] = useState(false);
  const [isRefreshingRuntime, setIsRefreshingRuntime] = useState(false);
  const [runtimeNotice, setRuntimeNotice] = useState<RuntimeNotice | null>(null);
  const [runtimeShareLink, setRuntimeShareLink] = useState<string | null>(null);
  const [isDatasetSidebarOpen, setIsDatasetSidebarOpen] = useState(true);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);
  const [selectedWidgetId, setSelectedWidgetId] = useState<string | null>(null);
  const [selectedRuntimePageId, setSelectedRuntimePageId] = useState<string | null>(defaultRuntimePages[0].id);
  const [selectedDashboard, setSelectedDashboard] = useState<SavedDashboardCard | null>(null);
  const [savedDashboards, setSavedDashboards] = useState<SavedDashboardCard[]>(() => {
    const stored = window.localStorage.getItem("asklake.dashboardCards");
    if (!stored) return defaultDashboardCards;
    try {
      const cards = JSON.parse(stored) as SavedDashboardCard[];
      return hydrateSavedDashboardCards(cards);
    } catch {
      return defaultDashboardCards;
    }
  });
  const dashboardList = useDashboardLandingList(savedDashboards, onAction, entry.version + dashboardListRefreshKey);
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
  const sidebarDashboards = dashboardList.visibleDashboards.length ? dashboardList.visibleDashboards : savedDashboards;
  const activeDashboardId = selectedDashboard?.id ?? dashboardId;
  const activeDashboardTitle = selectedDashboard?.name ?? dashboardTitle;
  const activeDashboardWidgets = selectedDashboard?.widgets?.length ? selectedDashboard.widgets : snapshotWidgets;
  const {
    datasets: dashboardDatasets,
    error: dashboardDatasetsError,
    isLoading: dashboardDatasetsLoading,
  } = useDashboardDatasets();
  const selectedDataset = useMemo(
    () => dashboardDatasets.find((datasetOption) => datasetOption.id === selectedDatasetId) ?? null,
    [dashboardDatasets, selectedDatasetId],
  );
  const runtimeDashboards = [...dashboardList.visibleDashboards, ...savedDashboards];
  const runtimeDashboard = runtimeDashboards.find((dashboard) => dashboard.id === runtimeSelection.dashboardId);
  const runtimeTitle = runtimeSelection.mode === "published"
    ? publishedRuntime?.dashboard.title ?? runtimeDashboard?.name ?? runtimeSelection.dashboardId
    : draftRuntime?.dashboard.title ?? runtimeDashboard?.name ?? runtimeSelection.dashboardId;
  const runtimePages = runtimeSelection.mode === "published"
    ? (publishedRuntime?.pages ?? [])
    : (draftRuntime?.pages ?? []);
  const runtimeHasPublishedRevision = runtimeSelection.mode === "published"
    ? publishedRuntime?.dashboard.hasPublishedRevision ?? runtimeDashboard?.hasPublishedRevision ?? runtimeDashboard?.status === "published"
    : draftRuntime?.dashboard.hasPublishedRevision ?? runtimeDashboard?.hasPublishedRevision ?? runtimeDashboard?.status === "published";
  const selectedDraftWidgets = useMemo(
    () => runtimeSelection.mode === "draft" && selectedRuntimePageId
      ? draftRuntime?.widgetsByPageId[selectedRuntimePageId] ?? []
      : [],
    [draftRuntime?.widgetsByPageId, runtimeSelection.mode, selectedRuntimePageId],
  );
  const selectedPublishedWidgets = useMemo(
    () => runtimeSelection.mode === "published" && selectedRuntimePageId && publishedRuntime?.revision
      ? publishedRuntime.widgetsByPageId[selectedRuntimePageId] ?? []
      : [],
    [publishedRuntime?.revision, publishedRuntime?.widgetsByPageId, runtimeSelection.mode, selectedRuntimePageId],
  );

  useEffect(() => {
    if (!selectedDatasetId) return;
    if (dashboardDatasets.some((datasetOption) => datasetOption.id === selectedDatasetId)) return;
    setSelectedDatasetId(null);
  }, [dashboardDatasets, selectedDatasetId]);

  const selectRuntimePageFromResponse = (runtime: DashboardRuntimeResponse) => {
    const requestedPageId = new URLSearchParams(window.location.search).get("page");
    const requestedPageExists = requestedPageId && runtime.pages.some((page) => page.id === requestedPageId);
    const fallbackPageId = requestedPageExists ? requestedPageId : runtime.pages[0]?.id ?? null;

    setSelectedRuntimePageId((currentPageId) => {
      if (currentPageId && runtime.pages.some((page) => page.id === currentPageId)) {
        return currentPageId;
      }
      return fallbackPageId;
    });
  };

  const loadPublishedRuntime = async (nextDashboardId: string) => {
    setRuntimeLoading(true);
    setRuntimeError(null);
    try {
      const runtime = await getPublishedDashboard(nextDashboardId);
      setPublishedRuntime(runtime);
      selectRuntimePageFromResponse(runtime);
      return runtime;
    } catch (error) {
      setPublishedRuntime(null);
      setRuntimeError(error instanceof Error ? error.message : "Failed to load the published dashboard.");
      return null;
    } finally {
      setRuntimeLoading(false);
    }
  };

  const loadDraftRuntime = async (nextDashboardId: string) => {
    setDraftLoading(true);
    setDraftError(null);
    try {
      const runtime = await ensureDraftDashboard(nextDashboardId);
      setDraftRuntime(runtime);
      selectRuntimePageFromResponse(runtime);
      return runtime;
    } catch (error) {
      setDraftRuntime(null);
      setDraftError(error instanceof Error ? error.message : "Failed to load the draft dashboard.");
      return null;
    } finally {
      setDraftLoading(false);
    }
  };

  useEffect(() => {
    setView(entry.view);
    if (entry.view === "runtime" && entry.dashboardId) {
      setRuntimeSelection({
        dashboardId: entry.dashboardId,
        mode: entry.runtimeMode ?? "published",
      });
    }
    if (entry.view !== "detail") setSelectedDashboard(null);
    if (entry.source === "sql" && sqlResult?.datasetId === dataset.id) {
      setBuilderWidgets(["table", "bar"]);
    }
    if (entry.view === "builder") {
      onAction(entry.source === "sql" ? "dashboard.builder.opened_from_sql" : "dashboard.builder.opened_from_catalog", "/api/dashboards/builder", dataset.id);
    }
  }, [dataset.id, entry.dashboardId, entry.runtimeMode, entry.source, entry.version, entry.view, sqlResult?.datasetId]);

  useEffect(() => {
    if (view !== "runtime" || runtimeSelection.mode !== "published") {
      setRuntimeError(null);
      setRuntimeLoading(false);
      return;
    }

    void loadPublishedRuntime(runtimeSelection.dashboardId);
  }, [runtimeSelection.dashboardId, runtimeSelection.mode, view]);

  useEffect(() => {
    if (view !== "runtime" || runtimeSelection.mode !== "draft") {
      setDraftError(null);
      setDraftLoading(false);
      return;
    }

    void loadDraftRuntime(runtimeSelection.dashboardId);
  }, [runtimeSelection.dashboardId, runtimeSelection.mode, view]);

  useEffect(() => {
    if (view !== "runtime") return;
    if (!runtimePages.some((page) => page.id === selectedRuntimePageId)) {
      setSelectedRuntimePageId(runtimePages[0]?.id ?? null);
    }
  }, [runtimePages, selectedRuntimePageId, view]);

  useEffect(() => {
    setSelectedWidgetId(null);
  }, [selectedRuntimePageId]);

  useEffect(() => {
    window.localStorage.setItem("asklake.dashboardCards", JSON.stringify(savedDashboards));
  }, [savedDashboards]);

  useEffect(() => {
    if (!runtimeNotice) return undefined;
    const timeoutId = window.setTimeout(() => setRuntimeNotice(null), 3200);
    return () => window.clearTimeout(timeoutId);
  }, [runtimeNotice]);

  const updateRuntimeListStatus = (nextDashboardId: string, status: SavedDashboardCard["status"]) => {
    const now = new Date();
    setSavedDashboards((cards) => cards.map((card) => card.id === nextDashboardId
      ? normalizeSavedDashboardCard({
        ...card,
        hasPublishedRevision: status === "published" || card.hasPublishedRevision,
        status,
        updated: "방금 전",
        updatedAtValue: now.toISOString(),
      })
      : card));
    setDashboardListRefreshKey((key) => key + 1);
  };

  const changeFilter = (nextPeriod: string, nextSegment = segment) => {
    setPeriod(nextPeriod);
    setSegment(nextSegment);
    onAction("dashboard.filter.changed", "/api/dashboards/filters", dataset.id);
  };

  const openBuilder = () => {
    setSelectedDashboard(null);
    setView("builder");
    onAction("dashboard.create_clicked", "/api/dashboards", dataset.id);
  };

  const backToList = () => {
    setSelectedDashboard(null);
    setView("list");
    onAction("dashboard.list_opened", "/api/dashboards", dataset.id);
  };

  const openDetail = (dashboard?: SavedDashboardCard) => {
    if (dashboard) setSelectedDashboard(dashboard);
    setView("detail");
    onAction("dashboard.opened", `/api/dashboards/${dashboard?.id ?? activeDashboardId}`, dashboard?.name ?? activeDashboardTitle);
  };

  const openRuntimeDashboard = (nextDashboardId: string, mode: DashboardRuntimeMode) => {
    setRuntimeSelection({ dashboardId: nextDashboardId, mode });
    setView("runtime");
    onAction(
      mode === "published" ? "dashboard.runtime.published_opened" : "dashboard.runtime.draft_opened",
      mode === "published" ? `/api/dashboards/${nextDashboardId}/published` : `/api/dashboards/${nextDashboardId}/draft/ensure`,
      nextDashboardId,
    );
    onRuntimeNavigate?.(nextDashboardId, mode);
  };

  const openDashboardFromList = (dashboard: SavedDashboardCard) => {
    openRuntimeDashboard(dashboard.id, dashboard.status === "published" ? "published" : "draft");
  };

  const upsertDashboard = async (status: SavedDashboardCard["status"]) => {
    const existingCard = savedDashboards.find((card) => card.id === dashboardId);
    const now = new Date();
    const nextCard: SavedDashboardCard = {
      createdAt: existingCard?.createdAt ?? formatDashboardTimestamp(now),
      createdAtValue: existingCard?.createdAtValue ?? now.toISOString(),
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
      updatedAtValue: now.toISOString(),
      widgets: snapshotWidgets,
    };
    const optimisticCard = normalizeSavedDashboardCard(nextCard);
    setSavedDashboards((cards) => [optimisticCard, ...cards.filter((card) => card.id !== optimisticCard.id)]);

    try {
      const savedCard = normalizeSavedDashboardCard(await saveDashboardCard(optimisticCard));
      setSavedDashboards((cards) => [savedCard, ...cards.filter((card) => card.id !== savedCard.id)]);
      return savedCard;
    } catch {
      return optimisticCard;
    }
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
    void upsertDashboard("published");
    onAction("dashboard.published", `/api/dashboards/${dashboardId}/publish`, dashboardId);
  };

  const saveDashboard = () => {
    void upsertDashboard(isPublished ? "published" : "draft");
    onAction("dashboard.saved", `/api/dashboards/${dashboardId}`, dashboardId);
  };

  const shareDashboard = () => {
    const shareUrl = `${window.location.origin}/dashboards/${encodeURIComponent(activeDashboardId)}`;
    void navigator.clipboard?.writeText(shareUrl);
    onAction("dashboard.shared", "/api/dashboards/share", activeDashboardId);
  };

  const addRuntimePage = async () => {
    if (runtimeSelection.mode !== "draft" || isAddingRuntimePage) return;
    const nextPageNumber = (draftRuntime?.pages.length ?? 0) + 1;
    const title = nextPageNumber > 1 ? `제목 없는 페이지 ${nextPageNumber}` : "제목 없는 페이지";
    setIsAddingRuntimePage(true);
    setDraftError(null);
    setRuntimeNotice({ message: "페이지를 추가하는 중입니다.", tone: "info" });
    try {
      const page = await createDraftPage(runtimeSelection.dashboardId, { title });
      setSelectedRuntimePageId(page.id);
      await loadDraftRuntime(runtimeSelection.dashboardId);
      setRuntimeNotice({ message: `${page.title} 페이지를 추가했습니다.`, tone: "success" });
      onAction("dashboard.page.added", `/api/dashboards/${runtimeSelection.dashboardId}/draft/pages`, runtimeSelection.dashboardId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create a draft page.";
      setDraftError(message);
      setRuntimeNotice({ message: `페이지를 추가하지 못했습니다. ${message}`, tone: "error" });
    } finally {
      setIsAddingRuntimePage(false);
    }
  };

  const deleteRuntimePage = async (pageId: string) => {
    if (runtimeSelection.mode !== "draft") return;
    try {
      await deleteDraftPage(runtimeSelection.dashboardId, pageId);
      if (selectedRuntimePageId === pageId) {
        setSelectedRuntimePageId(null);
      }
      setSelectedWidgetId(null);
      await loadDraftRuntime(runtimeSelection.dashboardId);
      onAction("dashboard.page.deleted", `/api/dashboards/${runtimeSelection.dashboardId}/draft/pages/${pageId}`, runtimeSelection.dashboardId);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "Failed to delete a draft page.");
    }
  };

  const refreshRuntimeDashboard = async () => {
    setIsRefreshingRuntime(true);
    const runtime = runtimeSelection.mode === "published"
      ? await loadPublishedRuntime(runtimeSelection.dashboardId)
      : await loadDraftRuntime(runtimeSelection.dashboardId);
    setIsRefreshingRuntime(false);
    setRuntimeNotice(runtime
      ? { message: "대시보드를 새로고침했습니다.", tone: "info" }
      : { message: "대시보드를 새로고침하지 못했습니다.", tone: "error" });
    onAction("dashboard.runtime.refreshed", `/api/dashboards/${runtimeSelection.dashboardId}`, runtimeSelection.dashboardId);
  };

  const shareRuntimeDashboard = () => {
    const path = runtimeHasPublishedRevision ? `/dashboards/${runtimeSelection.dashboardId}` : `/dashboards/${runtimeSelection.dashboardId}/edit`;
    const shareUrl = `${window.location.origin}${path}`;
    setRuntimeShareLink(shareUrl);
    void navigator.clipboard?.writeText(shareUrl)
      .then(() => setRuntimeNotice({ message: "공유 링크를 복사했습니다.", tone: "success" }))
      .catch(() => setRuntimeNotice({ message: "링크가 준비되었습니다. 패널에서 복사할 수 있습니다.", tone: "info" }));
    onAction("dashboard.runtime.shared", path, runtimeSelection.dashboardId);
  };

  const publishDraftRuntime = async () => {
    if (runtimeSelection.mode !== "draft" || isPublishingRuntime) return;
    setIsPublishingRuntime(true);
    setDraftError(null);
    try {
      await publishRuntimeDashboard(runtimeSelection.dashboardId);
      updateRuntimeListStatus(runtimeSelection.dashboardId, "published");
      setRuntimeNotice({ message: "대시보드를 게시했습니다.", tone: "success" });
      setRuntimeShareLink(null);
      onAction("dashboard.runtime.published", `/api/dashboards/${runtimeSelection.dashboardId}/publish`, runtimeSelection.dashboardId);
      openRuntimeDashboard(runtimeSelection.dashboardId, "published");
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "Failed to publish the draft dashboard.");
      setRuntimeNotice({ message: "대시보드를 게시하지 못했습니다.", tone: "error" });
    } finally {
      setIsPublishingRuntime(false);
    }
  };

  const addDraftWidget = async (type: DashboardRuntimeWidgetType) => {
    if (runtimeSelection.mode !== "draft" || !selectedRuntimePageId) return;
    const nextY = selectedDraftWidgets.reduce((bottom, widget) => Math.max(bottom, widget.layout.y + widget.layout.h), 0);
    const layout = {
      ...defaultDraftWidgetLayout[type],
      y: nextY,
    };

    try {
      const widget = await createDraftWidget(runtimeSelection.dashboardId, selectedRuntimePageId, {
        layout,
        title: draftWidgetLabels[type],
        type,
      });
      await loadDraftRuntime(runtimeSelection.dashboardId);
      setSelectedWidgetId(widget.id);
      onAction("dashboard.widget.added", `/api/dashboards/${runtimeSelection.dashboardId}/draft/pages/${selectedRuntimePageId}/widgets`, type);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "Failed to create a draft widget.");
    }
  };

  const addDatasetDraftWidget = async (input: CreateDraftWidgetFormInput) => {
    if (runtimeSelection.mode !== "draft" || !selectedRuntimePageId || isCreatingDatasetWidget) return;
    const nextY = selectedDraftWidgets.reduce((bottom, widget) => Math.max(bottom, widget.layout.y + widget.layout.h), 0);
    const layout = {
      ...defaultDraftWidgetLayout[input.type],
      y: nextY,
    };

    setIsCreatingDatasetWidget(true);
    setDraftError(null);
    try {
      const widget = await createDraftWidget(runtimeSelection.dashboardId, selectedRuntimePageId, {
        datasetId: input.datasetId,
        layout,
        title: input.title,
        type: input.type,
        config: {
          color: input.color,
          description: input.description,
          xKey: input.xKey,
          yKey: input.yKey,
        },
      });
      await loadDraftRuntime(runtimeSelection.dashboardId);
      setSelectedWidgetId(widget.id);
      setRuntimeNotice({ message: "데이터셋 기반 위젯을 추가했습니다.", tone: "success" });
      onAction("dashboard.widget.dataset_added", `/api/dashboards/${runtimeSelection.dashboardId}/draft/pages/${selectedRuntimePageId}/widgets`, input.datasetId);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "Failed to create a dataset widget.");
      setRuntimeNotice({ message: "데이터셋 기반 위젯을 추가하지 못했습니다.", tone: "error" });
    } finally {
      setIsCreatingDatasetWidget(false);
    }
  };

  const updateDraftWidgetLayouts = (layout: LayoutItem[]) => {
    if (!selectedRuntimePageId) return;
    const layoutByWidgetId = new Map(layout.map((item) => [item.i, item]));

    setDraftRuntime((currentRuntime) => {
      if (!currentRuntime) return currentRuntime;
      const widgets = currentRuntime.widgetsByPageId[selectedRuntimePageId] ?? [];
      return {
        ...currentRuntime,
        widgetsByPageId: {
          ...currentRuntime.widgetsByPageId,
          [selectedRuntimePageId]: widgets.map((widget) => {
            const nextLayout = layoutByWidgetId.get(widget.id);
            if (!nextLayout) return widget;
            return {
              ...widget,
              layout: {
                ...widget.layout,
                h: nextLayout.h,
                minH: widget.layout.minH,
                minW: widget.layout.minW,
                w: nextLayout.w,
                x: nextLayout.x,
                y: nextLayout.y,
              },
            };
          }),
        },
      };
    });

    void saveDraftLayouts(runtimeSelection.dashboardId, {
      layouts: layout.map((item) => ({
        h: item.h,
        w: item.w,
        widgetId: item.i,
        x: item.x,
        y: item.y,
      })),
      pageId: selectedRuntimePageId,
    }).catch((error) => {
      setDraftError(error instanceof Error ? error.message : "Failed to save widget layout.");
    });
    onAction("dashboard.layout.saved", `/api/dashboards/${runtimeSelection.dashboardId}/draft/layouts`, selectedRuntimePageId);
  };

  const exportDashboard = () => {
    const payload = {
      datasetId: selectedDashboard?.datasetId ?? dataset.id,
      id: activeDashboardId,
      exportedAt: new Date().toISOString(),
      filters: { period, segment },
      sourceRunId,
      sqlResult: sqlResultSnapshot ?? null,
      status: selectedDashboard?.status ?? (isPublished ? "published" : "draft"),
      title: activeDashboardTitle,
      widgets: activeDashboardWidgets,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${activeDashboardTitle.replace(/[^a-z0-9가-힣_-]+/gi, "_")}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    onAction("dashboard.exported", `/api/dashboards/${activeDashboardId}/export`, activeDashboardId);
  };

  const openDashboardFullscreen = () => {
    setExpandedChart({ kind: "category", subtitle: `${period} · ${segment}`, title: "대시보드 전체화면" });
    onAction("dashboard.fullscreen_opened", "/api/dashboards/fullscreen", dataset.id);
  };

  const openPublishedView = () => {
    setView("detail");
    onAction("dashboard.published_view_opened", `/api/dashboards/${activeDashboardId}/published`, activeDashboardId);
  };

  const requestDashboardDelete = (dashboard: SavedDashboardCard) => {
    setDashboardDeleteTarget(dashboard);
    setDashboardDeleteError(null);
    onAction("dashboard.delete_requested", `/api/dashboards/${dashboard.id}`, dashboard.id);
  };

  const cancelDashboardDelete = () => {
    if (deletingDashboardId) return;
    setDashboardDeleteTarget(null);
    setDashboardDeleteError(null);
  };

  const confirmDashboardDelete = async () => {
    const target = dashboardDeleteTarget;
    if (!target) return;

    setDeletingDashboardId(target.id);
    setDashboardDeleteError(null);
    try {
      await deleteDashboard(target.id);
      setSavedDashboards((cards) => cards.filter((card) => card.id !== target.id));
      if (selectedDashboard?.id === target.id) setSelectedDashboard(null);
      dashboardList.reloadDashboards();
      setDashboardDeleteTarget(null);
      onAction("dashboard.deleted", `/api/dashboards/${target.id}`, target.id);
    } catch (error) {
      const message = error instanceof ApiError && error.status === 403
        ? "삭제 권한이 없습니다."
        : "대시보드 삭제에 실패했습니다. API 서버와 DB 상태를 확인해 주세요.";
      setDashboardDeleteError(message);
      onAction("dashboard.delete_failed", `/api/dashboards/${target.id}`, target.id, "failed");
    } finally {
      setDeletingDashboardId(null);
    }
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
      <DashboardLandingPage
        currentPage={dashboardList.safeDashboardPage}
        dashboardCount={dashboardList.dashboardCount}
        deleteError={dashboardDeleteError}
        deleteTarget={dashboardDeleteTarget}
        deletingDashboardId={deletingDashboardId}
        dashboards={dashboardList.visibleDashboards}
        error={dashboardList.dashboardError}
        isLoading={dashboardList.dashboardLoading}
        onCancelDelete={cancelDashboardDelete}
        onClearTags={dashboardList.clearDashboardTags}
        onConfirmDelete={confirmDashboardDelete}
        onCreateDashboard={openBuilder}
        onNextPage={dashboardList.goToNextDashboardPage}
        onOpenDashboard={openDashboardFromList}
        onPreviousPage={dashboardList.goToPreviousDashboardPage}
        onRequestDelete={requestDashboardDelete}
        onSearchQueryChange={dashboardList.setSearchQuery}
        onSelectOwner={dashboardList.selectDashboardOwner}
        onSelectSort={dashboardList.selectDashboardSort}
        onToggleControl={dashboardList.toggleDashboardListControl}
        onToggleTag={dashboardList.toggleDashboardTag}
        openControl={dashboardList.openListControl}
        ownerFilter={dashboardList.ownerFilter}
        owners={dashboardList.dashboardOwners}
        pageEnd={dashboardList.dashboardPageEnd}
        pageStart={dashboardList.dashboardPageStart}
        searchQuery={dashboardList.searchQuery}
        selectedTags={dashboardList.selectedTags}
        sortOption={dashboardList.sortOption}
        tags={dashboardList.dashboardTags}
        totalPages={dashboardList.totalDashboardPages}
      />
    );
  }

  if (view === "runtime") {
    const isDraftMode = runtimeSelection.mode === "draft";
    const openDraftAction = (
      <button className="asklake-dashboard-empty-action" type="button" onClick={() => openRuntimeDashboard(runtimeSelection.dashboardId, "draft")}>
        초안 편집
      </button>
    );
    const retryAction = (
      <button className="asklake-dashboard-empty-action" type="button" onClick={() => void loadPublishedRuntime(runtimeSelection.dashboardId)}>
        다시 시도
      </button>
    );
    const draftRetryAction = (
      <button className="asklake-dashboard-empty-action" type="button" onClick={() => void loadDraftRuntime(runtimeSelection.dashboardId)}>
        다시 시도
      </button>
    );
    const runtimeCanvas = isDraftMode ? (
      draftLoading ? (
        <div className="asklake-dashboard-empty-canvas edit">
          <EmptyDashboardCanvas
            editable
            title="초안 대시보드를 불러오는 중입니다"
            description="초안 revision, 페이지, 위젯 레이아웃을 준비하고 있습니다."
          />
        </div>
      ) : draftError ? (
        <div className="asklake-dashboard-empty-canvas edit">
          <EmptyDashboardCanvas
            action={draftRetryAction}
            editable
            title="초안 대시보드를 불러오지 못했습니다"
            description={draftError}
          />
        </div>
      ) : !draftRuntime?.revision ? (
        <div className="asklake-dashboard-empty-canvas edit">
          <EmptyDashboardCanvas
            action={draftRetryAction}
            editable
            title="초안 revision이 없습니다"
            description="새로고침으로 초안 revision을 다시 생성해 보세요."
          />
        </div>
      ) : (
        <DashboardCanvas
          editable
          selectedWidgetId={selectedWidgetId}
          widgets={selectedDraftWidgets}
          onLayoutCommit={updateDraftWidgetLayouts}
          onSelectWidget={setSelectedWidgetId}
        />
      )
    ) : runtimeLoading ? (
      <div className="asklake-dashboard-empty-canvas">
        <EmptyDashboardCanvas
          editable={false}
          title="게시된 대시보드를 불러오는 중입니다"
          description="최신 게시 revision, 페이지, 위젯을 가져오고 있습니다."
        />
      </div>
    ) : runtimeError ? (
      <div className="asklake-dashboard-empty-canvas">
        <EmptyDashboardCanvas
          action={retryAction}
          editable={false}
          title="게시된 대시보드를 불러오지 못했습니다"
          description={runtimeError}
        />
      </div>
    ) : !publishedRuntime?.revision ? (
      <div className="asklake-dashboard-empty-canvas">
        <EmptyDashboardCanvas
          action={openDraftAction}
          editable={false}
          title="게시된 대시보드가 없습니다"
          description="초안 편집에서 페이지와 위젯을 구성한 뒤 게시하세요."
        />
      </div>
    ) : !runtimePages.length ? (
      <div className="asklake-dashboard-empty-canvas">
        <EmptyDashboardCanvas
          action={openDraftAction}
          editable={false}
          title="게시된 revision에 페이지가 없습니다"
          description="초안 편집에서 페이지를 추가한 뒤 다시 게시하세요."
        />
      </div>
    ) : selectedPublishedWidgets.length === 0 ? (
      <div className="asklake-dashboard-empty-canvas">
        <EmptyDashboardCanvas
          action={openDraftAction}
          editable={false}
          title="이 페이지에 게시된 위젯이 없습니다"
          description="초안 편집에서 이 페이지에 위젯을 배치한 뒤 게시하세요."
        />
      </div>
    ) : (
      <div className="asklake-dashboard-widget-grid" aria-label="Published dashboard widgets">
        {selectedPublishedWidgets.map((widget) => <WidgetFrame key={widget.id} widget={widget} />)}
      </div>
    );

    return (
      <div className="dashboard-page dashboard-runtime-page">
        <DashboardRuntimeShell
          datasetSidebar={isDraftMode ? (
            <DatasetSidebar
              datasets={dashboardDatasets}
              error={dashboardDatasetsError}
              isOpen={isDatasetSidebarOpen}
              isLoading={dashboardDatasetsLoading}
              selectedDatasetId={selectedDatasetId}
              onSelectDataset={setSelectedDatasetId}
            />
          ) : undefined}
          datasetSidebarOpen={isDraftMode && isDatasetSidebarOpen}
          hasPublishedRevision={runtimeHasPublishedRevision}
          isAddingPage={isAddingRuntimePage}
          isPublishing={isPublishingRuntime}
          isRefreshing={isRefreshingRuntime}
          inspector={isDraftMode ? (
            <aside className="asklake-dashboard-inspector">
              <WidgetConfigPanel
                isCreating={isCreatingDatasetWidget}
                selectedDataset={selectedDataset}
                selectedDatasetId={selectedDatasetId}
                onCreateWidget={addDatasetDraftWidget}
              />
              <section>
                <strong>위젯 추가</strong>
                <span>선택한 페이지에 기본 위젯을 추가합니다.</span>
                <div className="asklake-widget-add-list">
                  {draftWidgetPalette.map((type) => (
                    <button
                      disabled={!selectedRuntimePageId || draftLoading}
                      key={type}
                      type="button"
                      onClick={() => void addDraftWidget(type)}
                    >
                      + {draftWidgetLabels[type]}
                    </button>
                  ))}
                </div>
              </section>
            </aside>
          ) : undefined}
          mode={runtimeSelection.mode}
          notice={runtimeNotice}
          pages={runtimePages}
          selectedPageId={selectedRuntimePageId}
          shareLink={runtimeShareLink}
          title={runtimeTitle}
          onAddPage={addRuntimePage}
          onCloseSharePanel={() => setRuntimeShareLink(null)}
          onDeletePage={deleteRuntimePage}
          onOpenDraft={() => openRuntimeDashboard(runtimeSelection.dashboardId, "draft")}
          onOpenPublished={() => openRuntimeDashboard(runtimeSelection.dashboardId, "published")}
          onPublishDraft={publishDraftRuntime}
          onRefresh={refreshRuntimeDashboard}
          onSelectPage={setSelectedRuntimePageId}
          onShare={shareRuntimeDashboard}
          onToggleDatasetSidebar={isDraftMode ? () => setIsDatasetSidebarOpen((open) => !open) : undefined}
        >
          {runtimeCanvas}
        </DashboardRuntimeShell>
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
        primaryTitle={selectedDashboard ? dashboardStatusMeta[selectedDashboard.status].label : isPublished ? "Published" : "Draft"}
        title={activeDashboardTitle}
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
            {sidebarDashboards.slice(0, 3).map((dashboard) => (
              <button key={dashboard.id} type="button" onClick={() => openDetail(dashboard)}>
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
