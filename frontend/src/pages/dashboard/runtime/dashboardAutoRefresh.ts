export type DashboardAutoRefreshStatus =
  | "manual"
  | "connecting"
  | "active"
  | "paused"
  | "error";

const PREFERENCE_PREFIX = "asklake:dashboard:auto-refresh";

export function dashboardAutoRefreshPreferenceKey(userId: string, dashboardId: string) {
  return `${PREFERENCE_PREFIX}:${encodeURIComponent(userId)}:${encodeURIComponent(dashboardId)}`;
}

export function readDashboardAutoRefreshPreference(
  userId: string,
  dashboardId: string,
  storage?: Pick<Storage, "getItem">,
) {
  if (!userId || !dashboardId || !storage) return false;
  try {
    return storage.getItem(dashboardAutoRefreshPreferenceKey(userId, dashboardId)) === "true";
  } catch {
    return false;
  }
}

export function writeDashboardAutoRefreshPreference(
  userId: string,
  dashboardId: string,
  enabled: boolean,
  storage?: Pick<Storage, "setItem">,
) {
  if (!userId || !dashboardId || !storage) return;
  try {
    storage.setItem(
      dashboardAutoRefreshPreferenceKey(userId, dashboardId),
      enabled ? "true" : "false",
    );
  } catch {
    // Storage can be unavailable in private browsing or constrained webviews.
  }
}

export function dashboardAutoRefreshStatusCopy(status: DashboardAutoRefreshStatus) {
  switch (status) {
    case "connecting":
      return "자동 연결 중";
    case "active":
      return "자동 갱신 중";
    case "paused":
      return "자동 갱신 일시정지";
    case "error":
      return "자동 갱신 연결 실패";
    default:
      return "수동 새로고침";
  }
}
