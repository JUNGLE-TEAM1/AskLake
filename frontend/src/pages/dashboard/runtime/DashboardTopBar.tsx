import { useEffect, useState, type FormEvent } from "react";
import { Check, Eye, Pencil, RefreshCw, Save, Share2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DashboardPublishedRefreshStatus } from "./useDashboardRuntimeResources";

function refreshStatusLabel(
  status: DashboardPublishedRefreshStatus,
  autoRefreshIntervalMinutes: number | null | undefined,
) {
  if (status === "error") return "데이터 동기화 실패";
  if (status === "idle") return "자동 동기화 확인 중";
  if (status === "live") return `자동 동기화 · ${autoRefreshIntervalMinutes ?? "-"}분`;
  if (status === "manual") return "Kafka 자동 동기화 없음";
  if (status === "paused") return "탭 숨김 · 일시정지";
  return "데이터 동기화 중";
}

export function DashboardTopBar({
  hasPublishedRevision,
  isPublishing = false,
  isRefreshing = false,
  isRenaming = false,
  mode,
  onOpenDraft,
  onOpenPublished,
  onPublishDraft,
  onRefresh,
  onRenameTitle,
  onShare,
  publishedAutoRefreshIntervalMinutes,
  publishedRefreshedAt,
  publishedRefreshStatus = "idle",
  title,
}: {
  hasPublishedRevision?: boolean;
  isPublishing?: boolean;
  isRefreshing?: boolean;
  isRenaming?: boolean;
  mode: "published" | "draft";
  onOpenDraft?: () => void;
  onOpenPublished?: () => void;
  onPublishDraft?: () => void;
  onRefresh?: () => void;
  onRenameTitle?: (title: string) => Promise<void> | void;
  onShare?: () => void;
  publishedAutoRefreshIntervalMinutes?: number | null;
  publishedRefreshedAt?: string | null;
  publishedRefreshStatus?: DashboardPublishedRefreshStatus;
  title: string;
}) {
  const [draftTitle, setDraftTitle] = useState(title);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const canRename = mode === "draft" && Boolean(onRenameTitle);
  const lastRefreshedLabel = publishedRefreshedAt
    ? new Date(publishedRefreshedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : null;
  const effectivePublishedRefreshStatus = mode === "published" && hasPublishedRevision === false
    ? "manual"
    : publishedRefreshStatus;
  const publishedRefreshStatusLabel = refreshStatusLabel(
    effectivePublishedRefreshStatus,
    publishedAutoRefreshIntervalMinutes,
  );

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
        <span>{mode === "published" ? "보기 모드" : "편집 모드"}</span>
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
          <Badge
            aria-label={`${publishedRefreshStatusLabel}${lastRefreshedLabel ? `, 마지막 동기화 ${lastRefreshedLabel}` : ""}`}
            shape="compact"
            size="sm"
            title={lastRefreshedLabel ? `마지막 동기화 ${lastRefreshedLabel}` : undefined}
            variant={effectivePublishedRefreshStatus === "error" ? "destructive" : effectivePublishedRefreshStatus === "paused" || effectivePublishedRefreshStatus === "manual" ? "muted" : "success"}
          >
            {publishedRefreshStatusLabel}
          </Badge>
        ) : null}
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
              {isPublishing ? "저장 중" : "저장"}
            </Button>
            {hasPublishedRevision && (
              <Button className="asklake-dashboard-action" type="button" onClick={onOpenPublished} size="sm" variant="outline">
                <Eye size={16} />
                보기 모드
              </Button>
            )}
          </>
        )}
        <Button
          aria-label="대시보드 전체 동기화"
          className="asklake-dashboard-icon-action"
          disabled={isRefreshing}
          title="대시보드 전체 동기화"
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
