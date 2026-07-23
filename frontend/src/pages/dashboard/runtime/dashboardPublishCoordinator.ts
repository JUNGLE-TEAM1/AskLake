import type { DashboardRuntimeResponse } from "../../../types";

export type DashboardPublishAvailability = {
  draftError: string | null;
  draftLoading: boolean;
  draftRuntime: DashboardRuntimeResponse | null;
  hasLayoutSaveFailure: boolean;
  isDraftMutationPending: boolean;
  isSavingLayout: boolean;
};

export function dashboardPublishUnavailableReason({
  draftError,
  draftLoading,
  draftRuntime,
  hasLayoutSaveFailure,
  isDraftMutationPending,
  isSavingLayout,
}: DashboardPublishAvailability): string | null {
  if (draftLoading) return "Draft를 불러온 뒤 게시할 수 있습니다.";
  if (draftError) return "Draft 로드 오류를 해결한 뒤 게시할 수 있습니다.";
  if (!draftRuntime?.revision) return "게시할 Draft revision이 없습니다.";
  if (hasLayoutSaveFailure) return "실패한 레이아웃 저장을 다시 완료한 뒤 게시해 주세요.";
  if (isSavingLayout) return "레이아웃 저장이 끝나면 게시할 수 있습니다.";
  if (isDraftMutationPending) return "Draft 변경사항 저장이 끝나면 게시할 수 있습니다.";
  return null;
}

export async function publishSettledDashboard({
  cleanup,
  preflight,
  publish,
  waitForPendingLayoutSaves,
}: {
  cleanup: () => Promise<unknown>;
  preflight: () => string | null;
  publish: () => Promise<unknown>;
  waitForPendingLayoutSaves: () => Promise<boolean>;
}): Promise<
  | { status: "layout-save-failed" }
  | { message: string; status: "preflight-failed" }
  | { status: "published" }
> {
  const layoutsSaved = await waitForPendingLayoutSaves();
  if (!layoutsSaved) return { status: "layout-save-failed" };
  const preflightMessage = preflight();
  if (preflightMessage) return { message: preflightMessage, status: "preflight-failed" };
  await cleanup();
  await publish();
  return { status: "published" };
}
