import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy, Database } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
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
  canManage = true,
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
  canManage?: boolean;
  children: ReactNode;
  datasetSidebar?: ReactNode;
  datasetSidebarOpen?: boolean;
  hasPublishedRevision?: boolean;
  inspector?: ReactNode;
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
  const [copyFeedback, setCopyFeedback] = useState<"idle" | "success" | "error">("idle");
  const hasDatasetSidebar = Boolean(datasetSidebar);
  const canToggleDatasetSidebar = hasDatasetSidebar && Boolean(onToggleDatasetSidebar);
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
        canManage={canManage}
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
        <Alert
          className={`asklake-dashboard-runtime-notice ${notice.tone}`}
          role="status"
          variant={notice.tone === "error" ? "destructive" : "default"}
        >
          <AlertDescription>{notice.message}</AlertDescription>
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
        {canToggleDatasetSidebar && (
          <Button
            aria-controls="asklake-dashboard-dataset-sidebar"
            aria-pressed={datasetSidebarOpen}
            className={datasetSidebarOpen ? "asklake-dashboard-data-tab active" : "asklake-dashboard-data-tab"}
            size="sm"
            type="button"
            variant={datasetSidebarOpen ? "secondary" : "ghost"}
            onClick={onToggleDatasetSidebar}
          >
            <Database data-icon="inline-start" />
            데이터
          </Button>
        )}
        {(mode === "draft" || pages.length > 0) ? (
          <DashboardPageTabs
            canManage={canManage}
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
