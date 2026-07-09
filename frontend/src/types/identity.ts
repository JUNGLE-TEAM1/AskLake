export type IdentityProfile = {
  avatarInitials?: string;
  displayName: string;
  email?: string;
  role?: string;
  title?: string;
};

export type IdentityGroup = {
  description?: string;
  id: string;
  memberCount?: number;
  name: string;
};

export type PermissionSummary = {
  canView: number;
  canQuery: number;
  canRun: number;
  canManage: number;
  canDelete: number;
  canShare: number;
};

export type CurrentUserResponse = {
  displayName: string;
  email: string;
  groups: IdentityGroup[];
  id: string;
  permissionsSummary: PermissionSummary;
  profile: IdentityProfile;
  role: string;
};
