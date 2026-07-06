import type { LayoutItem } from "react-grid-layout";
import type {
  DashboardRuntimeMode,
  DashboardRuntimePage,
  DashboardRuntimeResponse,
  DashboardRuntimeWidget,
} from "../../../types";
import { DashboardCanvas } from "./DashboardCanvas";
import { DashboardRuntimeShell } from "./DashboardRuntimeShell";
import { DatasetSidebar } from "./DatasetSidebar";
import { EmptyDashboardCanvas } from "./EmptyDashboardCanvas";
import { WidgetConfigPanel } from "./WidgetConfigPanel";
import { WidgetFrame } from "./WidgetFrame";
import type { CreateDraftWidgetFormInput, DashboardDatasetOption, UpdateDraftWidgetFormInput } from "./dashboardRuntimeTypes";

type RuntimeNotice = {
  message: string;
  tone: "success" | "info" | "error";
};

type DashboardRuntimeState = {
  deletingWidgetId: string | null;
  draftError: string | null;
  draftLoading: boolean;
  draftRuntime: DashboardRuntimeResponse | null;
  hasPublishedRevision: boolean;
  isAddingPage: boolean;
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
  closeSharePanel: () => void;
  createDatasetWidget: (input: CreateDraftWidgetFormInput) => Promise<void> | void;
  deletePage: (pageId: string) => void;
  deleteWidget: (widgetId: string) => void;
  layoutCommit: (layout: LayoutItem[]) => void;
  layoutRejected: () => void;
  openDraft: () => void;
  openPublished: () => void;
  previewWidget: (widget: DashboardRuntimeWidget | null) => void;
  publishDraft: () => void;
  refresh: () => void;
  renamePage: (pageId: string, title: string) => Promise<void> | void;
  renameTitle: (title: string) => Promise<void> | void;
  retryDraft: () => void;
  retryPublished: () => void;
  selectDataset: (datasetId: string) => void;
  selectPage: (pageId: string) => void;
  selectWidget: (widgetId: string) => void;
  share: () => void;
  toggleDatasetSidebar: () => void;
  updateWidget: (widgetId: string, input: UpdateDraftWidgetFormInput) => Promise<void> | void;
};

type DashboardRuntimeViewProps = {
  actions: DashboardRuntimeViewActions;
  datasets: DashboardRuntimeDatasetState;
  runtime: DashboardRuntimeState;
};

const emptyDashboardCopy = {
  description: "왼쪽 사이드바에서 데이터셋을 선택 후, 오른쪽 사이드바에서 위젯을 생성할 수 있습니다",
  title: "위젯을 추가해 주세요",
};

export function DashboardRuntimeView({
  actions,
  datasets,
  runtime,
}: DashboardRuntimeViewProps) {
  const {
    deletingWidgetId,
    draftError,
    draftLoading,
    draftRuntime,
    hasPublishedRevision,
    isAddingPage,
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
    closeSharePanel: onCloseSharePanel,
    createDatasetWidget: onCreateDatasetWidget,
    deletePage: onDeletePage,
    deleteWidget: onDeleteWidget,
    layoutCommit: onLayoutCommit,
    layoutRejected: onLayoutRejected,
    openDraft: onOpenDraft,
    openPublished: onOpenPublished,
    previewWidget: onPreviewWidget,
    publishDraft: onPublishDraft,
    refresh: onRefresh,
    renamePage: onRenamePage,
    renameTitle: onRenameTitle,
    retryDraft: onRetryDraft,
    retryPublished: onRetryPublished,
    selectDataset: onSelectDataset,
    selectPage: onSelectPage,
    selectWidget: onSelectWidget,
    share: onShare,
    toggleDatasetSidebar: onToggleDatasetSidebar,
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
        widgets={selectedDraftWidgets}
        onDeleteWidget={onDeleteWidget}
        onLayoutCommit={onLayoutCommit}
        onLayoutRejected={onLayoutRejected}
        onSelectWidget={onSelectWidget}
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
            onSelectDataset={onSelectDataset}
          />
        ) : undefined}
        datasetSidebarOpen={isDraftMode && isDatasetSidebarOpen}
        hasPublishedRevision={hasPublishedRevision}
        isAddingPage={isAddingPage}
        isPublishing={isPublishing}
        isRenamingTitle={isRenamingTitle}
        isRefreshing={isRefreshing}
        inspector={isDraftMode ? (
          <aside className="asklake-dashboard-inspector">
            <WidgetConfigPanel
              editingWidget={selectedDraftWidget}
              isCreating={isCreatingDatasetWidget}
              isUpdating={updatingWidgetId === selectedDraftWidget?.id}
              onPreviewWidgetChange={onPreviewWidget}
              selectedDataset={selectedDataset}
              selectedDatasetId={selectedDatasetId}
              onCreateWidget={onCreateDatasetWidget}
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
        {runtimeCanvas}
      </DashboardRuntimeShell>
    </div>
  );
}
