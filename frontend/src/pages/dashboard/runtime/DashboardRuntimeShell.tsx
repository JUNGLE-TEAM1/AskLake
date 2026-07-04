import type React from "react";
import { Filter } from "lucide-react";
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
  hasPublishedRevision,
  inspector,
  isAddingPage,
  isPublishing,
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
  onSelectPage,
  onShare,
  pages,
  selectedPageId,
  shareLink,
  title,
}: {
  children: React.ReactNode;
  hasPublishedRevision?: boolean;
  inspector?: React.ReactNode;
  isAddingPage?: boolean;
  isPublishing?: boolean;
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
  onSelectPage: (pageId: string) => void;
  onShare?: () => void;
  pages: DashboardPageTab[];
  selectedPageId: string | null;
  shareLink?: string | null;
  title: string;
}) {
  return (
    <div className="asklake-dashboard-runtime">
      <DashboardTopBar
        hasPublishedRevision={hasPublishedRevision}
        isPublishing={isPublishing}
        isRefreshing={isRefreshing}
        mode={mode}
        title={title}
        onOpenDraft={onOpenDraft}
        onOpenPublished={onOpenPublished}
        onPublishDraft={onPublishDraft}
        onRefresh={onRefresh}
        onShare={onShare}
      />
      {notice && (
        <div className={`asklake-dashboard-runtime-notice ${notice.tone}`} role="status">
          {notice.message}
        </div>
      )}
      {shareLink && (
        <div className="asklake-dashboard-share-panel" role="dialog" aria-label="대시보드 공유">
          <div>
            <strong>대시보드 공유</strong>
            <span>현재 대시보드 링크를 복사했습니다.</span>
            <code>{shareLink}</code>
          </div>
          <button type="button" onClick={onCloseSharePanel}>닫기</button>
        </div>
      )}
      <div className="asklake-dashboard-subnav">
        <div className="asklake-dashboard-data-tab">
          <span aria-hidden="true">▦</span>
          데이터
        </div>
        <button className="asklake-dashboard-filter-button" type="button" aria-label="필터">
          <Filter size={17} />
        </button>
        <DashboardPageTabs
          isAddingPage={isAddingPage}
          mode={mode}
          pages={pages}
          selectedPageId={selectedPageId}
          onAddPage={onAddPage}
          onDeletePage={onDeletePage}
          onSelectPage={onSelectPage}
        />
      </div>
      <div className="asklake-dashboard-filter-row">
        <span className="asklake-dashboard-filter-chip">필터가 설정되지 않았습니다</span>
      </div>
      <div className={inspector ? "asklake-dashboard-workspace has-inspector" : "asklake-dashboard-workspace"}>
        <main className={mode === "draft" ? "asklake-dashboard-canvas-wrap edit" : "asklake-dashboard-canvas-wrap"}>
          {children}
        </main>
        {inspector}
      </div>
    </div>
  );
}
