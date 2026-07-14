import type { CurrentUserResponse } from "../types";

export const mockAuthUser: CurrentUserResponse = {
  id: "mock-admin-user",
  displayName: "Admin User",
  email: "admin.user@asklake.local",
  role: "admin",
  groups: [{ id: "analytics-team", name: "Analytics Team", description: "분석 업무 모델을 관리합니다.", memberCount: 8 }],
  permissionsSummary: { canView: 14, canQuery: 12, canRun: 10, canManage: 8, canDelete: 4, canShare: 6 },
  profile: { displayName: "Admin User", email: "admin.user@asklake.local", avatarInitials: "AU", role: "admin", title: "Platform Administrator" },
};
