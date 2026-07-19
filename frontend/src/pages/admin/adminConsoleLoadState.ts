import type {
  AdminAuditLogsResponse,
  AdminGovernanceControlsResponse,
  AdminGroupsResponse,
  AdminPermissionsResponse,
  AdminUsersResponse,
} from "../../types";

export type AdminConsoleLoadSection = "users" | "groups" | "permissions" | "governance" | "audit";
export type AdminConsoleTab = "users" | "groups" | "permissions" | "audit";

export type AdminConsoleLoadData = {
  users: AdminUsersResponse;
  groups: AdminGroupsResponse;
  permissions: AdminPermissionsResponse;
  governance: AdminGovernanceControlsResponse;
  audit: AdminAuditLogsResponse;
};

export type AdminConsoleLoadFailure = {
  message: string;
  status?: number;
};

export type AdminConsoleLoadResult = {
  data: Partial<AdminConsoleLoadData>;
  errors: Partial<Record<AdminConsoleLoadSection, AdminConsoleLoadFailure>>;
};

export const adminConsoleLoadSections: AdminConsoleLoadSection[] = [
  "users",
  "groups",
  "permissions",
  "governance",
  "audit",
];

export const adminConsoleTabDependencies: Record<AdminConsoleTab, AdminConsoleLoadSection[]> = {
  users: ["users", "governance"],
  groups: ["groups", "governance"],
  permissions: ["permissions", "users", "groups", "governance"],
  audit: ["audit"],
};

export type AdminConsoleViewState = {
  activeLoadFailures: AdminConsoleLoadFailure[];
  canRenderActiveTab: boolean;
  permissionDenied: boolean;
  showAuditStaleWarning: boolean;
};

export function deriveAdminConsoleViewState({
  activeTab,
  auditRefreshFailure,
  errors,
  loading,
}: {
  activeTab: AdminConsoleTab;
  auditRefreshFailure?: AdminConsoleLoadFailure | null;
  errors: Partial<Record<AdminConsoleLoadSection, AdminConsoleLoadFailure>>;
  loading: boolean;
}): AdminConsoleViewState {
  const permissionDenied = adminConsoleLoadSections.every((section) => errors[section]?.status === 403);
  const activeLoadFailures = adminConsoleTabDependencies[activeTab]
    .map((section) => errors[section])
    .filter((failure): failure is AdminConsoleLoadFailure => Boolean(failure));

  return {
    activeLoadFailures,
    canRenderActiveTab: !loading && !permissionDenied && activeLoadFailures.length === 0,
    permissionDenied,
    showAuditStaleWarning: activeTab === "audit" && !errors.audit && Boolean(auditRefreshFailure),
  };
}

export type LatestAdminAuditRequestTracker = {
  begin: () => number;
  invalidate: () => void;
  isLatest: (requestId: number) => boolean;
};

export function createLatestAdminAuditRequestTracker(): LatestAdminAuditRequestTracker {
  let latestRequestId = 0;
  return {
    begin: () => ++latestRequestId,
    invalidate: () => { latestRequestId += 1; },
    isLatest: (requestId) => requestId === latestRequestId,
  };
}

const fallbackMessages: Record<AdminConsoleLoadSection, string> = {
  users: "사용자 목록을 불러오지 못했습니다.",
  groups: "그룹 목록을 불러오지 못했습니다.",
  permissions: "리소스 권한을 불러오지 못했습니다.",
  governance: "차단 및 잠금 상태를 불러오지 못했습니다.",
  audit: "감사 로그를 불러오지 못했습니다.",
};

export async function settleAdminConsoleRequests(
  requests: { [Section in AdminConsoleLoadSection]: Promise<AdminConsoleLoadData[Section]> },
): Promise<AdminConsoleLoadResult> {
  const settled = await Promise.allSettled(adminConsoleLoadSections.map((section) => requests[section]));
  const data: Partial<AdminConsoleLoadData> = {};
  const errors: Partial<Record<AdminConsoleLoadSection, AdminConsoleLoadFailure>> = {};

  settled.forEach((result, index) => {
    const section = adminConsoleLoadSections[index];
    if (result.status === "fulfilled") {
      assignSectionData(data, section, result.value);
      return;
    }
    errors[section] = adminConsoleLoadFailure(result.reason, fallbackMessages[section]);
  });

  return { data, errors };
}

function assignSectionData<Section extends AdminConsoleLoadSection>(
  data: Partial<AdminConsoleLoadData>,
  section: Section,
  value: AdminConsoleLoadData[Section],
) {
  data[section] = value;
}

export function adminConsoleLoadFailure(error: unknown, fallback: string): AdminConsoleLoadFailure {
  if (!error || typeof error !== "object") return { message: fallback };
  const candidate = error as { message?: unknown; status?: unknown };
  return {
    message: typeof candidate.message === "string" && candidate.message.trim() ? candidate.message : fallback,
    status: typeof candidate.status === "number" ? candidate.status : undefined,
  };
}
