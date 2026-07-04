import type React from "react";
import { Filter } from "lucide-react";
import { DashboardPageTabs } from "./DashboardPageTabs";
import { DashboardTopBar } from "./DashboardTopBar";

type DashboardPageTab = {
  id: string;
  title: string;
};

export function DashboardRuntimeShell({
  children,
  hasPublishedRevision,
  inspector,
  mode,
  onAddPage,
  onOpenDraft,
  onOpenPublished,
  onRefresh,
  onSelectPage,
  onShare,
  pages,
  selectedPageId,
  title,
}: {
  children: React.ReactNode;
  hasPublishedRevision?: boolean;
  inspector?: React.ReactNode;
  mode: "published" | "draft";
  onAddPage?: () => void;
  onOpenDraft?: () => void;
  onOpenPublished?: () => void;
  onRefresh?: () => void;
  onSelectPage: (pageId: string) => void;
  onShare?: () => void;
  pages: DashboardPageTab[];
  selectedPageId: string | null;
  title: string;
}) {
  return (
    <div className="asklake-dashboard-runtime">
      <DashboardTopBar
        hasPublishedRevision={hasPublishedRevision}
        mode={mode}
        title={title}
        onOpenDraft={onOpenDraft}
        onOpenPublished={onOpenPublished}
        onRefresh={onRefresh}
        onShare={onShare}
      />
      <div className="asklake-dashboard-subnav">
        <div className="asklake-dashboard-data-tab">
          <span aria-hidden="true">▦</span>
          데이터
        </div>
        <button className="asklake-dashboard-filter-button" type="button" aria-label="필터">
          <Filter size={17} />
        </button>
        <DashboardPageTabs
          mode={mode}
          pages={pages}
          selectedPageId={selectedPageId}
          onAddPage={onAddPage}
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
