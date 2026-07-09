export type PermissionAction = "view" | "query" | "run" | "manage" | "delete" | "share";

export type PermissionPrincipalType = "user" | "group" | "role" | "public";

export type PermissionGrant = {
  actions: PermissionAction[];
  principalId: string;
  principalType: PermissionPrincipalType;
  source?: string;
};

export type ResourcePermissions = {
  canView: boolean;
  canQuery: boolean;
  canRun: boolean;
  canManage: boolean;
  canDelete: boolean;
  canShare: boolean;
  computedFor?: string;
  enforced?: boolean;
};
