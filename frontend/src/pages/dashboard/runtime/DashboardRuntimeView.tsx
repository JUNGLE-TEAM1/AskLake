import type { LayoutItem } from "react-grid-layout";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  DashboardRuntimeMode,
  DashboardRuntimePage,
  DashboardRuntimeResponse,
  DashboardRuntimeWidget,
} from "../../../types";
import type { DashboardAssistantWidgetPatch } from "../../../services/dashboardAssistantService";
import type { RealtimeConnectionState } from "../../../services/realtimeEvents";
import { DashboardCanvas } from "./DashboardCanvas";
import { DashboardAssistantPanel } from "./DashboardAssistantPanel";
import { DashboardEditToolbar } from "./DashboardEditToolbar";
import { DashboardRuntimeShell } from "./DashboardRuntimeShell";
import { DatasetSidebar } from "./DatasetSidebar";
import { EmptyDashboardCanvas } from "./EmptyDashboardCanvas";
import { WidgetConfigPanel } from "./WidgetConfigPanel";
import { WidgetFrame } from "./WidgetFrame";
import type { DashboardAssistantPromptInsertion } from "./DashboardAssistantPanel";
import type { DashboardLiveDataState } from "./dashboardLiveRefresh";
import type {
  CreateDraftWidgetFormInput,
  DashboardDatasetColumn,
  DashboardDatasetOption,
  DashboardWidgetColorSlotFocus,
  ToolbarDraftWidgetKind,
  UpdateDraftWidgetFormInput,
} from "./dashboardRuntimeTypes";

type RuntimeNotice = {
  message: string;
  tone: "success" | "info" | "error";
};

type VisualizationPromptInsertion = {
  id: number;
  text: string;
  widgetId: string;
};

type DashboardRuntimeState = {
  canRedoLayout: boolean;
  canUndoLayout: boolean;
  deletingWidgetId: string | null;
  draftError: string | null;
  draftLoading: boolean;
  draftRuntime: DashboardRuntimeResponse | null;
  hasPublishedRevision: boolean;
  isAddingPage: boolean;
  isCreatingToolbarWidget: boolean;
  isDatasetSidebarOpen: boolean;
  isPublishing: boolean;
  isRenamingTitle: boolean;
  isRefreshing: boolean;
  mode: DashboardRuntimeMode;
  notice: RuntimeNotice | null;
  pages: DashboardRuntimePage[];
  publishedRuntime: DashboardRuntimeResponse | null;
  realtimeConnectionState: RealtimeConnectionState;
  realtimeDataState: DashboardLiveDataState;
  renamingPageId: string | null;
  runtimeError: string | null;
  runtimeLoading: boolean;
  selectedDraftWidgets: DashboardRuntimeWidget[];
  selectedDraftWidget: DashboardRuntimeWidget | null;
  selectedPageId: string | null;
  selectedPublishedWidgets: DashboardRuntimeWidget[];
  selectedWidgetId: string | null;
  shareLink: string | null;
  title: string;
  updatingWidgetId: string | null;
  widgetScrollTargetId: string | null;
};

type DashboardRuntimeDatasetState = {
  datasets: DashboardDatasetOption[];
  error: Error | null;
  isCreatingWidget: boolean;
  isLoading: boolean;
  selectedDataset: DashboardDatasetOption | null;
  selectedDatasetId: string | null;
};

type DashboardRuntimeViewActions = {
  addPage: () => void;
  clearWidgetScrollTarget: () => void;
  clearWidgetSelection: () => void;
  closeSharePanel: () => void;
  createDatasetWidget: (input: CreateDraftWidgetFormInput) => Promise<boolean>;
  createToolbarWidget: (kind: ToolbarDraftWidgetKind) => Promise<void> | void;
  deletePage: (pageId: string) => void;
  deleteWidget: (widgetId: string) => void;
  layoutCommit: (layout: LayoutItem[]) => void;
  layoutRejected: () => void;
  openDraft: () => void;
  openPublished: () => void;
  previewWidget: (widget: DashboardRuntimeWidget | null) => void;
  publishDraft: () => void;
  redoLayout: () => void;
  refresh: () => void;
  renamePage: (pageId: string, title: string) => Promise<void> | void;
  renameTitle: (title: string) => Promise<void> | void;
  retryDraft: () => void;
  retryPublished: () => void;
  retryWidgetData: (widgetId: string) => void;
  selectDataset: (datasetId: string) => void;
  selectWidgetDataset: (datasetId: string) => void;
  selectPage: (pageId: string) => void;
  selectWidget: (widgetId: string) => void;
  share: () => void;
  toggleDatasetSidebar: () => void;
  undoLayout: () => void;
  updateWidget: (widgetId: string, input: UpdateDraftWidgetFormInput) => Promise<boolean>;
};

