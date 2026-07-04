import { Plus, X } from "lucide-react";

type DashboardPageTab = {
  id: string;
  title: string;
};

export function DashboardPageTabs({
  mode,
  onAddPage,
  onDeletePage,
  onSelectPage,
  pages,
  selectedPageId,
}: {
  mode: "published" | "draft";
  onAddPage?: () => void;
  onDeletePage?: (pageId: string) => void;
  onSelectPage: (pageId: string) => void;
  pages: DashboardPageTab[];
  selectedPageId: string | null;
}) {
  return (
    <div className="asklake-dashboard-tabs" role="tablist" aria-label="대시보드 페이지">
      {pages.map((page) => (
        <span className={page.id === selectedPageId ? "asklake-dashboard-page-tab active" : "asklake-dashboard-page-tab"} key={page.id}>
          <button
            aria-selected={page.id === selectedPageId}
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
      ))}
      {mode === "draft" && (
        <button className="asklake-dashboard-tab-add" type="button" aria-label="페이지 추가" onClick={onAddPage}>
          <Plus size={18} />
        </button>
      )}
    </div>
  );
}
