import { Plus } from "lucide-react";

type DashboardPageTab = {
  id: string;
  title: string;
};

export function DashboardPageTabs({
  mode,
  onAddPage,
  onSelectPage,
  pages,
  selectedPageId,
}: {
  mode: "published" | "draft";
  onAddPage?: () => void;
  onSelectPage: (pageId: string) => void;
  pages: DashboardPageTab[];
  selectedPageId: string | null;
}) {
  return (
    <div className="asklake-dashboard-tabs" role="tablist" aria-label="대시보드 페이지">
      {pages.map((page) => (
        <button
          aria-selected={page.id === selectedPageId}
          className={page.id === selectedPageId ? "active" : ""}
          key={page.id}
          role="tab"
          type="button"
          onClick={() => onSelectPage(page.id)}
        >
          {page.title}
        </button>
      ))}
      {mode === "draft" && (
        <button className="asklake-dashboard-tab-add" type="button" aria-label="페이지 추가" onClick={onAddPage}>
          <Plus size={18} />
        </button>
      )}
    </div>
  );
}
