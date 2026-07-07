import type { LayoutItem } from "react-grid-layout";
import { BarChart3, MousePointer2, Redo2, Type, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  DashboardRuntimeMode,
  DashboardRuntimePage,
  DashboardRuntimeResponse,
  DashboardRuntimeWidget,
} from "../../../types";
import askLakeNessiIconUrl from "../../../assets/asklake-nessi-icon.png";
import type { DashboardAssistantWidgetPatch } from "../../../services/dashboardAssistantService";
import { DashboardCanvas } from "./DashboardCanvas";
import { DashboardAssistantPanel } from "./DashboardAssistantPanel";
import { DashboardRuntimeShell } from "./DashboardRuntimeShell";
import { DatasetSidebar } from "./DatasetSidebar";
import { EmptyDashboardCanvas } from "./EmptyDashboardCanvas";
import { WidgetConfigPanel } from "./WidgetConfigPanel";
import { WidgetFrame } from "./WidgetFrame";
import type { DashboardAssistantPromptInsertion } from "./DashboardAssistantPanel";
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
  createDatasetWidget: (input: CreateDraftWidgetFormInput) => Promise<void> | void;
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
  selectDataset: (datasetId: string) => void;
  selectWidgetDataset: (datasetId: string) => void;
  selectPage: (pageId: string) => void;
  selectWidget: (widgetId: string) => void;
  share: () => void;
  toggleDatasetSidebar: () => void;
  undoLayout: () => void;
  updateWidget: (widgetId: string, input: UpdateDraftWidgetFormInput) => Promise<void> | void;
};

type DashboardRuntimeViewProps = {
  actions: DashboardRuntimeViewActions;
  datasets: DashboardRuntimeDatasetState;
  runtime: DashboardRuntimeState;
};

function AskLakeNessiIcon({ size = 20 }: { size?: number }) {
  return <img alt="" aria-hidden="true" className="asklake-toolbar-nessi-icon" height={size} src={askLakeNessiIconUrl} width={size} />;
}

function DashboardEditToolbar({
  assistantActive,
  canRedo,
  canUndo,
  disabled,
  onAssistant,
  onCreateToolbarWidget,
  onCursor,
  onRedo,
  onUndo,
}: {
  assistantActive: boolean;
  canRedo: boolean;
  canUndo: boolean;
  disabled: boolean;
  onAssistant: () => void;
  onCreateToolbarWidget: (kind: ToolbarDraftWidgetKind) => Promise<void> | void;
  onCursor: () => void;
  onRedo: () => void;
  onUndo: () => void;
}) {
  return (
    <div className="asklake-dashboard-edit-toolbar" role="toolbar" aria-label="대시보드 편집 도구">
      <button
        aria-label="AskLake 보조 패널"
        className={assistantActive ? "active asklake-toolbar-assistant" : "asklake-toolbar-assistant"}
        title="AskLake 보조 패널"
        type="button"
        onClick={onAssistant}
      >
        <AskLakeNessiIcon />
      </button>
      <span aria-hidden="true" />
      <button aria-label="이동 모드" className={!assistantActive ? "active" : undefined} title="이동" type="button" onClick={onCursor}>
        <MousePointer2 size={18} />
      </button>
      <span aria-hidden="true" />
      <button aria-label="시각화 추가" disabled={disabled} title="시각화 추가" type="button" onClick={() => void onCreateToolbarWidget("visualization")}>
        <BarChart3 size={18} />
      </button>
      <button aria-label="텍스트 추가" disabled={disabled} title="텍스트 추가" type="button" onClick={() => void onCreateToolbarWidget("text")}>
        <Type size={18} />
      </button>
      <span aria-hidden="true" />
      <button aria-label="실행 취소" disabled={!canUndo} title="실행 취소" type="button" onClick={onUndo}>
        <Undo2 size={18} />
      </button>
      <button aria-label="다시 실행" disabled={!canRedo} title="다시 실행" type="button" onClick={onRedo}>
        <Redo2 size={18} />
      </button>
    </div>
  );
}

function hidesInspectorForWidget(widget: DashboardRuntimeWidget | null) {
  return widget?.config.placeholderKind === "text";
}

function isVisualizationRequestWidget(widget: DashboardRuntimeWidget | null) {
  return widget?.config.placeholderKind === "visualization_request";
}

const emptyDashboardCopy = {
  description: "왼쪽 사이드바에서 데이터셋을 선택 후, 오른쪽 사이드바에서 위젯을 생성할 수 있습니다",
  title: "위젯을 추가해 주세요",
};

