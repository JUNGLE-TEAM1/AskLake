import { useCallback, useEffect, useMemo, useState } from "react";
import { DashboardRuntimeView } from "./runtime/DashboardRuntimeView";
import { sqlResultToDashboardOption } from "./runtime/dashboardDatasetAdapters";
import { useDashboardLayoutHistory } from "./runtime/useDashboardLayoutHistory";
import { removeRuntimeWidget } from "./runtime/dashboardRuntimeMutations";
import { dashboardRuntimeErrorMessage } from "./runtime/dashboardRuntimeErrors";
import { dashboardPublishPreflight } from "./runtime/dashboardPublishPreflight";
import { useDashboardDatasets } from "./runtime/useDashboardDatasets";
import { useDashboardRuntimeResources } from "./runtime/useDashboardRuntimeResources";
import { useDashboardAutoRefresh } from "./runtime/useDashboardAutoRefresh";
import { useDraftPageMutations } from "./runtime/useDraftPageMutations";
import { useDraftWidgetCreator } from "./runtime/useDraftWidgetCreator";
import { useDraftWidgetLayouts } from "./runtime/useDraftWidgetLayouts";
import { useDraftWidgetMutations } from "./runtime/useDraftWidgetMutations";
import { DashboardLandingPage } from "./DashboardLandingPage";
import {
  formatDashboardTimestamp,
  normalizeSavedDashboardCard,
} from "./dashboardListUtils";
import { useDashboardLandingList } from "./useDashboardLandingList";
import {
  deleteDraftWidget,
  publishDashboard as publishRuntimeDashboard,
} from "../../services/dashboardRuntimeApi";
import { createDashboard, deleteDashboard, updateDashboardTitle } from "../../services/dashboardApi";
import { ApiError } from "../../types";
import type { AuditResult, CatalogDataset, DashboardEntry, DashboardRuntimeMode, DashboardRuntimeResponse, DashboardRuntimeWidget, DashboardRuntimeWidgetType, DashboardView, DashboardWidgetLayout, SavedDashboardCard, SqlResultDraft } from "../../types";
import type { DashboardDatasetOption } from "./runtime/dashboardRuntimeTypes";
import { onCatalogDatasetDeleted } from "../../services/catalogEvents";

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
  currentUserId,
  dataset,
  entry,
  sqlResult,
  onAction,
  onRuntimeNavigate,
}: {
  currentUserId: string;
  dataset: CatalogDataset;
  entry: DashboardEntry;
  sqlResult: SqlResultDraft | null;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onRuntimeNavigate?: (dashboardId: string, mode: DashboardRuntimeMode) => void;
}) {
  const [view, setView] = useState<DashboardView>(entry.view);
  const [dashboardCreateError, setDashboardCreateError] = useState<string | null>(null);
  const [isCreatingDashboard, setIsCreatingDashboard] = useState(false);
  const [dashboardDeleteTarget, setDashboardDeleteTarget] = useState<SavedDashboardCard | null>(null);
  const [dashboardDeleteError, setDashboardDeleteError] = useState<string | null>(null);
  const [deletingDashboardId, setDeletingDashboardId] = useState<string | null>(null);
  const [runtimeSelection, setRuntimeSelection] = useState<{ dashboardId: string; mode: DashboardRuntimeMode }>(() => ({
    dashboardId: entry.dashboardId ?? "dash_sales_demo",
    mode: entry.runtimeMode ?? "published",
  }));
  const [dashboardListRefreshKey, setDashboardListRefreshKey] = useState(0);
  const [isPublishingRuntime, setIsPublishingRuntime] = useState(false);
  const [isRenamingRuntimeTitle, setIsRenamingRuntimeTitle] = useState(false);
  const [isRefreshingRuntime, setIsRefreshingRuntime] = useState(false);
  const [runtimeNotice, setRuntimeNotice] = useState<RuntimeNotice | null>(null);
  const [runtimeShareLink, setRuntimeShareLink] = useState<string | null>(null);
  const [isDatasetSidebarOpen, setIsDatasetSidebarOpen] = useState(false);
  const [previewDraftWidget, setPreviewDraftWidget] = useState<DashboardRuntimeWidget | null>(null);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);
  const [selectedWidgetId, setSelectedWidgetId] = useState<string | null>(null);
  const [deletedDatasetIds, setDeletedDatasetIds] = useState<Set<string>>(() => new Set());
  const [widgetScrollTargetId, setWidgetScrollTargetId] = useState<string | null>(null);
  const [savedDashboards, setSavedDashboards] = useState<SavedDashboardCard[]>([]);
  const dashboardList = useDashboardLandingList(onAction, entry.version + dashboardListRefreshKey);
  const activeSqlResult = entry.source === "sql" && (sqlResult?.datasetId === dataset.id || sqlResult?.baseDatasetId === dataset.id) ? sqlResult : null;
  const sqlDashboardDataset = useMemo(
    () => activeSqlResult ? sqlResultToDashboardOption(activeSqlResult) : null,
    [activeSqlResult],
  );
  const {
    datasets: dashboardDatasets,
    error: dashboardDatasetsError,
    isLoading: dashboardDatasetsLoading,
  } = useDashboardDatasets(view === "runtime");
  const availableDashboardDatasets = useMemo(
    () => {
      const datasets = sqlDashboardDataset
        ? [sqlDashboardDataset, ...dashboardDatasets.filter((item) => item.id !== sqlDashboardDataset.id)]
        : dashboardDatasets;
      return datasets.filter((item) => !deletedDatasetIds.has(item.id));
    },
    [dashboardDatasets, deletedDatasetIds, sqlDashboardDataset],
  );
  const availableDashboardDatasetIds = useMemo(
    () => new Set(availableDashboardDatasets.map((item) => item.id)),
    [availableDashboardDatasets],
  );
  const dashboardDatasetCatalogReady = !dashboardDatasetsLoading && !dashboardDatasetsError;

  useEffect(() => onCatalogDatasetDeleted((datasetId) => {
    setDeletedDatasetIds((current) => {
      if (current.has(datasetId)) return current;
      const next = new Set(current);
      next.add(datasetId);
      return next;
    });
  }), []);

  useEffect(() => {
    setView(entry.view);
    if (entry.view === "runtime" && entry.dashboardId) {
      setRuntimeSelection({
        dashboardId: entry.dashboardId,
        mode: entry.runtimeMode ?? "published",
      });
    }
  }, [dataset.id, entry.dashboardId, entry.runtimeMode, entry.source, entry.version, entry.view, sqlResult?.datasetId]);

  const runtimeResources = useDashboardRuntimeResources({
    active: view === "runtime", dashboardId: runtimeSelection.dashboardId, mode: runtimeSelection.mode,
  });
  const {
    draftError,
    draftLoading,
    draftRuntime,
    loadDraftRuntime,
    loadPublishedRuntime,
    pages: runtimePages,
    publishedRuntime,
    refreshCurrentPageWidgetData,
    refreshWidgetDataForDatasets,
    retryWidgetData,
    runtimeError,
    runtimeLoading,
    selectedPageId: selectedRuntimePageId,
    setDraftRuntime,
    setPublishedRuntime,
    setSelectedPageId: setSelectedRuntimePageId,
  } = runtimeResources;
  const activeRuntime = runtimeSelection.mode === "published" ? publishedRuntime : draftRuntime;
  const dashboardAutoRefresh = useDashboardAutoRefresh({
    active: view === "runtime",
    currentUserId,
    dashboardId: runtimeSelection.dashboardId,
    refreshCurrentPageWidgetData,
    refreshWidgetDataForDatasets,
    runtime: activeRuntime,
    selectedPageId: selectedRuntimePageId,
  });
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
    () => selectedDraftWidgets.find((widget) => widget.id === selectedWidgetId
      && (!widget.datasetId || (!deletedDatasetIds.has(widget.datasetId)
        && (!dashboardDatasetCatalogReady || availableDashboardDatasetIds.has(widget.datasetId))))) ?? null,
    [availableDashboardDatasetIds, dashboardDatasetCatalogReady, deletedDatasetIds, selectedDraftWidgets, selectedWidgetId],
  );
  const visibleSelectedDraftWidgets = useMemo(
    () => dashboardDatasetCatalogReady
      ? selectedDraftWidgets.filter((widget) => !widget.datasetId || (!deletedDatasetIds.has(widget.datasetId) && availableDashboardDatasetIds.has(widget.datasetId)))
      : selectedDraftWidgets.filter((widget) => !widget.datasetId || !deletedDatasetIds.has(widget.datasetId)),
    [availableDashboardDatasetIds, dashboardDatasetCatalogReady, deletedDatasetIds, selectedDraftWidgets],
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
  const visibleSelectedPublishedWidgets = useMemo(
    () => dashboardDatasetCatalogReady
      ? selectedPublishedWidgets.filter((widget) => !widget.datasetId || (!deletedDatasetIds.has(widget.datasetId) && availableDashboardDatasetIds.has(widget.datasetId)))
      : selectedPublishedWidgets.filter((widget) => !widget.datasetId || !deletedDatasetIds.has(widget.datasetId)),
    [availableDashboardDatasetIds, dashboardDatasetCatalogReady, deletedDatasetIds, selectedPublishedWidgets],
  );

  const pageMutations = useDraftPageMutations({
    dashboardId: runtimeSelection.dashboardId,
    draftRuntime,
    mode: runtimeSelection.mode,
    onAction,
    selectedPageId: selectedRuntimePageId,
    setDraftRuntime,
    setNotice: setRuntimeNotice,
    setSelectedPageId: setSelectedRuntimePageId,
    setSelectedWidgetId,
  });
  const widgetMutations = useDraftWidgetMutations({
    dashboardId: runtimeSelection.dashboardId,
    mode: runtimeSelection.mode,
    onAction,
    previewWidget: previewDraftWidget,
    selectedWidgetId,
    selectedWidgets: selectedDraftWidgets,
    setDraftRuntime,
    setNotice: setRuntimeNotice,
    setPreviewWidget: setPreviewDraftWidget,
    setSelectedWidgetId,
  });

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
    selectedPageId: selectedRuntimePageId,
    selectedWidgets: selectedDraftWidgets,
    setDraftRuntime,
    setRuntimeNotice,
    setSelectedWidgetId,
    setWidgetScrollTargetId,
  });

  const { updateDraftWidgetLayouts } = useDraftWidgetLayouts({
    dashboardId: runtimeSelection.dashboardId,
    draftRuntime,
    onAction,
    selectedPageId: selectedRuntimePageId,
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
    setDashboardListRefreshKey((key) => key + 1);
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
    openRuntimeDashboard(dashboard.id, "published");
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

  const renameRuntimeDashboardTitle = async (title: string) => {
    if (runtimeSelection.mode !== "draft" || isRenamingRuntimeTitle) return;
    const nextTitle = title.trim();
    if (!nextTitle) {
      setRuntimeNotice({ message: "대시보드 제목을 입력해 주세요.", tone: "error" });
      return;
    }

    setIsRenamingRuntimeTitle(true);
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
      setRuntimeNotice({
        message: dashboardRuntimeErrorMessage(error, "대시보드 제목을 저장하지 못했습니다."),
        tone: "error",
      });
      onAction("dashboard.title.update_failed", `/api/dashboards/${runtimeSelection.dashboardId}`, runtimeSelection.dashboardId, "failed");
    } finally {
      setIsRenamingRuntimeTitle(false);
    }
  };

  const refreshRuntimeDashboard = async () => {
    setIsRefreshingRuntime(true);
    try {
      const refreshed = await refreshCurrentPageWidgetData();
      setRuntimeNotice(null);
      onAction(
        refreshed ? "dashboard.runtime.refreshed" : "dashboard.runtime.refresh_failed",
        `/api/dashboards/${runtimeSelection.dashboardId}/widgets/query`,
        runtimeSelection.dashboardId,
        refreshed ? undefined : "failed",
      );
    } finally {
      setIsRefreshingRuntime(false);
    }
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
      ? widgetIds.reduce(removeRuntimeWidget, runtime)
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

    const preflightIssues = dashboardPublishPreflight(draftRuntime);
    if (preflightIssues.length) {
      const [firstIssue] = preflightIssues;
      const location = firstIssue.widgetTitle
        ? `${firstIssue.pageTitle} · ${firstIssue.widgetTitle}`
        : firstIssue.pageTitle;
      const remainingIssueCount = preflightIssues.length - 1;
      setRuntimeNotice({
        message: `게시 전 확인: ${location} — ${firstIssue.message}${remainingIssueCount ? ` 외 ${remainingIssueCount}건` : ""}`,
        tone: "error",
      });
      onAction("dashboard.runtime.publish_blocked", `/api/dashboards/${runtimeSelection.dashboardId}/publish`, runtimeSelection.dashboardId, "failed");
      return;
    }

    setIsPublishingRuntime(true);
    try {
      await cleanupEmptyVisualizationRequestWidgets();
      await publishRuntimeDashboard(runtimeSelection.dashboardId);
      updateRuntimeListStatus(runtimeSelection.dashboardId, "published");
      setRuntimeNotice({ message: "대시보드를 게시했습니다.", tone: "success" });
      setRuntimeShareLink(null);
      onAction("dashboard.runtime.published", `/api/dashboards/${runtimeSelection.dashboardId}/publish`, runtimeSelection.dashboardId);
      openRuntimeDashboard(runtimeSelection.dashboardId, "published");
    } catch (error) {
      setRuntimeNotice({
        message: dashboardRuntimeErrorMessage(error, "대시보드를 게시하지 못했습니다."),
        tone: "error",
      });
      onAction("dashboard.runtime.publish_failed", `/api/dashboards/${runtimeSelection.dashboardId}/publish`, runtimeSelection.dashboardId, "failed");
    } finally {
      setIsPublishingRuntime(false);
    }
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
      addPage: pageMutations.addPage,
      clearWidgetScrollTarget: () => setWidgetScrollTargetId(null),
      clearWidgetSelection: clearRuntimeWidgetSelection,
      closeSharePanel: () => setRuntimeShareLink(null),
      createDatasetWidget: createDatasetDraftWidget,
      createToolbarWidget: createToolbarDraftWidget,
      deletePage: pageMutations.deletePage,
      deleteWidget: widgetMutations.deleteWidget,
      layoutCommit: layoutHistory.commit,
      layoutRejected: () => setRuntimeNotice({ message: "위젯이 겹쳐 원래 위치로 되돌렸습니다.", tone: "error" }),
      openDraft: () => openRuntimeDashboard(runtimeSelection.dashboardId, "draft"),
      openPublished: () => openRuntimeDashboard(runtimeSelection.dashboardId, "published"),
      publishDraft: publishDraftRuntime,
      redoLayout: layoutHistory.redo,
      refresh: refreshRuntimeDashboard,
      setAutoRefreshEnabled: dashboardAutoRefresh.setEnabled,
      renamePage: pageMutations.renamePage,
      renameTitle: renameRuntimeDashboardTitle,
      retryDraft: () => void loadDraftRuntime(runtimeSelection.dashboardId),
      retryPublished: () => void loadPublishedRuntime(runtimeSelection.dashboardId),
      retryWidgetData,
      selectDataset: selectRuntimeDataset,
      selectWidgetDataset: selectRuntimeWidgetDataset,
      selectPage: setSelectedRuntimePageId,
      selectWidget: selectRuntimeWidget,
      share: shareRuntimeDashboard,
      toggleDatasetSidebar: () => setIsDatasetSidebarOpen((open) => !open),
      previewWidget: previewRuntimeWidget,
      undoLayout: layoutHistory.undo,
      updateWidget: widgetMutations.updateWidget,
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
      deletingWidgetId: widgetMutations.deletingWidgetId,
      draftError,
      draftLoading,
      draftRuntime,
      canRedoLayout: layoutHistory.canRedo,
      canUndoLayout: layoutHistory.canUndo,
      hasPublishedRevision: runtimeHasPublishedRevision,
      isAddingPage: pageMutations.isAddingPage,
      isDatasetSidebarOpen,
      isCreatingToolbarWidget,
      isPublishing: isPublishingRuntime,
      isRenamingTitle: isRenamingRuntimeTitle,
      isRefreshing: isRefreshingRuntime,
      autoRefreshEnabled: dashboardAutoRefresh.enabled,
      autoRefreshError: dashboardAutoRefresh.errorMessage,
      autoRefreshStatus: dashboardAutoRefresh.status,
      mode: runtimeSelection.mode,
      notice: runtimeNotice,
      pages: runtimePages,
      publishedRuntime,
      renamingPageId: pageMutations.renamingPageId,
      runtimeError,
      runtimeLoading,
      selectedDraftWidgets: dashboardDatasetCatalogReady
        ? previewDraftWidgets.filter((widget) => !widget.datasetId || (!deletedDatasetIds.has(widget.datasetId) && availableDashboardDatasetIds.has(widget.datasetId)))
        : previewDraftWidgets.filter((widget) => !widget.datasetId || !deletedDatasetIds.has(widget.datasetId)),
      selectedDraftWidget,
      selectedPageId: selectedRuntimePageId,
      selectedPublishedWidgets: visibleSelectedPublishedWidgets,
      selectedWidgetId,
      shareLink: runtimeShareLink,
      title: runtimeTitle,
      updatingWidgetId: widgetMutations.updatingWidgetId,
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

  return null;
}
