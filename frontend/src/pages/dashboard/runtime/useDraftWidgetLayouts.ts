import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { LayoutItem } from "react-grid-layout";
import { MutationRevisionGate } from "../../../state/requestOwnership";
import { saveDraftLayouts } from "../../../services/dashboardRuntimeApi";
import type { AuditResult, DashboardRuntimeResponse } from "../../../types";
import {
  applyDraftWidgetLayouts,
  createDraftLayoutSaveInput,
  persistDraftLayout,
  restoreDraftWidgetLayouts,
  runtimePageLayoutSnapshot,
  type DraftLayoutSaveResult,
  type DraftLayoutUpdateResult,
  type RuntimeLayoutSnapshot,
} from "./draftWidgetLayoutPersistence";
import { hasAnyLayoutCollision } from "./dashboardLayoutUtils";

type RuntimeNotice = {
  message: string;
  tone: "success" | "info" | "error";
};

type UseDraftWidgetLayoutsParams = {
  dashboardId: string;
  draftRuntime: DashboardRuntimeResponse | null;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  selectedPageId: string | null;
  setDraftRuntime: Dispatch<SetStateAction<DashboardRuntimeResponse | null>>;
  setRuntimeNotice: (notice: RuntimeNotice) => void;
};

type QueuedLayoutSaveResult = {
  previousSavedLayout: RuntimeLayoutSnapshot;
  result: DraftLayoutSaveResult;
};

function layoutSaveKey(dashboardId: string, pageId: string) {
  return `${dashboardId}:${pageId}`;
}

export function useDraftWidgetLayouts({
  dashboardId,
  draftRuntime,
  onAction,
  selectedPageId,
  setDraftRuntime,
  setRuntimeNotice,
}: UseDraftWidgetLayoutsParams) {
  const draftRuntimeRef = useRef(draftRuntime);
  const lastSavedLayoutByPageRef = useRef(new Map<string, RuntimeLayoutSnapshot>());
  const layoutMutationRevisions = useRef(new MutationRevisionGate());
  const layoutSaveQueueRef = useRef(new Map<string, Promise<void>>());

  useEffect(() => {
    draftRuntimeRef.current = draftRuntime;
  }, [draftRuntime]);

  const enqueueLayoutSave = (
    key: string,
    save: () => Promise<QueuedLayoutSaveResult>,
  ) => {
    const previousSave = layoutSaveQueueRef.current.get(key) ?? Promise.resolve();
    const queuedSave = previousSave.catch(() => undefined).then(save);
    layoutSaveQueueRef.current.set(key, queuedSave.then(() => undefined, () => undefined));
    return queuedSave;
  };

  const updateDraftWidgetLayouts = async (layout: LayoutItem[]): Promise<DraftLayoutUpdateResult> => {
    if (!selectedPageId) return { status: "rejected" };
    if (hasAnyLayoutCollision(layout)) {
      setRuntimeNotice({ message: "위젯이 겹쳐 레이아웃을 저장하지 않았습니다. 위치를 다시 조정해 주세요.", tone: "error" });
      return { status: "rejected" };
    }

    const currentRuntime = draftRuntimeRef.current;
    if (!currentRuntime || currentRuntime.dashboard.id !== dashboardId) return { status: "failed" };

    const pageKey = layoutSaveKey(dashboardId, selectedPageId);
    const mutationLease = layoutMutationRevisions.current.begin(pageKey);
    const initialSavedLayout = runtimePageLayoutSnapshot(currentRuntime, selectedPageId);
    if (!lastSavedLayoutByPageRef.current.has(pageKey)) {
      lastSavedLayoutByPageRef.current.set(pageKey, initialSavedLayout);
    }

    const optimisticRuntime = applyDraftWidgetLayouts(currentRuntime, selectedPageId, layout);
    const savedLayout = runtimePageLayoutSnapshot(optimisticRuntime, selectedPageId);
    draftRuntimeRef.current = optimisticRuntime;
    setDraftRuntime((runtime) => {
      if (!runtime || runtime.dashboard.id !== dashboardId) return runtime;
      const nextRuntime = applyDraftWidgetLayouts(runtime, selectedPageId, layout);
      draftRuntimeRef.current = nextRuntime;
      return nextRuntime;
    });
    const input = createDraftLayoutSaveInput(selectedPageId, layout);
    const { previousSavedLayout, result } = await enqueueLayoutSave(pageKey, async () => {
      const latestSavedLayout = lastSavedLayoutByPageRef.current.get(pageKey) ?? initialSavedLayout;
      const persisted = await persistDraftLayout(
        input,
        (nextInput) => saveDraftLayouts(dashboardId, nextInput),
        () => {
          lastSavedLayoutByPageRef.current.set(pageKey, savedLayout);
          onAction("dashboard.layout.saved", `/api/dashboards/${dashboardId}/draft/layouts`, selectedPageId);
        },
      );
      return {
        previousSavedLayout: latestSavedLayout,
        result: persisted,
      };
    });

    if (result.status === "saved") {
      return { previousSavedLayout, status: "saved" };
    }

    onAction("dashboard.layout.save_failed", `/api/dashboards/${dashboardId}/draft/layouts`, selectedPageId, "failed");
    if (layoutMutationRevisions.current.isCurrent(mutationLease)) {
      const lastSavedLayout = lastSavedLayoutByPageRef.current.get(pageKey) ?? initialSavedLayout;
      setDraftRuntime((runtime) => {
        if (!runtime || runtime.dashboard.id !== dashboardId) return runtime;
        const restoredRuntime = restoreDraftWidgetLayouts(runtime, selectedPageId, lastSavedLayout);
        draftRuntimeRef.current = restoredRuntime;
        return restoredRuntime;
      });
      setRuntimeNotice({
        message: `위젯 위치를 저장하지 못해 마지막으로 저장된 위치로 되돌렸습니다. ${result.error}`,
        tone: "error",
      });
    }
    return { status: "failed" };
  };

  return { updateDraftWidgetLayouts };
}
