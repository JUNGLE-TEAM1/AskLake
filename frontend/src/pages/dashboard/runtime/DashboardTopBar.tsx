import { Eye, Pencil, RefreshCw, Share2 } from "lucide-react";

export function DashboardTopBar({
  hasPublishedRevision,
  mode,
  onOpenDraft,
  onOpenPublished,
  onRefresh,
  onShare,
  title,
}: {
  hasPublishedRevision?: boolean;
  mode: "published" | "draft";
  onOpenDraft?: () => void;
  onOpenPublished?: () => void;
  onRefresh?: () => void;
  onShare?: () => void;
  title: string;
}) {
  return (
    <header className="asklake-dashboard-topbar">
      <div className="asklake-dashboard-title">
        <span>{mode === "published" ? "Published view" : "Draft editor"}</span>
        <h1>{title}</h1>
      </div>
      <div className="asklake-dashboard-actions">
        {mode === "published" ? (
          <button className="asklake-dashboard-action primary" type="button" onClick={onOpenDraft}>
            <Pencil size={16} />
            초안 편집
          </button>
        ) : (
          hasPublishedRevision && (
            <button className="asklake-dashboard-action" type="button" onClick={onOpenPublished}>
              <Eye size={16} />
              게시된 내용 보기
            </button>
          )
        )}
        <button className="asklake-dashboard-icon-action" type="button" aria-label="대시보드 새로고침" onClick={onRefresh}>
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