type DashboardRuntimeViewProps = {
  actions: DashboardRuntimeViewActions;
  datasets: DashboardRuntimeDatasetState;
  runtime: DashboardRuntimeState;
};

function cloneDatasetRows(datasets: DashboardDatasetOption[], datasetId: string | null | undefined) {
  if (!datasetId) return undefined;
  const rows = datasets.find((dataset) => dataset.id === datasetId)?.rows;
  return rows?.map((row) => ({ ...row }));
}

function hidesInspectorForWidget(widget: DashboardRuntimeWidget | null) {
  return widget?.config.placeholderKind === "text";
}

function isVisualizationRequestWidget(widget: DashboardRuntimeWidget | null) {
  if (!widget) return false;
  return widget.config.placeholderKind === "visualization_request"
    || (widget.title === "시각화 요청" && !widget.datasetId && widget.data.length === 0);
}

const emptyDashboardCopy = {
  description: "편집 모드에서 페이지와 위젯을 구성한 뒤 게시하면 이 화면에서 확인할 수 있습니다.",
  title: "게시된 위젯이 없습니다",
};

function PublishedDashboardWidgetGrid({
  onRetryData,
  widgets,
}: {
  onRetryData: (widgetId: string) => void;
  widgets: DashboardRuntimeWidget[];
}) {
  return (
    <div className="asklake-dashboard-widget-grid" aria-label="Published dashboard widgets">
      {widgets.map((widget) => (
        <WidgetFrame key={widget.id} widget={widget} onRetryData={onRetryData} />
      ))}
    </div>
  );
}

function RuntimeActionButton({
  onClick,
  primary = false,
}: {
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <Button type="button" variant={primary ? undefined : "outline"} onClick={onClick}>
      {primary ? "위젯 편집" : "다시 시도"}
    </Button>
  );
}

