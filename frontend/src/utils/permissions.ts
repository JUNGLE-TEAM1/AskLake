import type { CatalogDataset, JobCommand, JobRowData, ResourcePermissions, SavedDashboardCard } from "../types";

type PermissionResource = CatalogDataset | JobRowData | SavedDashboardCard;

export function canQueryDataset(dataset: CatalogDataset | null | undefined) {
  return permissionValue(dataset, "canQuery", true);
}

export function canManageDataset(dataset: CatalogDataset | null | undefined) {
  return permissionValue(dataset, "canManage", false);
}

export function canRunJobCommand(job: JobRowData, command: JobCommand) {
  if (command === "edit" || command === "delete") return true;
  if (command === "run" || command === "retry") return permissionValue(job, "canRun", true);
  return permissionValue(job, "canManage", false);
}

export function permissionDeniedMessage(resourceLabel: string, actionLabel: string) {
  return `${resourceLabel} ${actionLabel} 권한이 없습니다.`;
}

function permissionValue(resource: PermissionResource | null | undefined, key: keyof ResourcePermissions, fallback: boolean) {
  const permissions = resource?.permissions;
  if (!permissions) return fallback;
  return permissions[key] === true;
}
