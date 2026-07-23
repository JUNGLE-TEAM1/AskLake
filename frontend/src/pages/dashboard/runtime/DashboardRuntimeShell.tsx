import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy, Database, PanelRightClose, PanelRightOpen } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { DashboardPageTabs } from "./DashboardPageTabs";
import { DashboardTopBar } from "./DashboardTopBar";
import type { DashboardAutoRefreshStatus } from "./dashboardAutoRefresh";

type DashboardPageTab = {
  id: string;
  title: string;
};

type RuntimeNotice = {
  message: string;
  tone: "success" | "info" | "error";
};

export function DashboardRuntimeShell({
  autoRefreshEnabled,
  autoRefreshError,
  autoRefreshStatus,
  children,
  datasetSidebar,
  datasetSidebarOpen = false,
  hasPublishedRevision,
  inspector,
  inspectorOpen = false,
  isAddingPage,
  isPublishing,
  isRenamingTitle,
  isRefreshing,
  mode,
  notice,
  onAddPage,
  onAutoRefreshChange,
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
  onToggleInspector,
  pages,
  publishUnavailableReason,
  renamingPageId,
  selectedPageId,
  shareLink,
  title,
}: {
  autoRefreshEnabled: boolean;
  autoRefreshError?: string | null;
  autoRefreshStatus: DashboardAutoRefreshStatus;
  children: ReactNode;
  datasetSidebar?: ReactNode;
  datasetSidebarOpen?: boolean;
  hasPublishedRevision?: boolean;
  inspector?: ReactNode;
  inspectorOpen?: boolean;
  isAddingPage?: boolean;
  isPublishing?: boolean;
  isRenamingTitle?: boolean;
  isRefreshing?: boolean;
  mode: "published" | "draft";
  notice?: RuntimeNotice | null;
  onAddPage?: () => void;
  onAutoRefreshChange: (enabled: boolean) => void;
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
  onToggleInspector?: () => void;
  pages: DashboardPageTab[];
  publishUnavailableReason?: string | null;
  renamingPageId?: string | null;
  selectedPageId: string | null;
  shareLink?: string | null;
  title: string;
}) {
  const [copyFeedback, setCopyFeedback] = useState<"idle" | "success" | "error">("idle");
  const hasDatasetSidebar = Boolean(datasetSidebar);
  const canToggleDatasetSidebar = hasDatasetSidebar && Boolean(onToggleDatasetSidebar);
  const canToggleInspector = Boolean(onToggleInspector);
  const workspaceClassName = [
    "asklake-dashboard-workspace",
    hasDatasetSidebar && "has-dataset-sidebar",
    hasDatasetSidebar && datasetSidebarOpen && "dataset-sidebar-open",
    inspector && "has-inspector",
  ].filter(Boolean).join(" ");

  useEffect(() => {
    setCopyFeedback("idle");
  }, [shareLink]);

  const copyShareLink = async () => {
    if (!shareLink) {
      setCopyFeedback("error");
      return;
    }

    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API is unavailable");
      await Promise.race([
        navigator.clipboard.writeText(shareLink),
        new Promise<never>((_, reject) => {
          window.setTimeout(() => reject(new Error("Clipboard API timed out")), 1200);
        }),
      ]);
      setCopyFeedback("success");
    } catch {
      const fallbackInput = document.createElement("textarea");
      fallbackInput.value = shareLink;
      fallbackInput.style.position = "fixed";
      fallbackInput.style.opacity = "0";
      document.body.appendChild(fallbackInput);
      fallbackInput.select();
      const copied = document.execCommand("copy");
      fallbackInput.remove();
      setCopyFeedback(copied ? "success" : "error");
    }
  };

  return (
    <div className="asklake-dashboard-runtime">
      <DashboardTopBar
        autoRefreshEnabled={autoRefreshEnabled}
        autoRefreshError={autoRefreshError}
        autoRefreshStatus={autoRefreshStatus}
        hasPublishedRevision={hasPublishedRevision}
        isPublishing={isPublishing}
        publishUnavailableReason={publishUnavailableReason}
        isRenaming={isRenamingTitle}
        isRefreshing={isRefreshing}
        mode={mode}
        title={title}
        onOpenDraft={onOpenDraft}
        onAutoRefreshChange={onAutoRefreshChange}
        onOpenPublished={onOpenPublished}
        onPublishDraft={onPublishDraft}
        onRefresh={onRefresh}
        onRenameTitle={onRenameTitle}
        onShare={onShare}
      />
      {notice && (
        <Alert
          className={`asklake-dashboard-runtime-notice ${notice.tone}`}
          role="status"
          variant={notice.tone === "error" ? "destructive" : "default"}
        >
          <AlertDescription>{notice.message}</AlertDescription>
        </Alert>
      )}
      {autoRefreshEnabled && autoRefreshError && (
        <Alert
          className="asklake-dashboard-runtime-notice error"
          role="status"
          variant="destructive"
        >
          <AlertDescription>{autoRefreshError}</AlertDescription>
        </Alert>
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
            <SheetDescription>게시 조회 링크를 복사해 공유할 수 있습니다.</SheetDescription>
          </SheetHeader>
          {shareLink && (
            <div className="asklake-dashboard-share-sheet-body">
              <code className="asklake-dashboard-share-link">{shareLink}</code>
              <Button type="button" onClick={() => void copyShareLink()}>
                {copyFeedback === "success" ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
                {copyFeedback === "success" ? "복사됨" : "링크 복사"}
              </Button>
              {copyFeedback === "error" ? (
                <Alert variant="destructive">
                  <AlertDescription>링크를 복사하지 못했습니다. 주소를 직접 선택해 복사해 주세요.</AlertDescription>
                </Alert>
              ) : null}
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
        <div className="asklake-dashboard-view-switcher">
          {canToggleDatasetSidebar && (
            <ToggleGroup
              aria-label="대시보드 편집 패널"
              className="asklake-dashboard-data-toggle"
              type="single"
              value={datasetSidebarOpen ? "data" : ""}
              onValueChange={(value) => {
                const nextOpen = value === "data";
                if (nextOpen !== datasetSidebarOpen) onToggleDatasetSidebar?.();
              }}
            >
              <ToggleGroupItem
                aria-controls="asklake-dashboard-dataset-sidebar"
                aria-expanded={datasetSidebarOpen}
                className="asklake-dashboard-data-tab"
                value="data"
              >
                <Database />
                데이터
              </ToggleGroupItem>
            </ToggleGroup>
          )}
          {canToggleDatasetSidebar && (mode === "draft" || pages.length > 0) ? (
            <Separator className="asklake-dashboard-view-separator" orientation="vertical" />
          ) : null}
          {(mode === "draft" || pages.length > 0) ? (
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
          ) : null}
          {canToggleInspector ? (
            <Button
              aria-controls="asklake-dashboard-inspector"
              aria-expanded={inspectorOpen}
              aria-label={inspectorOpen ? "오른쪽 설정 패널 접기" : "오른쪽 설정 패널 열기"}
              className="asklake-dashboard-inspector-toggle"
              size="sm"
              type="button"
              variant="ghost"
              onClick={onToggleInspector}
            >
              {inspectorOpen ? <PanelRightClose /> : <PanelRightOpen />}
              설정
            </Button>
          ) : null}
        </div>
      </div>
      <div className={workspaceClassName}>
        {datasetSidebar}
        <ScrollArea
          className="asklake-dashboard-canvas-scroll-area"
          scrollbars="both"
          viewportProps={{ className: "asklake-dashboard-canvas-scroll-viewport" }}
        >
          <main className={mode === "draft" ? "asklake-dashboard-canvas-wrap edit" : "asklake-dashboard-canvas-wrap"}>
            {children}
          </main>
        </ScrollArea>
        {inspector}
      </div>
    </div>
  );
}
