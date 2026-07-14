import { useCallback, useEffect, useMemo, useState } from "react";
import { DashboardRuntimeView } from "./runtime/DashboardRuntimeView";
import { sqlResultToDashboardOption } from "./runtime/dashboardDatasetAdapters";
import { useDashboardLayoutHistory } from "./runtime/useDashboardLayoutHistory";
import { useDashboardDatasets } from "./runtime/useDashboardDatasets";
import { useDashboardRuntimeResources } from "./runtime/useDashboardRuntimeResources";
import { useDraftWidgetCreator } from "./runtime/useDraftWidgetCreator";
import { useDraftWidgetLayouts } from "./runtime/useDraftWidgetLayouts";
import { DashboardLandingPage } from "./DashboardLandingPage";
import type { ExpandedChart } from "./DashboardParts";
import { DashboardLegacyBuilderView } from "./legacy/DashboardLegacyBuilderView";
import { DashboardLegacyDetailView } from "./legacy/DashboardLegacyDetailView";
import { createDashboardLegacyModel } from "./legacy/dashboardLegacyModel";
import {
  formatDashboardTimestamp,
  normalizeSavedDashboardCard,
} from "./dashboardListUtils";
import { useDashboardLandingList } from "./useDashboardLandingList";
import {
  createDraftPage,
  deleteDraftPage,
  deleteDraftWidget,
  publishDashboard as publishRuntimeDashboard,
  updateDraftPageTitle,
  updateDraftWidget,
} from "../../services/dashboardRuntimeApi";
import { createDashboard, deleteDashboard, updateDashboardTitle } from "../../services/dashboardApi";
import { saveDashboardCard } from "../../services/mockApi";
import { ApiError } from "../../types";
import type { AuditResult, CatalogDataset, DashboardEntry, DashboardRuntimeMode, DashboardRuntimeResponse, DashboardRuntimeWidget, DashboardRuntimeWidgetType, DashboardView, DashboardWidgetLayout, DashboardWidgetType, SavedDashboardCard, SqlResultDraft } from "../../types";
import type { DashboardDatasetOption, UpdateDraftWidgetFormInput } from "./runtime/dashboardRuntimeTypes";

type RuntimeNotice = {
  message: string;
  tone: "success" | "info" | "error";
};

const previewDraftWidgetChanged = (
  current: DashboardRuntimeWidget | null,
  next: DashboardRuntimeWidget | null,
) => {
  if (!current || !next) return current !== next;
  return current.id !== next.id
    || current.pageId !== next.pageId
    || current.title !== next.title
    || current.type !== next.type
    || JSON.stringify(current.config) !== JSON.stringify(next.config);
};

function emptyVisualizationRequestWidgetIds(runtime: DashboardRuntimeResponse | null) {
  if (!runtime) return [];
  return Object.values(runtime.widgetsByPageId)
    .flat()
    .filter((widget) => {
      const config = widget.config as { placeholderKind?: unknown; prompt?: unknown };
      const isVisualizationRequest = config.placeholderKind === "visualization_request"
        || (widget.title === "시각화 요청" && !widget.datasetId && widget.data.length === 0);
      return isVisualizationRequest && (typeof config.prompt !== "string" || !config.prompt.trim());
    })
    .map((widget) => widget.id);
}

const defaultDraftWidgetLayout: Record<DashboardRuntimeWidgetType, DashboardWidgetLayout> = {
  area_chart: { h: 5, minH: 3, minW: 3, w: 6, x: 0, y: 0 },
  bar_chart: { h: 5, minH: 3, minW: 3, w: 6, x: 0, y: 0 },
  donut_chart: { h: 5, minH: 3, minW: 3, w: 4, x: 0, y: 0 },
  heatmap_chart: { h: 5, minH: 3, minW: 4, w: 7, x: 0, y: 0 },
  line_chart: { h: 5, minH: 3, minW: 3, w: 6, x: 0, y: 0 },
  metric: { h: 3, minH: 2, minW: 2, w: 3, x: 0, y: 0 },
  pie_chart: { h: 5, minH: 3, minW: 3, w: 4, x: 0, y: 0 },
  radial_bar_chart: { h: 4, minH: 3, minW: 3, w: 4, x: 0, y: 0 },
  table: { h: 5, minH: 3, minW: 4, w: 9, x: 0, y: 0 },
  treemap_chart: { h: 5, minH: 3, minW: 4, w: 6, x: 0, y: 0 },
};

