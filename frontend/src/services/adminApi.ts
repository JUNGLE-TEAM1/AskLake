import type {
  AdminAuditLogsResponse,
  AdminGroupsResponse,
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

export async function fetchAdminAuditLogs(): Promise<AdminAuditLogsResponse> {
  return apiClient.get<AdminAuditLogsResponse>("/api/admin/audit-logs");
}
