import type {
  AdminAuditLogQuery,
  AdminAuditLogsResponse,
  AdminGovernanceControlsResponse,
  AdminGroupsResponse,
  AdminPermissionGrantRequest,
  AdminPermissionGrantUpdateRequest,
  AdminPermissionsResponse,
  AdminPrincipalControlRequest,
  AdminResourceLockRequest,
  AdminUsersResponse,
} from "../types";
import { apiClient } from "./apiClient";

export async function fetchAdminUsers(): Promise<AdminUsersResponse> {
  return apiClient.get<AdminUsersResponse>("/api/admin/users");
}

export async function fetchAdminGroups(): Promise<AdminGroupsResponse> {
  return apiClient.get<AdminGroupsResponse>("/api/admin/groups");
}

export async function fetchAdminPermissions(): Promise<AdminPermissionsResponse> {
  return apiClient.get<AdminPermissionsResponse>("/api/admin/permissions");
}

export async function createAdminPermissionGrant(payload: AdminPermissionGrantRequest): Promise<AdminPermissionsResponse> {
  return apiClient.post<AdminPermissionsResponse>("/api/admin/permissions", payload);
}

export async function updateAdminPermissionGrant(grantId: string, payload: AdminPermissionGrantUpdateRequest): Promise<AdminPermissionsResponse> {
  return apiClient.patch<AdminPermissionsResponse>(`/api/admin/permissions/${encodeURIComponent(grantId)}`, payload);
}

export async function deleteAdminPermissionGrant(grantId: string): Promise<AdminPermissionsResponse> {
  return apiClient.delete<AdminPermissionsResponse>(`/api/admin/permissions/${encodeURIComponent(grantId)}`);
}

export async function fetchAdminGovernanceControls(): Promise<AdminGovernanceControlsResponse> {
  return apiClient.get<AdminGovernanceControlsResponse>("/api/admin/governance-controls");
}

export async function updateAdminPrincipalControl(payload: AdminPrincipalControlRequest): Promise<AdminGovernanceControlsResponse> {
  return apiClient.patch<AdminGovernanceControlsResponse>("/api/admin/governance/principals", payload);
}

export async function updateAdminResourceLock(payload: AdminResourceLockRequest): Promise<AdminGovernanceControlsResponse> {
  return apiClient.patch<AdminGovernanceControlsResponse>("/api/admin/governance/resource-locks", payload);
}

export async function fetchAdminAuditLogs(query: AdminAuditLogQuery = {}): Promise<AdminAuditLogsResponse> {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    params.set(key, String(value));
  });
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return apiClient.get<AdminAuditLogsResponse>(`/api/admin/audit-logs${suffix}`);
}