export function DashboardPage({
  dataset,
  entry,
  sqlResult,
  onAction,
  onRuntimeNavigate,
}: {
  dataset: CatalogDataset;
  datasets?: CatalogDataset[];
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
  const [deletedLegacyWidgetIds, setDeletedLegacyWidgetIds] = useState<Set<string>>(() => new Set());
  const [dashboardCreateError, setDashboardCreateError] = useState<string | null>(null);
  const [isCreatingDashboard, setIsCreatingDashboard] = useState(false);
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
  const [dashboardListRefreshKey, setDashboardListRefreshKey] = useState(0);
  const [isAddingRuntimePage, setIsAddingRuntimePage] = useState(false);
  const [isPublishingRuntime, setIsPublishingRuntime] = useState(false);
  const [deletingRuntimeWidgetId, setDeletingRuntimeWidgetId] = useState<string | null>(null);
  const [updatingRuntimeWidgetId, setUpdatingRuntimeWidgetId] = useState<string | null>(null);
  const [isRenamingRuntimeTitle, setIsRenamingRuntimeTitle] = useState(false);
  const [renamingRuntimePageId, setRenamingRuntimePageId] = useState<string | null>(null);
  const [isRefreshingRuntime, setIsRefreshingRuntime] = useState(false);
  const [runtimeNotice, setRuntimeNotice] = useState<RuntimeNotice | null>(null);
  const [runtimeShareLink, setRuntimeShareLink] = useState<string | null>(null);
  const [isDatasetSidebarOpen, setIsDatasetSidebarOpen] = useState(true);
  const [previewDraftWidget, setPreviewDraftWidget] = useState<DashboardRuntimeWidget | null>(null);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);
  const [selectedWidgetId, setSelectedWidgetId] = useState<string | null>(null);
  const [widgetScrollTargetId, setWidgetScrollTargetId] = useState<string | null>(null);
  const [selectedDashboard, setSelectedDashboard] = useState<SavedDashboardCard | null>(null);
  const [savedDashboards, setSavedDashboards] = useState<SavedDashboardCard[]>([]);
  const dashboardList = useDashboardLandingList(onAction, entry.version + dashboardListRefreshKey);
  const activeSqlResult = entry.source === "sql" && (sqlResult?.datasetId === dataset.id || sqlResult?.baseDatasetId === dataset.id) ? sqlResult : null;
  const sqlDashboardDataset = useMemo(
    () => activeSqlResult ? sqlResultToDashboardOption(activeSqlResult) : null,
    [activeSqlResult],
  );
  const legacyModel = useMemo(
    () => createDashboardLegacyModel({ activeSqlResult, builderWidgets, dataset }),
    [activeSqlResult, builderWidgets, dataset],
  );
  const {
    dashboardId,
    dashboardTitle,
    snapshotWidgets,
    sourceRunId,
    sqlResultSnapshot,
  } = legacyModel;
  const sidebarDashboards = dashboardList.visibleDashboards.length ? dashboardList.visibleDashboards : savedDashboards;
  const activeDashboardId = selectedDashboard?.id ?? dashboardId;
  const activeDashboardTitle = selectedDashboard?.name ?? dashboardTitle;
  const activeDashboardWidgets = selectedDashboard?.widgets?.length ? selectedDashboard.widgets : snapshotWidgets;
  const {
    datasets: dashboardDatasets,
    error: dashboardDatasetsError,
    isLoading: dashboardDatasetsLoading,
  } = useDashboardDatasets();
  const availableDashboardDatasets = useMemo(
    () => sqlDashboardDataset
      ? [sqlDashboardDataset, ...dashboardDatasets.filter((item) => item.id !== sqlDashboardDataset.id)]
      : dashboardDatasets,
    [dashboardDatasets, sqlDashboardDataset],
  );

  useEffect(() => {
    setView(entry.view);
    setDeletedLegacyWidgetIds(new Set());
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

  const runtimeResources = useDashboardRuntimeResources({
    active: view === "runtime",
    dashboardId: runtimeSelection.dashboardId,
    mode: runtimeSelection.mode,
  });
  const {
    draftError,
    draftLoading,
    draftRuntime,
    loadDraftRuntime,
    loadPublishedRuntime,
    pages: runtimePages,
    publishedRuntime,
    runtimeError,
    runtimeLoading,
    selectedPageId: selectedRuntimePageId,
    setDraftError,
    setDraftRuntime,
    setPublishedRuntime,
    setSelectedPageId: setSelectedRuntimePageId,
  } = runtimeResources;
  const runtimeDashboards = [...dashboardList.visibleDashboards, ...savedDashboards];
  const runtimeDashboard = runtimeDashboards.find((dashboard) => dashboard.id === runtimeSelection.dashboardId);
  const runtimeTitle = runtimeSelection.mode === "published"
    ? publishedRuntime?.dashboard.title ?? runtimeDashboard?.name ?? runtimeSelection.dashboardId
    : draftRuntime?.dashboard.title ?? runtimeDashboard?.name ?? runtimeSelection.dashboardId;
  const runtimeHasPublishedRevision = runtimeSelection.mode === "published"
    ? publishedRuntime?.dashboard.hasPublishedRevision ?? runtimeDashboard?.hasPublishedRevision ?? runtimeDashboard?.status === "published"
    : draftRuntime?.dashboard.hasPublishedRevision ?? runtimeDashboard?.hasPublishedRevision ?? runtimeDashboard?.status === "published";
  const selectedDraftWidgets = useMemo(
    () => runtimeSelection.mode === "draft" && selectedRuntimePageId
      ? draftRuntime?.widgetsByPageId[selectedRuntimePageId] ?? []
      : [],
    [draftRuntime?.widgetsByPageId, runtimeSelection.mode, selectedRuntimePageId],
  );
  const previewDraftWidgets = useMemo(
    () => selectedDraftWidgets.map((widget) => (
      previewDraftWidget?.id === widget.id && previewDraftWidget.pageId === widget.pageId
        ? {
          ...previewDraftWidget,
          data: widget.data,
          datasetId: previewDraftWidget.datasetId ?? widget.datasetId,
          layout: widget.layout,
          pageId: widget.pageId,
          queryId: previewDraftWidget.queryId ?? widget.queryId,
        } as DashboardRuntimeWidget
        : widget
    )),
    [previewDraftWidget, selectedDraftWidgets],
  );
  const selectedDraftWidget = useMemo(
    () => selectedDraftWidgets.find((widget) => widget.id === selectedWidgetId) ?? null,
    [selectedDraftWidgets, selectedWidgetId],
  );
  const selectedDraftWidgetIds = useMemo(
    () => selectedDraftWidgets.map((widget) => widget.id).sort().join("|"),
    [selectedDraftWidgets],
  );
  const editorDatasetId = selectedDatasetId ?? selectedDraftWidget?.datasetId ?? null;
  const editorDataset = useMemo(
    () => availableDashboardDatasets.find((datasetOption) => datasetOption.id === editorDatasetId) ?? null,
    [availableDashboardDatasets, editorDatasetId],
  );
  const selectedPublishedWidgets = useMemo(
    () => runtimeSelection.mode === "published" && selectedRuntimePageId && publishedRuntime?.revision
      ? publishedRuntime.widgetsByPageId[selectedRuntimePageId] ?? []
      : [],
    [publishedRuntime?.revision, publishedRuntime?.widgetsByPageId, runtimeSelection.mode, selectedRuntimePageId],
  );

  useEffect(() => {
    if (!selectedDatasetId) return;
    if (availableDashboardDatasets.some((datasetOption) => datasetOption.id === selectedDatasetId)) return;
    setSelectedDatasetId(null);
  }, [availableDashboardDatasets, selectedDatasetId]);

  const {
    createDatasetDraftWidget,
    createToolbarDraftWidget,
    isCreatingDatasetWidget,
    isCreatingToolbarWidget,
  } = useDraftWidgetCreator({
    dashboardId: runtimeSelection.dashboardId,
    defaultLayouts: defaultDraftWidgetLayout,
    mode: runtimeSelection.mode,
    onAction,
    reloadDraftRuntime: loadDraftRuntime,
    selectedPageId: selectedRuntimePageId,
    selectedWidgets: selectedDraftWidgets,
    setDraftError,
    setDraftRuntime,
    setRuntimeNotice,
    setSelectedWidgetId,
    setWidgetScrollTargetId,
  });

  const { updateDraftWidgetLayouts } = useDraftWidgetLayouts({
    dashboardId: runtimeSelection.dashboardId,
    onAction,
    selectedPageId: selectedRuntimePageId,
    setDraftError,
    setDraftRuntime,
    setRuntimeNotice,
  });

  const layoutHistory = useDashboardLayoutHistory({
    dashboardId: runtimeSelection.dashboardId,
    mode: runtimeSelection.mode,
    onAction,
    onNotice: setRuntimeNotice,
    selectedPageId: selectedRuntimePageId,
    selectedWidgetIdsKey: selectedDraftWidgetIds,
    selectedWidgets: selectedDraftWidgets,
    updateLayouts: updateDraftWidgetLayouts,
  });

  useEffect(() => {
    setSelectedWidgetId(null);
    setPreviewDraftWidget(null);
  }, [selectedRuntimePageId]);

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

  const updateRuntimeListTitle = (nextDashboardId: string, title: string, updatedAtValue = new Date().toISOString()) => {
    setSavedDashboards((cards) => cards.map((card) => card.id === nextDashboardId
      ? normalizeSavedDashboardCard({
        ...card,
        name: title,
        updated: "방금 전",
        updatedAtValue,
      })
      : card));
    setSelectedDashboard((card) => card?.id === nextDashboardId
      ? normalizeSavedDashboardCard({
        ...card,
        name: title,
        updated: "방금 전",
        updatedAtValue,
      })
      : card);
    setDashboardListRefreshKey((key) => key + 1);
  };

  const changeFilter = (nextPeriod: string, nextSegment = segment) => {
    setPeriod(nextPeriod);
    setSegment(nextSegment);
    onAction("dashboard.filter.changed", "/api/dashboards/filters", dataset.id);
  };

  const createDashboardFromLanding = async () => {
    if (isCreatingDashboard) return;

    const now = new Date();
    const title = `새 대시보드 ${formatDashboardTimestamp(now)}`;
    setIsCreatingDashboard(true);
    setDashboardCreateError(null);
    setRuntimeNotice(null);

    try {
      const { dashboard } = await createDashboard({ source: "manual", title });
      const nextDashboard = normalizeSavedDashboardCard(dashboard);
      setSelectedDashboard(null);
      setSavedDashboards((cards) => [nextDashboard, ...cards.filter((card) => card.id !== nextDashboard.id)]);
      dashboardList.reloadDashboards();
      setRuntimeShareLink(null);
      setSelectedWidgetId(null);
      setSelectedRuntimePageId(null);
      onAction("dashboard.created", "/api/dashboards", nextDashboard.id);
      openRuntimeDashboard(nextDashboard.id, "draft");
    } catch (error) {
      const message = error instanceof Error ? error.message : "대시보드 생성에 실패했습니다.";
      setDashboardCreateError(message);
      onAction("dashboard.create_failed", "/api/dashboards", dataset.id, "failed");
    } finally {
      setIsCreatingDashboard(false);
    }
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

  const deleteRuntimeWidget = async (widgetId: string) => {
    if (runtimeSelection.mode !== "draft" || deletingRuntimeWidgetId) return;
    const targetWidget = selectedDraftWidgets.find((widget) => widget.id === widgetId);
    const targetTitle = targetWidget?.title || "제목 없는 위젯";
    const confirmed = window.confirm(`'${targetTitle}' 위젯을 삭제할까요? 삭제 후에는 되돌릴 수 없습니다.`);
    if (!confirmed) return;

    setDeletingRuntimeWidgetId(widgetId);
    setDraftError(null);
    setRuntimeNotice({ message: "위젯을 삭제하는 중입니다.", tone: "info" });
    try {
      await deleteDraftWidget(runtimeSelection.dashboardId, widgetId);
      if (selectedWidgetId === widgetId) setSelectedWidgetId(null);
      if (previewDraftWidget?.id === widgetId) setPreviewDraftWidget(null);
      setDraftRuntime((runtime) => runtime
        ? {
          ...runtime,
          widgetsByPageId: Object.fromEntries(
            Object.entries(runtime.widgetsByPageId).map(([pageId, widgets]) => [
              pageId,
              widgets.filter((widget) => widget.id !== widgetId),
            ]),
          ),
        }
        : runtime);
      setRuntimeNotice({ message: "위젯을 삭제했습니다.", tone: "success" });
      onAction("dashboard.widget.deleted", `/api/dashboards/${runtimeSelection.dashboardId}/draft/widgets/${widgetId}`, widgetId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to delete the draft widget.";
      setDraftError(message);
      setRuntimeNotice({ message: "위젯을 삭제하지 못했습니다.", tone: "error" });
      onAction("dashboard.widget.delete_failed", `/api/dashboards/${runtimeSelection.dashboardId}/draft/widgets/${widgetId}`, widgetId, "failed");
    } finally {
      setDeletingRuntimeWidgetId(null);
    }
  };

  const selectRuntimeWidget = (widgetId: string) => {
    const nextWidgetId = widgetId || null;
    const widget = selectedDraftWidgets.find((item) => item.id === widgetId);
    setPreviewDraftWidget((current) => (current?.id === nextWidgetId ? current : null));
    setSelectedWidgetId(nextWidgetId);
    if (widget?.datasetId) setSelectedDatasetId(widget.datasetId);
  };

  const clearRuntimeWidgetSelection = () => {
    setPreviewDraftWidget(null);
    setSelectedWidgetId(null);
  };

  const previewRuntimeWidget = useCallback((widget: DashboardRuntimeWidget | null) => {
    setPreviewDraftWidget((current) => (previewDraftWidgetChanged(current, widget) ? widget : current));
  }, []);

  const selectRuntimeDataset = (datasetId: string) => {
    setPreviewDraftWidget(null);
    setSelectedDatasetId(datasetId);
    setSelectedWidgetId(null);
  };

  const selectRuntimeWidgetDataset = (datasetId: string) => {
    setPreviewDraftWidget(null);
    setSelectedDatasetId(datasetId);
  };

  const updateRuntimeWidget = async (widgetId: string, input: UpdateDraftWidgetFormInput) => {
    if (runtimeSelection.mode !== "draft" || updatingRuntimeWidgetId) return;

    setUpdatingRuntimeWidgetId(widgetId);
    setDraftError(null);
    setRuntimeNotice({ message: "위젯 변경사항을 저장하는 중입니다.", tone: "info" });
    try {
      await updateDraftWidget(runtimeSelection.dashboardId, widgetId, input);
      setPreviewDraftWidget(null);
      await loadDraftRuntime(runtimeSelection.dashboardId, { silent: true });
      setSelectedWidgetId(widgetId);
      setRuntimeNotice({ message: "위젯 변경사항을 저장했습니다.", tone: "success" });
      onAction("dashboard.widget.updated", `/api/dashboards/${runtimeSelection.dashboardId}/draft/widgets/${widgetId}`, widgetId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update the draft widget.";
      setDraftError(message);
      setRuntimeNotice({ message: "위젯 변경사항을 저장하지 못했습니다.", tone: "error" });
      onAction("dashboard.widget.update_failed", `/api/dashboards/${runtimeSelection.dashboardId}/draft/widgets/${widgetId}`, widgetId, "failed");
    } finally {
      setUpdatingRuntimeWidgetId(null);
    }
  };

  const renameRuntimeDashboardTitle = async (title: string) => {
    if (runtimeSelection.mode !== "draft" || isRenamingRuntimeTitle) return;
    const nextTitle = title.trim();
    if (!nextTitle) {
      setRuntimeNotice({ message: "대시보드 제목을 입력해 주세요.", tone: "error" });
      return;
    }

    setIsRenamingRuntimeTitle(true);
    setDraftError(null);
    try {
      const { dashboard } = await updateDashboardTitle(runtimeSelection.dashboardId, nextTitle);
      const savedTitle = dashboard.name ?? nextTitle;
      const updatedAtValue = dashboard.updatedAtValue ?? new Date().toISOString();
      setDraftRuntime((runtime) => runtime
        ? {
          ...runtime,
          dashboard: {
            ...runtime.dashboard,
            title: savedTitle,
            updatedAt: updatedAtValue,
          },
        }
        : runtime);
      setPublishedRuntime((runtime) => runtime
        ? {
          ...runtime,
          dashboard: {
            ...runtime.dashboard,
            title: savedTitle,
            updatedAt: updatedAtValue,
          },
        }
        : runtime);
      updateRuntimeListTitle(runtimeSelection.dashboardId, savedTitle, updatedAtValue);
      dashboardList.reloadDashboards();
      setRuntimeNotice({ message: "대시보드 제목을 저장했습니다.", tone: "success" });
      onAction("dashboard.title.updated", `/api/dashboards/${runtimeSelection.dashboardId}`, runtimeSelection.dashboardId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update dashboard title.";
      setDraftError(message);
      setRuntimeNotice({ message: "대시보드 제목을 저장하지 못했습니다.", tone: "error" });
    } finally {
      setIsRenamingRuntimeTitle(false);
    }
  };

  const renameRuntimePage = async (pageId: string, title: string) => {
    if (runtimeSelection.mode !== "draft" || renamingRuntimePageId) return;
    const nextTitle = title.trim();
    if (!nextTitle) {
      setRuntimeNotice({ message: "페이지 이름을 입력해 주세요.", tone: "error" });
      return;
    }

    setRenamingRuntimePageId(pageId);
    setDraftError(null);
    try {
      const page = await updateDraftPageTitle(runtimeSelection.dashboardId, pageId, { title: nextTitle });
      setDraftRuntime((runtime) => runtime
        ? {
          ...runtime,
          pages: runtime.pages.map((runtimePage) => runtimePage.id === page.id
            ? { ...runtimePage, title: page.title, orderIndex: page.orderIndex }
            : runtimePage),
        }
        : runtime);
      setRuntimeNotice({ message: "페이지 이름을 저장했습니다.", tone: "success" });
      onAction("dashboard.page.renamed", `/api/dashboards/${runtimeSelection.dashboardId}/draft/pages/${pageId}`, pageId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update draft page title.";
      setDraftError(message);
      setRuntimeNotice({ message: "페이지 이름을 저장하지 못했습니다.", tone: "error" });
    } finally {
      setRenamingRuntimePageId(null);
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
    const path = `/dashboards/${runtimeSelection.dashboardId}`;
    const shareUrl = `${window.location.origin}${path}`;
    setRuntimeShareLink(shareUrl);
    setRuntimeNotice({ message: "공유 링크가 준비되었습니다.", tone: "info" });
    onAction("dashboard.runtime.shared", path, runtimeSelection.dashboardId);
  };

  const cleanupEmptyVisualizationRequestWidgets = async () => {
    const widgetIds = emptyVisualizationRequestWidgetIds(draftRuntime);
    if (!widgetIds.length) return 0;

    await Promise.all(widgetIds.map((widgetId) => deleteDraftWidget(runtimeSelection.dashboardId, widgetId)));
    const deletedWidgetIds = new Set(widgetIds);
    setDraftRuntime((runtime) => runtime
      ? {
        ...runtime,
        widgetsByPageId: Object.fromEntries(
          Object.entries(runtime.widgetsByPageId).map(([pageId, widgets]) => [
            pageId,
            widgets.filter((widget) => !deletedWidgetIds.has(widget.id)),
          ]),
        ),
      }
      : runtime);
    if (selectedWidgetId && deletedWidgetIds.has(selectedWidgetId)) setSelectedWidgetId(null);
    if (previewDraftWidget && deletedWidgetIds.has(previewDraftWidget.id)) setPreviewDraftWidget(null);
    widgetIds.forEach((widgetId) => {
      onAction("dashboard.widget.empty_visualization_request_deleted", `/api/dashboards/${runtimeSelection.dashboardId}/draft/widgets/${widgetId}`, widgetId);
    });
    return widgetIds.length;
  };

  const publishDraftRuntime = async () => {
    if (runtimeSelection.mode !== "draft" || isPublishingRuntime) return;
    setIsPublishingRuntime(true);
    setDraftError(null);
    try {
      await cleanupEmptyVisualizationRequestWidgets();
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
    if (deleteTarget) {
      setDeletedLegacyWidgetIds((widgetIds) => new Set(widgetIds).add(deleteTarget));
      onAction("dashboard.widget.deleted", "/api/dashboards/widgets", deleteTarget);
    }
    setDeleteTarget(null);
  };

  const openExpandedChart = (kind: ExpandedChart["kind"], title: string, subtitle: string) => {
    setExpandedChart({ kind, subtitle, title });
    onAction("dashboard.chart.expanded", `/api/dashboards/charts/${kind}`, dataset.id);
  };

  if (view === "list") {
    return (
      <DashboardLandingPage
        currentPage={dashboardList.safeDashboardPage}
        createError={dashboardCreateError}
        dashboardCount={dashboardList.dashboardCount}
        deleteError={dashboardDeleteError}
        deleteTarget={dashboardDeleteTarget}
        deletingDashboardId={deletingDashboardId}
        dashboards={dashboardList.visibleDashboards}
        error={dashboardList.dashboardError}
        isCreatingDashboard={isCreatingDashboard}
        isLoading={dashboardList.dashboardLoading}
        onCancelDelete={cancelDashboardDelete}
        onClearTags={dashboardList.clearDashboardTags}
        onConfirmDelete={confirmDashboardDelete}
        onCreateDashboard={createDashboardFromLanding}
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
    const runtimeViewActions = {
      addPage: addRuntimePage,
      clearWidgetScrollTarget: () => setWidgetScrollTargetId(null),
      clearWidgetSelection: clearRuntimeWidgetSelection,
      closeSharePanel: () => setRuntimeShareLink(null),
      createDatasetWidget: createDatasetDraftWidget,
      createToolbarWidget: createToolbarDraftWidget,
      deletePage: deleteRuntimePage,
      deleteWidget: deleteRuntimeWidget,
      layoutCommit: layoutHistory.commit,
      layoutRejected: () => setRuntimeNotice({ message: "위젯이 겹쳐 원래 위치로 되돌렸습니다.", tone: "error" }),
      openDraft: () => openRuntimeDashboard(runtimeSelection.dashboardId, "draft"),
      openPublished: () => openRuntimeDashboard(runtimeSelection.dashboardId, "published"),
      publishDraft: publishDraftRuntime,
      redoLayout: layoutHistory.redo,
      refresh: refreshRuntimeDashboard,
      renamePage: renameRuntimePage,
      renameTitle: renameRuntimeDashboardTitle,
      retryDraft: () => void loadDraftRuntime(runtimeSelection.dashboardId),
      retryPublished: () => void loadPublishedRuntime(runtimeSelection.dashboardId),
      selectDataset: selectRuntimeDataset,
      selectWidgetDataset: selectRuntimeWidgetDataset,
      selectPage: setSelectedRuntimePageId,
      selectWidget: selectRuntimeWidget,
      share: shareRuntimeDashboard,
      toggleDatasetSidebar: () => setIsDatasetSidebarOpen((open) => !open),
      previewWidget: previewRuntimeWidget,
      undoLayout: layoutHistory.undo,
      updateWidget: updateRuntimeWidget,
    };
    const runtimeDatasetState = {
      datasets: availableDashboardDatasets,
      error: dashboardDatasetsError,
      isCreatingWidget: isCreatingDatasetWidget,
      isLoading: dashboardDatasetsLoading,
      selectedDataset: editorDataset,
      selectedDatasetId: editorDatasetId,
    };
    const runtimeViewState = {
      deletingWidgetId: deletingRuntimeWidgetId,
      draftError,
      draftLoading,
      draftRuntime,
      canRedoLayout: layoutHistory.canRedo,
      canUndoLayout: layoutHistory.canUndo,
      hasPublishedRevision: runtimeHasPublishedRevision,
      isAddingPage: isAddingRuntimePage,
      isDatasetSidebarOpen,
      isCreatingToolbarWidget,
      isPublishing: isPublishingRuntime,
      isRenamingTitle: isRenamingRuntimeTitle,
      isRefreshing: isRefreshingRuntime,
      mode: runtimeSelection.mode,
      notice: runtimeNotice,
      pages: runtimePages,
      publishedRuntime,
      renamingPageId: renamingRuntimePageId,
      runtimeError,
      runtimeLoading,
      selectedDraftWidgets: previewDraftWidgets,
      selectedDraftWidget,
      selectedPageId: selectedRuntimePageId,
      selectedPublishedWidgets,
      selectedWidgetId,
      shareLink: runtimeShareLink,
      title: runtimeTitle,
      updatingWidgetId: updatingRuntimeWidgetId,
      widgetScrollTargetId,
    };

    return (
      <DashboardRuntimeView
        actions={runtimeViewActions}
        datasets={runtimeDatasetState}
        runtime={runtimeViewState}
      />
    );
  }

  if (view === "builder") {
    return (
      <DashboardLegacyBuilderView
        activeSqlResult={activeSqlResult}
        builderWidgets={builderWidgets}
        dataset={dataset}
        expandedChart={expandedChart}
        isPublished={isPublished}
        model={legacyModel}
        onAddWidget={addWidgetToCanvas}
        onBackToList={backToList}
        onCloseExpandedChart={() => setExpandedChart(null)}
        onExport={exportDashboard}
        onFullscreen={openDashboardFullscreen}
        onOpenPreview={() => {
          setView("detail");
          onAction("dashboard.preview_opened", "/api/dashboards/preview", dataset.id);
        }}
        onOpenWidgetSettings={(type) => {
          setSelectedWidgetType(type);
          onAction("dashboard.widget.settings_opened", "/api/dashboards/widgets/settings", type);
        }}
        onPublish={publishDashboard}
        onRemoveWidget={removeBuilderWidget}
        onSave={saveDashboard}
        onSelectWidgetType={(type) => {
          setSelectedWidgetType(type);
          onAction("dashboard.widget.type_selected", "/api/dashboards/widgets/types", type);
        }}
        onShare={shareDashboard}
        onViewPublished={openPublishedView}
        selectedWidgetType={selectedWidgetType}
      />
    );
  }

  return (
    <DashboardLegacyDetailView
      activeDashboardTitle={activeDashboardTitle}
      activeSqlResult={activeSqlResult}
      dataset={dataset}
      deletedWidgetIds={deletedLegacyWidgetIds}
      deleteRequested={Boolean(deleteTarget)}
      expandedChart={expandedChart}
      isPublished={isPublished}
      model={legacyModel}
      onBackToList={backToList}
      onCancelDelete={() => setDeleteTarget(null)}
      onChangeFilter={changeFilter}
      onCloseExpandedChart={() => setExpandedChart(null)}
      onConfirmDelete={confirmDelete}
      onCreateDashboard={() => {
        setBuilderWidgets([]);
        setIsPublished(false);
        setView("builder");
        onAction("dashboard.created", "/api/dashboards", dataset.id);
      }}
      onDraftEdit={() => {
        setView("builder");
        onAction("dashboard.draft_edit_opened", "/api/dashboards/draft", dataset.id);
      }}
      onExport={exportDashboard}
      onFullscreen={openDashboardFullscreen}
      onOpenDashboard={openDetail}
      onOpenExpandedChart={openExpandedChart}
      onPublish={publishDashboard}
      onRequestDelete={requestDelete}
      onSave={saveDashboard}
      onShare={shareDashboard}
      onViewPublished={openPublishedView}
      period={period}
      segment={segment}
      selectedDashboard={selectedDashboard}
      sidebarDashboards={sidebarDashboards}
    />
  );
}
