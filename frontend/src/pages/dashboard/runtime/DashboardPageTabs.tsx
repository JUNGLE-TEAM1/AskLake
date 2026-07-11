import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Pencil, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type DashboardPageTab = {
  id: string;
  title: string;
};

export function DashboardPageTabs({
  canManage = true,
  isAddingPage = false,
  mode,
  onAddPage,
  onDeletePage,
  onRenamePage,
  onSelectPage,
  pages,
  renamingPageId,
  selectedPageId,
}: {
  canManage?: boolean;
  isAddingPage?: boolean;
  mode: "published" | "draft";
  onAddPage?: () => void;
  onDeletePage?: (pageId: string) => void;
  onRenamePage?: (pageId: string, title: string) => Promise<void> | void;
  onSelectPage: (pageId: string) => void;
  pages: DashboardPageTab[];
  renamingPageId?: string | null;
  selectedPageId: string | null;
}) {
  const selectedTabRef = useRef<HTMLButtonElement | null>(null);
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");

  useEffect(() => {
    selectedTabRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [selectedPageId, pages.length]);

  const startRename = (page: DashboardPageTab) => {
    setEditingPageId(page.id);
    setDraftTitle(page.title);
  };

  const cancelRename = () => {
    setEditingPageId(null);
    setDraftTitle("");
  };

  const submitRename = async (event: FormEvent<HTMLFormElement>, page: DashboardPageTab) => {
    event.preventDefault();
    const nextTitle = draftTitle.trim();
    if (!nextTitle || nextTitle === page.title) {
      cancelRename();
      return;
    }

    await onRenamePage?.(page.id, nextTitle);
    setEditingPageId(null);
    setDraftTitle("");
  };

  return (
    <Tabs className="asklake-dashboard-tabs-root" value={selectedPageId ?? ""} onValueChange={onSelectPage}>
      <TabsList aria-label="대시보드 페이지" className="asklake-dashboard-tabs">
        {pages.map((page) => {
          const isSelected = page.id === selectedPageId;
          const isEditing = page.id === editingPageId;
          const isRenaming = page.id === renamingPageId;
          return (
            <span
              className={isSelected ? "asklake-dashboard-page-tab active" : "asklake-dashboard-page-tab"}
              key={page.id}
            >
              {isEditing ? (
                <form
                  className="asklake-dashboard-tab-edit"
                  onSubmit={(event) => void submitRename(event, page)}
                  onClick={(event) => event.stopPropagation()}
                >
                  <Input
                    aria-label={`${page.title} 페이지 이름`}
                    autoFocus
                    className="asklake-dashboard-tab-edit-input"
                    maxLength={48}
                    size="sm"
                    value={draftTitle}
                    onChange={(event) => setDraftTitle(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") cancelRename();
                    }}
                  />
                  <Button
                    className="asklake-dashboard-tab-edit-action"
                    type="submit"
                    disabled={isRenaming || !draftTitle.trim()}
                    aria-label="페이지 이름 저장"
                    size="icon"
                    variant="ghost"
                  >
                    <Check />
                  </Button>
                  <Button
                    className="asklake-dashboard-tab-edit-action"
                    type="button"
                    disabled={isRenaming}
                    aria-label="페이지 이름 편집 취소"
                    onClick={cancelRename}
                    size="icon"
                    variant="ghost"
                  >
                    <X />
                  </Button>
                </form>
              ) : (
                <TabsTrigger
                  className="asklake-dashboard-tab-button"
                  ref={isSelected ? selectedTabRef : undefined}
                  value={page.id}
                >
                  {page.title}
                </TabsTrigger>
              )}
              {mode === "draft" && isSelected && !isEditing && (
                <Button
                  className="asklake-dashboard-tab-rename"
                  type="button"
                  aria-label={`${page.title} 페이지 이름 수정`}
                  size="icon"
                  variant="ghost"
                  onClick={(event) => {
                    event.stopPropagation();
                    startRename(page);
                  }}
                >
                  <Pencil />
                </Button>
              )}
              {mode === "draft" && !isEditing && (
                <Button
                  className="asklake-dashboard-tab-delete"
                  type="button"
                  aria-label={`${page.title} 페이지 삭제`}
                  disabled={isRenaming}
                  size="icon"
                  variant="ghost"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDeletePage?.(page.id);
                  }}
                >
                  <X />
                </Button>
              )}
            </span>
          );
        })}
        {mode === "draft" && (
          <Button
            className="asklake-dashboard-tab-add"
            disabled={isAddingPage}
            title={isAddingPage ? "페이지 추가 중" : "페이지 추가"}
            type="button"
            aria-label={isAddingPage ? "페이지 추가 중" : "페이지 추가"}
            size="icon"
            variant="ghost"
            onClick={onAddPage}
          >
            <Plus />
          </Button>
        )}
      </TabsList>
    </Tabs>
  );
}
