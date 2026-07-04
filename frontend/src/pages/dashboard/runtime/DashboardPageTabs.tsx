import { useEffect, useRef } from "react";
import { Plus, X } from "lucide-react";

type DashboardPageTab = {
  id: string;
  title: string;
};

export function DashboardPageTabs({
  isAddingPage = false,
  mode,
  onAddPage,
  onDeletePage,
  onSelectPage,
  pages,
  selectedPageId,
}: {
  isAddingPage?: boolean;
  mode: "published" | "draft";
  onAddPage?: () => void;
  onDeletePage?: (pageId: string) => void;
  onSelectPage: (pageId: string) => void;
  pages: DashboardPageTab[];
  selectedPageId: string | null;
}) {
  const selectedTabRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    selectedTabRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [selectedPageId, pages.length]);

  return (
    <div className="asklake-dashboard-tabs" role="tablist" aria-label="대시보드 페이지">
      {pages.map((page) => {
        const isSelected = page.id === selectedPageId;
        return (
          <span
            className={isSelected ? "asklake-dashboard-page-tab active" : "asklake-dashboard-page-tab"}
            key={page.id}
            ref={isSelected ? selectedTabRef : undefined}
          >
            <button
              aria-selected={isSelected}
              className="asklake-dashboard-tab-button"
              role="tab"
              type="button"
              onClick={() => onSelectPage(page.id)}
            >
              {page.title}
            </button>
            {mode === "draft" && (
              <button
                className="asklake-dashboard-tab-delete"
                type="button"
                aria-label={`${page.title} 페이지 삭제`}
                onClick={(event) => {
                  event.stopPropagation();
                  onDeletePage?.(page.id);
                }}
              >
                <X size={13} />
              </button>
            )}
          </span>
        );
      })}
      {mode === "draft" && (
        <button
          className="asklake-dashboard-tab-add"
          disabled={isAddingPage}
          title={isAddingPage ? "페이지 추가 중" : "페이지 추가"}
          type="button"
          aria-label={isAddingPage ? "페이지 추가 중" : "페이지 추가"}
          onClick={onAddPage}
        >
          <Plus size={18} />
        </button>
      )}
    </div>
  );
}
