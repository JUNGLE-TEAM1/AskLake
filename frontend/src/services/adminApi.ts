import type {
  AdminAuditLogsResponse,
  AdminGroupsResponse,
  AdminPermissionGrantRequest,
  AdminPermissionGrantUpdateRequest,
  AdminPermissionsResponse,
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

export async function fetchAdminAuditLogs(): Promise<AdminAuditLogsResponse> {
  return apiClient.get<AdminAuditLogsResponse>("/api/admin/audit-logs");
}