export function DashboardRuntimeView({
  actions,
  datasets,
  runtime,
}: DashboardRuntimeViewProps) {
  const assistantPromptInsertionIdRef = useRef(0);
  const visualizationPromptInsertionIdRef = useRef(0);
  const [assistantPromptInsertion, setAssistantPromptInsertion] = useState<DashboardAssistantPromptInsertion | null>(null);
  const [visualizationPromptInsertion, setVisualizationPromptInsertion] = useState<VisualizationPromptInsertion | null>(null);
  const [focusedColorSlot, setFocusedColorSlot] = useState<DashboardWidgetColorSlotFocus | null>(null);
  const [aiWorkingWidgetId, setAiWorkingWidgetId] = useState<string | null>(null);
  const [inspectorMode, setInspectorMode] = useState<"assistant" | "widget">("widget");
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
  const openDraftAction = (
    <button className="asklake-dashboard-empty-action" type="button" onClick={onOpenDraft}>
      위젯 편집
    </button>
  );
  const retryAction = (
    <button className="asklake-dashboard-empty-action" type="button" onClick={onRetryPublished}>
      다시 시도
    </button>
  );
  const draftRetryAction = (
    <button className="asklake-dashboard-empty-action" type="button" onClick={onRetryDraft}>
      다시 시도
    </button>
  );

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
    const nextConfig = {
      ...widget.config,
      ...(patch.config ?? {}),
    } as Record<string, unknown>;

    if (widget.config.placeholderKind === "visualization_request" && (patch.config || patch.datasetId || patch.type || patch.title)) {
      delete nextConfig.placeholderKind;
    }

    return nextConfig as UpdateDraftWidgetFormInput["config"];
  };
  const applyWidgetPatch = (widget: DashboardRuntimeWidget, patch: DashboardAssistantWidgetPatch) => onUpdateWidget(widget.id, {
    config: mergeAssistantWidgetConfig(widget, patch),
    datasetId: patch.datasetId ?? widget.datasetId ?? null,
    title: patch.title ?? widget.title ?? "제목 없는 위젯",
    type: patch.type ?? widget.type,
  });
  const assistantContext = {
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
    const targetWidgetId = selectedDraftWidget?.id;
    if (!targetWidgetId || !isVisualizationRequestWidget(selectedDraftWidget)) return;
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
    if (inspectorMode !== "assistant") setInspectorMode("widget");
    onSelectWidget(widgetId);
  };
  const handleSelectWidgetColorSlot = (widgetId: string, slotIndex: number) => {
    if (inspectorMode === "assistant") {
      setFocusedColorSlot(null);
      if (selectedWidgetId !== widgetId) onSelectWidget(widgetId);
      return;
    }

    setInspectorMode("widget");
    setFocusedColorSlot({ slotIndex, widgetId });
    if (selectedWidgetId !== widgetId) onSelectWidget(widgetId);
  };
  const handleCreateToolbarWidget = async (kind: ToolbarDraftWidgetKind) => {
    setInspectorMode("widget");
    await onCreateToolbarWidget(kind);
  };
  const handleSelectDataset = (datasetId: string) => {
    onSelectDataset(datasetId);
    const dataset = dashboardDatasets.find((item) => item.id === datasetId);
    if (!dataset) return;

    if (inspectorMode === "assistant") {
      queueAssistantPromptText(`${dataset.name} 데이터셋으로`);
      return;
    }

    queueVisualizationPromptText(`${dataset.name} 데이터셋으로`);
  };
  const handleSelectDatasetColumn = (dataset: DashboardDatasetOption, column: DashboardDatasetColumn) => {
    if (inspectorMode === "assistant") {
      queueAssistantPromptText(`${dataset.name} 데이터셋의 ${column.name} 컬럼`);
      return;
    }

    queueVisualizationPromptText(`${dataset.name} 데이터셋의 ${column.name} 컬럼`);
  };
  const selectedWidgetHidesInspector = hidesInspectorForWidget(selectedDraftWidget);
  const isAssistantInspectorOpen = isDraftMode && inspectorMode === "assistant";
  const configurableDraftWidget = selectedWidgetHidesInspector ? null : selectedDraftWidget;

  useEffect(() => {
    if (selectedWidgetHidesInspector) onPreviewWidget(null);
  }, [onPreviewWidget, selectedWidgetHidesInspector, selectedWidgetId]);

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
    <div className="asklake-dashboard-widget-grid" aria-label="Published dashboard widgets">
      {selectedPublishedWidgets.map((widget) => <WidgetFrame key={widget.id} widget={widget} />)}
    </div>
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
        inspector={isAssistantInspectorOpen ? (
          <aside className="asklake-dashboard-inspector assistant">
            <DashboardAssistantPanel
              dashboardId={assistantContext.dashboardId}
              pageId={selectedPageId}
              promptInsertion={assistantPromptInsertion}
              selectedWidget={selectedDraftWidget}
              widgets={selectedDraftWidgets}
              onCreateWidget={onCreateDatasetWidget}
              onUpdateWidget={onUpdateWidget}
            />
          </aside>
        ) : isDraftMode && !selectedWidgetHidesInspector ? (
          <aside className="asklake-dashboard-inspector">
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
        mode={mode}
        notice={notice}
        pages={pages}
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
      >
        {canShowEditToolbar ? (
          <div className="asklake-dashboard-edit-stage">
            {runtimeCanvas}
            <DashboardEditToolbar
              assistantActive={isAssistantInspectorOpen}
              canRedo={canRedoLayout}
              canUndo={canUndoLayout}
              disabled={isCreatingToolbarWidget || !selectedPageId}
              onAssistant={() => setInspectorMode("assistant")}
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
