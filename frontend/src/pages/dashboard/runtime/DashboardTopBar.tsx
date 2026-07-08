import { useEffect, useState, type FormEvent } from "react";
import { Check, Eye, Pencil, RefreshCw, Save, Share2, X } from "lucide-react";

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
  title: string;
}) {
  const [draftTitle, setDraftTitle] = useState(title);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const canRename = mode === "draft" && Boolean(onRenameTitle);

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
            <input
              aria-label="대시보드 제목"
              autoFocus
              maxLength={80}
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
            />
            <button type="submit" disabled={isRenaming || !draftTitle.trim()} aria-label="대시보드 제목 저장">
              <Check size={16} />
            </button>
            <button type="button" disabled={isRenaming} aria-label="대시보드 제목 편집 취소" onClick={closeTitleEditor}>
              <X size={16} />
            </button>
          </form>
        ) : (
          <div className="asklake-dashboard-title-row">
            <h1>{title}</h1>
            {canRename && (
              <button
                className="asklake-dashboard-title-edit-button"
                type="button"
                aria-label="대시보드 제목 수정"
                onClick={() => setIsEditingTitle(true)}
              >
                <Pencil size={15} />
              </button>
            )}
          </div>
        )}
      </div>
      <div className="asklake-dashboard-actions">
        {mode === "published" ? (
          <button className="asklake-dashboard-action primary" type="button" onClick={onOpenDraft}>
            <Pencil size={16} />
            편집 모드
          </button>
        ) : (
          <>
            <button
              className="asklake-dashboard-action primary"
              disabled={isPublishing}
              type="button"
              onClick={onPublishDraft}
            >
              <Save size={16} />
              {isPublishing ? "저장 중" : "저장"}
            </button>
            {hasPublishedRevision && (
              <button className="asklake-dashboard-action" type="button" onClick={onOpenPublished}>
                <Eye size={16} />
                보기 모드
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
