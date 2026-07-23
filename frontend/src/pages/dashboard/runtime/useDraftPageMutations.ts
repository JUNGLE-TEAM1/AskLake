import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  createDraftPage,
  deleteDraftPage,
  updateDraftPageTitle,
} from "../../../services/dashboardRuntimeApi";
import type { AuditResult, DashboardRuntimeMode, DashboardRuntimeResponse } from "../../../types";
import { appendRuntimePage, removeRuntimePage } from "./dashboardRuntimeMutations";
import { dashboardRuntimeErrorMessage } from "./dashboardRuntimeErrors";

type RuntimeNotice = { message: string; tone: "success" | "info" | "error" };

export function useDraftPageMutations({
  dashboardId,
  draftRuntime,
  mode,
  onAction,
  selectedPageId,
  setDraftRuntime,
  setNotice,
  setSelectedPageId,
  setSelectedWidgetId,
}: {
  dashboardId: string;
  draftRuntime: DashboardRuntimeResponse | null;
  mode: DashboardRuntimeMode;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  selectedPageId: string | null;
  setDraftRuntime: Dispatch<SetStateAction<DashboardRuntimeResponse | null>>;
  setNotice: (notice: RuntimeNotice) => void;
  setSelectedPageId: (pageId: string | null) => void;
  setSelectedWidgetId: (widgetId: string | null) => void;
}) {
  const [isAddingPage, setIsAddingPage] = useState(false);
  const [deletingPageId, setDeletingPageId] = useState<string | null>(null);
  const [renamingPageId, setRenamingPageId] = useState<string | null>(null);

  const addPage = async () => {
    if (mode !== "draft" || isAddingPage) return;
    const nextPageNumber = (draftRuntime?.pages.length ?? 0) + 1;
    const title = nextPageNumber > 1 ? `제목 없는 페이지 ${nextPageNumber}` : "제목 없는 페이지";
    setIsAddingPage(true);
    setNotice({ message: "페이지를 추가하는 중입니다.", tone: "info" });
    try {
      const page = await createDraftPage(dashboardId, { title });
      setDraftRuntime((runtime) => runtime ? appendRuntimePage(runtime, page) : runtime);
      setSelectedPageId(page.id);
      setNotice({ message: `${page.title} 페이지를 추가했습니다.`, tone: "success" });
      onAction("dashboard.page.added", `/api/dashboards/${dashboardId}/draft/pages`, dashboardId);
    } catch (error) {
      setNotice({
        message: dashboardRuntimeErrorMessage(error, "페이지를 추가하지 못했습니다."),
        tone: "error",
      });
      onAction("dashboard.page.add_failed", `/api/dashboards/${dashboardId}/draft/pages`, dashboardId, "failed");
    } finally {
      setIsAddingPage(false);
    }
  };

  const deletePage = async (pageId: string) => {
    if (mode !== "draft" || deletingPageId) return;
    setDeletingPageId(pageId);
    try {
      const response = await deleteDraftPage(dashboardId, pageId);
      const remainingPageId = draftRuntime?.pages.find((page) => page.id !== pageId)?.id
        ?? response.replacementPage?.id
        ?? null;
      setDraftRuntime((runtime) => {
        if (!runtime) return runtime;
        const runtimeWithoutPage = removeRuntimePage(runtime, pageId);
        return response.replacementPage
          ? appendRuntimePage(runtimeWithoutPage, response.replacementPage)
          : runtimeWithoutPage;
      });
      if (selectedPageId === pageId) setSelectedPageId(remainingPageId);
      setSelectedWidgetId(null);
      setNotice({ message: "페이지를 삭제했습니다.", tone: "success" });
      onAction("dashboard.page.deleted", `/api/dashboards/${dashboardId}/draft/pages/${pageId}`, pageId);
    } catch (error) {
      setNotice({
        message: dashboardRuntimeErrorMessage(error, "페이지를 삭제하지 못했습니다."),
        tone: "error",
      });
      onAction("dashboard.page.delete_failed", `/api/dashboards/${dashboardId}/draft/pages/${pageId}`, pageId, "failed");
    } finally {
      setDeletingPageId(null);
    }
  };

  const renamePage = async (pageId: string, title: string) => {
    if (mode !== "draft" || renamingPageId) return;
    const nextTitle = title.trim();
    if (!nextTitle) {
      setNotice({ message: "페이지 이름을 입력해 주세요.", tone: "error" });
      return;
    }
    setRenamingPageId(pageId);
    try {
      const page = await updateDraftPageTitle(dashboardId, pageId, { title: nextTitle });
      setDraftRuntime((runtime) => runtime ? {
        ...runtime,
        pages: runtime.pages.map((runtimePage) => runtimePage.id === page.id
          ? { ...runtimePage, title: page.title, orderIndex: page.orderIndex }
          : runtimePage),
      } : runtime);
      setNotice({ message: "페이지 이름을 저장했습니다.", tone: "success" });
      onAction("dashboard.page.renamed", `/api/dashboards/${dashboardId}/draft/pages/${pageId}`, pageId);
    } catch (error) {
      setNotice({
        message: dashboardRuntimeErrorMessage(error, "페이지 이름을 저장하지 못했습니다."),
        tone: "error",
      });
      onAction("dashboard.page.rename_failed", `/api/dashboards/${dashboardId}/draft/pages/${pageId}`, pageId, "failed");
    } finally {
      setRenamingPageId(null);
    }
  };

  return { addPage, deletePage, deletingPageId, isAddingPage, renamePage, renamingPageId };
}
