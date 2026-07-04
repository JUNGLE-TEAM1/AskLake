import { Eye, Pencil, RefreshCw, Send, Share2 } from "lucide-react";

export function DashboardTopBar({
  hasPublishedRevision,
  isPublishing = false,
  isRefreshing = false,
  mode,
  onOpenDraft,
  onOpenPublished,
  onPublishDraft,
  onRefresh,
  onShare,
  title,
}: {
  hasPublishedRevision?: boolean;
  isPublishing?: boolean;
  isRefreshing?: boolean;
  mode: "published" | "draft";
  onOpenDraft?: () => void;
  onOpenPublished?: () => void;
  onPublishDraft?: () => void;
  onRefresh?: () => void;
  onShare?: () => void;
  title: string;
}) {
  return (
    <header className="asklake-dashboard-topbar">
      <div className="asklake-dashboard-title">
        <span>{mode === "published" ? "게시된 내용 보기" : "초안 편집"}</span>
        <h1>{title}</h1>
      </div>
      <div className="asklake-dashboard-actions">
        {mode === "published" ? (
          <button className="asklake-dashboard-action primary" type="button" onClick={onOpenDraft}>
            <Pencil size={16} />
            초안 편집
          </button>
        ) : (
          <>
            <button
              className="asklake-dashboard-action primary"
              disabled={isPublishing}
              type="button"
              onClick={onPublishDraft}
            >
              <Send size={16} />
              {isPublishing ? "게시 중" : "게시"}
            </button>
            {hasPublishedRevision && (
              <button className="asklake-dashboard-action" type="button" onClick={onOpenPublished}>
                <Eye size={16} />
                게시된 내용 보기
              </button>
            )}
          </>
        )}
        <button
          aria-label="대시보드 새로고침"
          className="asklake-dashboard-icon-action"
          disabled={isRefreshing}
          title="새로고침"
          type="button"
          onClick={onRefresh}
        >
          <RefreshCw size={17} />
        </button>
        <button className="asklake-dashboard-action" type="button" aria-label="대시보드 공유" onClick={onShare}>
          <Share2 size={16} />
          공유
        </button>
      </div>
    </header>
  );
}
