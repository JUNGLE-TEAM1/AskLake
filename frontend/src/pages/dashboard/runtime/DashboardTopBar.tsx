import { useEffect, useState, type FormEvent } from "react";
import { Check, Eye, Pencil, RefreshCw, Save, Share2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  dashboardAutoRefreshStatusCopy,
  type DashboardAutoRefreshStatus,
} from "./dashboardAutoRefresh";

export function DashboardTopBar({
  autoRefreshEnabled,
  autoRefreshError,
  autoRefreshStatus,
  hasPublishedRevision,
  isPublishing = false,
  isRefreshing = false,
  isRenaming = false,
  mode,
  onOpenDraft,
  onAutoRefreshChange,
  onOpenPublished,
  onPublishDraft,
  onRefresh,
  onRenameTitle,
  onShare,
  title,
}: {
  autoRefreshEnabled: boolean;
  autoRefreshError?: string | null;
  autoRefreshStatus: DashboardAutoRefreshStatus;
  hasPublishedRevision?: boolean;
  isPublishing?: boolean;
  isRefreshing?: boolean;
  isRenaming?: boolean;
  mode: "published" | "draft";
  onOpenDraft?: () => void;
  onAutoRefreshChange: (enabled: boolean) => void;
  onOpenPublished?: () => void;
  onPublishDraft?: () => void;
  onRefresh?: () => void;
  onRenameTitle?: (title: string) => Promise<void> | void;
  onShare?: () => void;
  title: string;
}) {
  void autoRefreshEnabled;
  void onAutoRefreshChange;
  const [draftTitle, setDraftTitle] = useState(title);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const canRename = mode === "draft" && Boolean(onRenameTitle);
  const autoRefreshStatusLabel = dashboardAutoRefreshStatusCopy(autoRefreshStatus);
  const autoRefreshStatusTone = autoRefreshStatus === "active"
    ? "success"
    : autoRefreshStatus === "error"
      ? "danger"
      : autoRefreshStatus === "connecting"
        ? "warning"
        : "muted";

  useEffect(() => {
    if (!isEditingTitle) setDraftTitle(title);
  }, [isEditingTitle, title]);

  const closeTitleEditor = () => {
    setDraftTitle(title);
    setIsEditingTitle(false);
  };

  const submitTitle = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextTitle = draftTitle.trim();
    if (!nextTitle || nextTitle === title) {
      closeTitleEditor();
      return;
    }

    await onRenameTitle?.(nextTitle);
    setIsEditingTitle(false);
  };

  return (
    <header className="asklake-dashboard-topbar">
      <div className="asklake-dashboard-title">
        <span>{mode === "published" ? "게시된 보기" : "Draft 편집"}</span>
        {isEditingTitle ? (
          <form className="asklake-dashboard-title-edit" onSubmit={(event) => void submitTitle(event)}>
            <Input
              aria-label="대시보드 제목"
              autoFocus
              className="asklake-dashboard-title-edit-input"
              maxLength={80}
              size="sm"
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
            />
            <Button type="submit" disabled={isRenaming || !draftTitle.trim()} aria-label="대시보드 제목 저장" size="icon" variant="outline">
              <Check size={16} />
            </Button>
            <Button type="button" disabled={isRenaming} aria-label="대시보드 제목 편집 취소" onClick={closeTitleEditor} size="icon" variant="outline">
              <X size={16} />
            </Button>
          </form>
        ) : (
          <div className="asklake-dashboard-title-row">
            <h1>{title}</h1>
            <StatusBadge
              aria-label={`대시보드 동기화 상태: ${autoRefreshStatusLabel}`}
              title={autoRefreshError ?? autoRefreshStatusLabel}
              tone={autoRefreshStatusTone}
            >
              {autoRefreshStatusLabel}
            </StatusBadge>
            {canRename && (
              <Button
                className="asklake-dashboard-title-edit-button"
                type="button"
                aria-label="대시보드 제목 수정"
                size="icon"
                variant="ghost"
                onClick={() => setIsEditingTitle(true)}
              >
                <Pencil size={15} />
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="asklake-dashboard-actions">
        {mode === "published" ? (
          <Button className="asklake-dashboard-action primary" type="button" onClick={onOpenDraft} size="sm" variant="primary">
            <Pencil size={16} />
            편집 모드
          </Button>
        ) : (
          <>
            <Button
              className="asklake-dashboard-action primary"
              disabled={isPublishing}
              type="button"
              size="sm"
              variant="primary"
              onClick={onPublishDraft}
            >
              <Save size={16} />
              {isPublishing ? "게시 중" : "게시"}
            </Button>
            {hasPublishedRevision && (
              <Button className="asklake-dashboard-action" type="button" onClick={onOpenPublished} size="sm" variant="outline">
                <Eye size={16} />
                게시된 보기
              </Button>
            )}
          </>
        )}
        <Button
          aria-label="대시보드 새로고침"
          className="asklake-dashboard-icon-action"
          disabled={isRefreshing}
          title="새로고침"
          type="button"
          size="icon"
          variant="outline"
          onClick={onRefresh}
        >
          <RefreshCw size={17} />
        </Button>
        <Button className="asklake-dashboard-action" type="button" aria-label="대시보드 공유" onClick={onShare} size="sm" variant="outline">
          <Share2 size={16} />
          공유
        </Button>
      </div>
    </header>
  );
}
