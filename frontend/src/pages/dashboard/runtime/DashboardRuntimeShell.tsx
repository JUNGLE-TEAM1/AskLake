import type React from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { DashboardPageTabs } from "./DashboardPageTabs";
import { DashboardTopBar } from "./DashboardTopBar";

type DashboardPageTab = {
  id: string;
  title: string;
};

type RuntimeNotice = {
  message: string;
  tone: "success" | "info" | "error";
};

export function DashboardRuntimeShell({
  children,
  datasetSidebar,
  datasetSidebarOpen = false,
  hasPublishedRevision,
  inspector,
  isAddingPage,
  isPublishing,
  isRenamingTitle,
  isRefreshing,
  mode,
  notice,
  onAddPage,
  onCloseSharePanel,
  onDeletePage,
  onOpenDraft,
  onOpenPublished,
  onPublishDraft,
  onRefresh,
  onRenamePage,
  onRenameTitle,
  onSelectPage,
  onShare,
  onToggleDatasetSidebar,
  pages,
  renamingPageId,
  selectedPageId,
  shareLink,
  title,
}: {
  children: React.ReactNode;
  datasetSidebar?: React.ReactNode;
  datasetSidebarOpen?: boolean;
  hasPublishedRevision?: boolean;
  inspector?: React.ReactNode;
  isAddingPage?: boolean;
  isPublishing?: boolean;
  isRenamingTitle?: boolean;
  isRefreshing?: boolean;
  mode: "published" | "draft";
  notice?: RuntimeNotice | null;
  onAddPage?: () => void;
  onCloseSharePanel?: () => void;
  onDeletePage?: (pageId: string) => void;
  onOpenDraft?: () => void;
  onOpenPublished?: () => void;
  onPublishDraft?: () => void;
  onRefresh?: () => void;
  onRenamePage?: (pageId: string, title: string) => Promise<void> | void;
  onRenameTitle?: (title: string) => Promise<void> | void;
  onSelectPage: (pageId: string) => void;
  onShare?: () => void;
  onToggleDatasetSidebar?: () => void;
  pages: DashboardPageTab[];
  renamingPageId?: string | null;
  selectedPageId: string | null;
  shareLink?: string | null;
  title: string;
}) {
  const hasDatasetSidebar = Boolean(datasetSidebar);
  const canToggleDatasetSidebar = hasDatasetSidebar && Boolean(onToggleDatasetSidebar);
  const workspaceClassName = [
    "asklake-dashboard-workspace",
    hasDatasetSidebar && "has-dataset-sidebar",
    hasDatasetSidebar && datasetSidebarOpen && "dataset-sidebar-open",
    inspector && "has-inspector",
  ].filter(Boolean).join(" ");

  return (
    <div className="asklake-dashboard-runtime">
      <DashboardTopBar
        hasPublishedRevision={hasPublishedRevision}
        isPublishing={isPublishing}
        isRenaming={isRenamingTitle}
        isRefreshing={isRefreshing}
        mode={mode}
        title={title}
        onOpenDraft={onOpenDraft}
        onOpenPublished={onOpenPublished}
        onPublishDraft={onPublishDraft}
        onRefresh={onRefresh}
        onRenameTitle={onRenameTitle}
        onShare={onShare}
      />
      {notice && (
        <div className={`asklake-dashboard-runtime-notice ${notice.tone}`} role="status">
          {notice.message}
        </div>
      )}
      <Sheet
        open={Boolean(shareLink)}
        onOpenChange={(isOpen) => {
          if (!isOpen) onCloseSharePanel?.();
        }}
      >
        <SheetContent className="asklake-dashboard-share-sheet" closeLabel="공유 패널 닫기" side="right">
          <SheetHeader>
            <SheetTitle>대시보드 공유</SheetTitle>
            <SheetDescription>현재 대시보드 링크를 복사했습니다.</SheetDescription>
          </SheetHeader>
          {shareLink && (
            <div className="asklake-dashboard-share-sheet-body">
              <code className="asklake-dashboard-share-link">{shareLink}</code>
            </div>
          )}
          <SheetFooter className="asklake-dashboard-share-sheet-footer">
            <Button type="button" variant="outline" onClick={onCloseSharePanel}>
              닫기
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      <div className="asklake-dashboard-subnav">
        {canToggleDatasetSidebar && (
          <button
            aria-controls="asklake-dashboard-dataset-sidebar"
            aria-pressed={datasetSidebarOpen}
            className={datasetSidebarOpen ? "asklake-dashboard-data-tab active" : "asklake-dashboard-data-tab"}
            type="button"
            onClick={onToggleDatasetSidebar}
          >
            <span aria-hidden="true">▦</span>
            데이터
          </button>
        )}
        <DashboardPageTabs
          isAddingPage={isAddingPage}
          mode={mode}
          pages={pages}
          renamingPageId={renamingPageId}
          selectedPageId={selectedPageId}
          onAddPage={onAddPage}
          onDeletePage={onDeletePage}
          onRenamePage={onRenamePage}
          onSelectPage={onSelectPage}
        />
      </div>
      <div className={workspaceClassName}>
        {datasetSidebar}
        <main className={mode === "draft" ? "asklake-dashboard-canvas-wrap edit" : "asklake-dashboard-canvas-wrap"}>
          {children}
        </main>
        {inspector}
      </div>
    </div>
  );
}
