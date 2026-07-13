export type PermissionAction = "view" | "query" | "run" | "manage" | "delete" | "share";

export type PermissionPrincipalType = "user" | "group" | "role" | "public";

export type PermissionGrant = {
  id?: string;
  actions: PermissionAction[];
  principalId: string;
  principalType: PermissionPrincipalType;
  source?: string;
};

export type PermissionOptionGroup = {
  actions: PermissionAction[];
  description?: string;
  id: string;
  name: string;
};

export type PermissionOptionUser = {
  email: string;
  id: string;
  initials: string;
  name: string;
  role: string;
};

export type PermissionOptionsResponse = {
  groups: PermissionOptionGroup[];
  users: PermissionOptionUser[];
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
