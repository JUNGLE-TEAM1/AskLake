import type { PermissionOptionsResponse } from "../types";
import { apiClient, apiConfig } from "./apiClient";

const mockPermissionOptions: PermissionOptionsResponse = {
  groups: [
    { actions: ["view", "run", "manage"], description: "데이터 플랫폼 운영 및 장애 대응", id: "data-platform", name: "Data Platform" },
    { actions: ["view", "query"], description: "분석 업무용 표준 접근 권한", id: "analytics", name: "Analytics" },
    { actions: ["view", "run"], description: "ETL Job 운영 권한", id: "ops", name: "Operations Team" },
  ],
  users: [
    { email: "admin.user@asklake.local", id: "admin-user", initials: "AU", name: "Admin User", role: "admin" },
    { email: "demo.user@asklake.local", id: "demo-user", initials: "DU", name: "Demo User", role: "viewer" },
  ],
};

export async function fetchPermissionOptions(jobId?: string): Promise<PermissionOptionsResponse> {
  if (apiConfig.useMock) return mockPermissionOptions;
  const query = jobId ? `?jobId=${encodeURIComponent(jobId)}` : "";
  return apiClient.get<PermissionOptionsResponse>(`/api/etl/permission-options${query}`);
}
