import type { AuditResult, AuditTargetType } from "./audit";
import type { CurrentUserResponse, IdentityGroup } from "./identity";
import type { PermissionGrant, ResourcePermissions } from "./permissions";
import type { PermissionAction, PermissionPrincipalType } from "./permissions";

export type AdminUserStatus = "active" | "invited" | "disabled";

export type AdminResourceType = "dataset" | "etl_job" | "dashboard";
export type AdminPrincipalControlType = "user" | "group";
export type AdminPrincipalStatus = "active" | "blocked";

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
  actorGroups: string[];
  actorName?: string;
  actorRole?: string;
  apiPath: string;
  createdAt: string;
  httpMethod?: string;
  metadata?: Record<string, unknown>;
  requestId: string;
  result: AuditResult;
  statusCode?: number;
  targetId: string;
  targetName?: string;
  targetType: AuditTargetType;
};

export type AdminAuditLogsResponse = {
  logs: AdminAuditLogEntry[];
};

export type AdminPrincipalControl = {
  id: string;
  principalId: string;
  principalType: AdminPrincipalControlType;
  reason?: string;
  status: AdminPrincipalStatus;
  updatedAt?: string;
  updatedBy?: string;
};

export type AdminResourceLock = {
  id: string;
  locked: boolean;
  reason?: string;
  resourceId: string;
  resourceType: AdminResourceType;
  updatedAt?: string;
  updatedBy?: string;
};

export type AdminGovernanceControlsResponse = {
  principalControls: AdminPrincipalControl[];
  resourceLocks: AdminResourceLock[];
};

export type AdminPrincipalControlRequest = {
  principalId: string;
  principalType: AdminPrincipalControlType;
  reason?: string;
  status: AdminPrincipalStatus;
};

export type AdminResourceLockRequest = {
  locked: boolean;
  reason?: string;
  resourceId: string;
  resourceType: AdminResourceType;
};

export type AdminAuditLogQuery = {
  actorId?: string;
  from?: string;
  limit?: number;
  q?: string;
  resourceType?: string;
  result?: AuditResult;
  to?: string;
};
