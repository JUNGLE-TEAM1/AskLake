import type { AuditResult, AuditTargetType } from "./audit";
import type { CurrentUserResponse, IdentityGroup } from "./identity";
import type { PermissionGrant, ResourcePermissions } from "./permissions";
import type { PermissionAction, PermissionPrincipalType } from "./permissions";

export type AdminUserStatus = "active" | "invited" | "disabled";

export type AdminResourceType = "dataset" | "etl_job" | "dashboard";

export type AdminUser = CurrentUserResponse & {
  lastActiveAt?: string;
  status: AdminUserStatus;
};

export type AdminUsersResponse = {
  users: AdminUser[];
};

export type AdminGroupsResponse = {
  groups: IdentityGroup[];
};

export type AdminPermissionSummary = {
  createdBy?: string;
  currentActorPermissions?: ResourcePermissions;
  grants: PermissionGrant[];
  owner?: string;
  resourceId: string;
  resourceName: string;
  resourceType: AdminResourceType;
};

export type AdminPermissionsResponse = {
  resources: AdminPermissionSummary[];
};

export type AdminPermissionGrantRequest = {
  actions: PermissionAction[];
  principalId: string;
  principalType: PermissionPrincipalType;
  resourceId: string;
  resourceType: AdminResourceType;
};

export type AdminPermissionGrantUpdateRequest = {
  actions?: PermissionAction[];
  principalId?: string;
  principalType?: PermissionPrincipalType;
};

export type AdminAuditLogEntry = {
  action: string;
  actorId: string;
  apiPath: string;
  createdAt: string;
  requestId: string;
  result: AuditResult;
  targetId: string;
  targetType: AuditTargetType;
};

export type AdminAuditLogsResponse = {
  logs: AdminAuditLogEntry[];
};