export function DashboardRuntimeView({ actions, datasets, runtime }: DashboardRuntimeViewProps) {
  const assistantPromptInsertionIdRef = useRef(0);
  const visualizationPromptTargetWidgetIdRef = useRef<string | null>(null);
  const visualizationPromptInsertionIdRef = useRef(0);
  const [assistantPromptInsertion, setAssistantPromptInsertion] = useState<DashboardAssistantPromptInsertion | null>(null);
  const [visualizationPromptInsertion, setVisualizationPromptInsertion] = useState<VisualizationPromptInsertion | null>(null);
  const [focusedColorSlot, setFocusedColorSlot] = useState<DashboardWidgetColorSlotFocus | null>(null);
  const [aiWorkingWidgetId, setAiWorkingWidgetId] = useState<string | null>(null);
  const [inspectorMode, setInspectorMode] = useState<"assistant" | "widget">("widget");
  const [isInspectorOpen, setIsInspectorOpen] = useState(true);
  const {
    canRedoLayout,
    canUndoLayout,
    deletingWidgetId,
    draftError,
    draftLoading,
    draftRuntime,
    hasPublishedRevision,
    isAddingPage,
    isCreatingToolbarWidget,
    isDatasetSidebarOpen,
    isPublishing,
    isRenamingTitle,
    isRefreshing,
    mode,
    notice,
    pages,
    publishedRuntime,
    renamingPageId,
    runtimeError,
    runtimeLoading,
    selectedDraftWidgets,
    selectedDraftWidget,
    selectedPageId,
    selectedPublishedWidgets,
    selectedWidgetId,
    shareLink,
    title,
    updatingWidgetId,
    widgetScrollTargetId,
  } = runtime;
  const {
    datasets: dashboardDatasets,
    error: dashboardDatasetsError,
    isCreatingWidget: isCreatingDatasetWidget,
    isLoading: dashboardDatasetsLoading,
    selectedDataset,
    selectedDatasetId,
  } = datasets;
  const {
    addPage: onAddPage,
    clearWidgetScrollTarget: onClearWidgetScrollTarget,
    clearWidgetSelection: onClearWidgetSelection,
    closeSharePanel: onCloseSharePanel,
    createDatasetWidget: onCreateDatasetWidget,
    createToolbarWidget: onCreateToolbarWidget,
    deletePage: onDeletePage,
    deleteWidget: onDeleteWidget,
    layoutCommit: onLayoutCommit,
    layoutRejected: onLayoutRejected,
    openDraft: onOpenDraft,
    openPublished: onOpenPublished,
    previewWidget: onPreviewWidget,
    publishDraft: onPublishDraft,
    redoLayout: onRedoLayout,
    refresh: onRefresh,
    renamePage: onRenamePage,
    renameTitle: onRenameTitle,
    retryDraft: onRetryDraft,
    retryPublished: onRetryPublished,
    retryWidgetData: onRetryWidgetData,
    selectDataset: onSelectDataset,
    selectWidgetDataset: onSelectWidgetDataset,
    selectPage: onSelectPage,
    selectWidget: onSelectWidget,
    share: onShare,
    toggleDatasetSidebar: onToggleDatasetSidebar,
    undoLayout: onUndoLayout,
    updateWidget: onUpdateWidget,
  } = actions;
  const isDraftMode = mode === "draft";
  const openDraftAction = <RuntimeActionButton onClick={onOpenDraft} primary />;
  const retryAction = <RuntimeActionButton onClick={onRetryPublished} />;
  const draftRetryAction = <RuntimeActionButton onClick={onRetryDraft} />;
  const patchWidgetConfig = (widget: DashboardRuntimeWidget, patch: Record<string, unknown>) => onUpdateWidget(widget.id, {
    config: {
      ...widget.config,
      ...patch,
    } as UpdateDraftWidgetFormInput["config"],
    datasetId: widget.datasetId ?? null,
    title: widget.title ?? "제목 없는 위젯",
    type: widget.type,
  });
  const mergeAssistantWidgetConfig = (widget: DashboardRuntimeWidget, patch: DashboardAssistantWidgetPatch) => {
    const convertsVisualizationRequest = widget.config.placeholderKind === "visualization_request" && (patch.datasetId || patch.type);
    const nextConfig = {
      ...widget.config,
      ...(patch.config ?? {}),
    } as Record<string, unknown>;

    if (convertsVisualizationRequest) {
      delete nextConfig.placeholderKind;
      if (typeof nextConfig.description === "string" && nextConfig.description.includes("mock fallback")) {
        delete nextConfig.description;
      }
      if (typeof nextConfig.body === "string" && nextConfig.body.includes("mock fallback")) {
        delete nextConfig.body;
      }
    }

    return nextConfig as UpdateDraftWidgetFormInput["config"];
  };
  const applyWidgetPatch = (widget: DashboardRuntimeWidget, patch: DashboardAssistantWidgetPatch) => {
    const nextDatasetId = patch.datasetId ?? widget.datasetId ?? selectedDatasetId ?? null;
    const nextData = cloneDatasetRows(dashboardDatasets, nextDatasetId);

    return onUpdateWidget(widget.id, {
      config: mergeAssistantWidgetConfig(widget, patch),
      data: nextData?.length ? nextData : undefined,
      datasetId: nextDatasetId,
      title: patch.title ?? widget.title ?? "제목 없는 위젯",
      type: patch.type ?? widget.type,
    });
  };
  const assistantContext = {
    activeDatasetId: selectedDatasetId,
    dashboardId: draftRuntime?.dashboard.id ?? title,
    onWorkingWidgetChange: setAiWorkingWidgetId,
    pageId: selectedPageId,
    promptInsertion: visualizationPromptInsertion,
    selectedWidgetId,
    workingWidgetId: aiWorkingWidgetId,
    widgets: selectedDraftWidgets,
  };
  const queueAssistantPromptText = (text: string) => {
    if (inspectorMode !== "assistant") return;
    assistantPromptInsertionIdRef.current += 1;
    setAssistantPromptInsertion({
      id: assistantPromptInsertionIdRef.current,
      text,
    });
  };
  const queueVisualizationPromptText = (text: string) => {
    const targetWidgetId = selectedDraftWidget && isVisualizationRequestWidget(selectedDraftWidget)
      ? selectedDraftWidget.id
      : visualizationPromptTargetWidgetIdRef.current;
    if (!targetWidgetId) return;
    visualizationPromptInsertionIdRef.current += 1;
    setVisualizationPromptInsertion({
      id: visualizationPromptInsertionIdRef.current,
      text,
      widgetId: targetWidgetId,
    });
  };
  const handleCursorMode = () => {
    setInspectorMode("widget");
    setFocusedColorSlot(null);
    onClearWidgetSelection();
  };
  const handleSelectWidget = (widgetId: string) => {
    if (inspectorMode === "assistant") {
      const widget = selectedDraftWidgets.find((item) => item.id === widgetId);
      if (widget) queueAssistantPromptText(`선택한 위젯 "${widget.title || "제목 없는 위젯"}"에 대해`);
    }
    if (inspectorMode !== "assistant") { setInspectorMode("widget"); setIsInspectorOpen(true); }
    onSelectWidget(widgetId);
  };
  const handleSelectWidgetColorSlot = (widgetId: string, slotIndex: number) => {
    if (inspectorMode === "assistant") {
      setFocusedColorSlot(null);
      if (selectedWidgetId !== widgetId) onSelectWidget(widgetId);
      return;
    }

    setInspectorMode("widget");
    setIsInspectorOpen(true);
    setFocusedColorSlot({ slotIndex, widgetId });
    if (selectedWidgetId !== widgetId) onSelectWidget(widgetId);
  };
  const handleCreateToolbarWidget = async (kind: ToolbarDraftWidgetKind) => {
    setInspectorMode("widget");
    setIsInspectorOpen(true);
    await onCreateToolbarWidget(kind);
  };
  const handleSelectDataset = (datasetId: string) => {
    onSelectDataset(datasetId);
    const dataset = dashboardDatasets.find((item) => item.id === datasetId);
    if (!dataset) return;

    if (inspectorMode === "assistant") {
      queueAssistantPromptText(dataset.name);
      return;
    }

    setIsInspectorOpen(true);
    queueVisualizationPromptText(dataset.name);
  };
  const handleSelectDatasetColumn = (dataset: DashboardDatasetOption, column: DashboardDatasetColumn) => {
    if (inspectorMode === "assistant") {
      queueAssistantPromptText(column.name);
      onSelectDataset(dataset.id);
      return;
    }

    setIsInspectorOpen(true);
    queueVisualizationPromptText(column.name);
    onSelectDataset(dataset.id);
  };
  const selectedWidgetHidesInspector = hidesInspectorForWidget(selectedDraftWidget);
  const isAssistantInspectorOpen = isDraftMode && inspectorMode === "assistant";
  const isInspectorAvailable = isAssistantInspectorOpen || (isDraftMode && !selectedWidgetHidesInspector);
  const configurableDraftWidget = selectedWidgetHidesInspector ? null : selectedDraftWidget;

  useEffect(() => {
    if (selectedWidgetHidesInspector) onPreviewWidget(null);
  }, [onPreviewWidget, selectedWidgetHidesInspector, selectedWidgetId]);

  useEffect(() => {
    if (!selectedDraftWidget) return;
    visualizationPromptTargetWidgetIdRef.current = isVisualizationRequestWidget(selectedDraftWidget)
      ? selectedDraftWidget.id
      : null;
  }, [selectedDraftWidget]);

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
        deletingWidgetId={deletingWidgetId}
        editable
        selectedWidgetId={selectedWidgetId}
        scrollTargetWidgetId={widgetScrollTargetId}
        widgets={selectedDraftWidgets}
        assistantContext={assistantContext}
        onDeleteWidget={onDeleteWidget}
        onApplyWidgetPatch={applyWidgetPatch}
        onLayoutCommit={onLayoutCommit}
        onLayoutRejected={onLayoutRejected}
        onPatchWidgetConfig={patchWidgetConfig}
        onRetryWidgetData={onRetryWidgetData}
        onScrollTargetHandled={onClearWidgetScrollTarget}
        onSelectWidget={handleSelectWidget}
        onSelectWidgetColorSlot={handleSelectWidgetColorSlot}
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
      <EmptyDashboardCanvas action={openDraftAction} editable={false} {...emptyDashboardCopy} />
    </div>
  ) : !pages.length ? (
    <div className="asklake-dashboard-empty-canvas">
      <EmptyDashboardCanvas action={openDraftAction} editable={false} {...emptyDashboardCopy} />
    </div>
  ) : selectedPublishedWidgets.length === 0 ? (
    <div className="asklake-dashboard-empty-canvas">
      <EmptyDashboardCanvas action={openDraftAction} editable={false} {...emptyDashboardCopy} />
    </div>
  ) : (
    <PublishedDashboardWidgetGrid widgets={selectedPublishedWidgets} onRetryData={onRetryWidgetData} />
  );

  const canShowEditToolbar = isDraftMode && Boolean(draftRuntime?.revision) && !draftLoading && !draftError;

  return (
    <div className="dashboard-page dashboard-runtime-page">
      <DashboardRuntimeShell
        datasetSidebar={isDraftMode ? (
          <DatasetSidebar
            datasets={dashboardDatasets}
            error={dashboardDatasetsError}
            isOpen={isDatasetSidebarOpen}
            isLoading={dashboardDatasetsLoading}
            onClose={onToggleDatasetSidebar}
            selectedDatasetId={selectedDatasetId}
            onSelectColumn={handleSelectDatasetColumn}
            onSelectDataset={handleSelectDataset}
          />
        ) : undefined}
        datasetSidebarOpen={isDraftMode && isDatasetSidebarOpen}
        hasPublishedRevision={hasPublishedRevision}
        isAddingPage={isAddingPage}
        isPublishing={isPublishing}
        isRenamingTitle={isRenamingTitle}
        isRefreshing={isRefreshing}
        inspector={isInspectorAvailable && isInspectorOpen && isAssistantInspectorOpen ? (
          <aside className="asklake-dashboard-inspector assistant" id="asklake-dashboard-inspector">
            <DashboardAssistantPanel
              currentDatasetId={assistantContext.activeDatasetId}
              dashboardId={assistantContext.dashboardId}
              datasets={dashboardDatasets}
              pageId={selectedPageId}
              promptInsertion={assistantPromptInsertion}
              selectedWidget={selectedDraftWidget}
              widgets={selectedDraftWidgets}
              onCreateWidget={onCreateDatasetWidget}
              onUpdateWidget={onUpdateWidget}
            />
          </aside>
        ) : isInspectorAvailable && isInspectorOpen ? (
          <aside className="asklake-dashboard-inspector" id="asklake-dashboard-inspector">
            <WidgetConfigPanel
              datasets={dashboardDatasets}
              editingWidget={configurableDraftWidget}
              focusedColorSlot={focusedColorSlot}
              isCreating={isCreatingDatasetWidget}
              isUpdating={updatingWidgetId === configurableDraftWidget?.id}
              onPreviewWidgetChange={onPreviewWidget}
              selectedDataset={selectedDataset}
              selectedDatasetId={selectedDatasetId}
              onCreateWidget={onCreateDatasetWidget}
              onSelectDataset={onSelectWidgetDataset}
              onUpdateWidget={onUpdateWidget}
            />
          </aside>
        ) : undefined}
        inspectorOpen={isInspectorAvailable && isInspectorOpen}
        mode={mode}
        notice={notice}
        pages={pages}
        realtimeConnectionState={runtime.realtimeConnectionState} realtimeDataState={runtime.realtimeDataState}
        renamingPageId={renamingPageId}
        selectedPageId={selectedPageId}
        shareLink={shareLink}
        title={title}
        onAddPage={onAddPage}
        onCloseSharePanel={onCloseSharePanel}
        onDeletePage={onDeletePage}
        onOpenDraft={onOpenDraft}
        onOpenPublished={onOpenPublished}
        onPublishDraft={onPublishDraft}
        onRefresh={onRefresh}
        onRenamePage={isDraftMode ? onRenamePage : undefined}
        onRenameTitle={isDraftMode ? onRenameTitle : undefined}
        onSelectPage={onSelectPage}
        onShare={onShare}
        onToggleDatasetSidebar={isDraftMode ? onToggleDatasetSidebar : undefined}
        onToggleInspector={isInspectorAvailable ? () => setIsInspectorOpen((open) => !open) : undefined}
      >
        {canShowEditToolbar ? (
          <div className="asklake-dashboard-edit-stage">
            {runtimeCanvas}
            <DashboardEditToolbar
              assistantActive={isAssistantInspectorOpen}
              canRedo={canRedoLayout}
              canUndo={canUndoLayout}
              disabled={isCreatingToolbarWidget || !selectedPageId}
              onAssistant={() => {
                setInspectorMode("assistant");
                setIsInspectorOpen(true);
              }}
              onCursor={handleCursorMode}
              onCreateToolbarWidget={handleCreateToolbarWidget}
              onRedo={onRedoLayout}
              onUndo={onUndoLayout}
            />
          </div>
        ) : runtimeCanvas}
      </DashboardRuntimeShell>
    </div>
  );
}
