import type { CatalogDataset, CurrentUserResponse, DashboardMeta, JobCommand, JobRowData, ResourcePermissions, SavedDashboardCard } from "../types";

type PermissionResource = CatalogDataset | DashboardMeta | JobRowData | SavedDashboardCard;

export function canQueryDataset(dataset: CatalogDataset | null | undefined) {
  return permissionValue(dataset, "canQuery", true);
}

export function isAdminUser(user: CurrentUserResponse | null | undefined) {
  return String(user?.role ?? "").toLowerCase() === "admin";
}

export function canQueryDatasetAs(dataset: CatalogDataset | null | undefined, user: CurrentUserResponse | null | undefined) {
  if (dataset?.permissions?.enforced) return dataset.permissions.canQuery === true;
  return isAdminUser(user) || canQueryDataset(dataset);
}

export function canManageDataset(dataset: CatalogDataset | null | undefined) {
  return permissionValue(dataset, "canManage", false);
}

export function canDeleteDatasetMaterializationRun(dataset: CatalogDataset | null | undefined) {
  return canManageDataset(dataset) || permissionValue(dataset, "canDelete", false);
}

export function canManageDashboard(dashboard: DashboardMeta | SavedDashboardCard | null | undefined) {
  return permissionValue(dashboard, "canManage", true);
}

export function canRunJobCommand(job: JobRowData, command: JobCommand) {
  if (command === "edit") return permissionValue(job, "canManage", false);
  if (command === "delete") return permissionValue(job, "canDelete", false);
  if (command === "run" || command === "retry" || command === "startContinuous" || command === "resumeContinuous") return permissionValue(job, "canRun", true);
  return permissionValue(job, "canManage", false);
}

export function permissionDeniedMessage(resourceLabel: string, actionLabel: string) {
  return `${resourceLabel} ${actionLabel} 권한이 없습니다.`;
}

export function datasetQueryBlockedMessage(dataset: CatalogDataset | null | undefined, resourceLabel = "데이터셋") {
  if (dataset?.queryEngineRequired && dataset.queryEngineStatus === "pending") return `${resourceLabel}을 SQL 엔진에 등록하고 있습니다.`;
  if (dataset?.queryEngineRequired && dataset.queryEngineStatus === "registration_failed") return `${resourceLabel}의 SQL 엔진 등록 검증에 실패했습니다.`;
  if (dataset?.queryEngineRequired && dataset.queryEngineStatus === "unavailable") return `${resourceLabel}은 아직 SQL 엔진에서 사용할 수 없습니다.`;
  return permissionDeniedMessage(resourceLabel, "SQL 실행");
}

function permissionValue(resource: PermissionResource | null | undefined, key: keyof ResourcePermissions, fallback: boolean) {
  const permissions = resource?.permissions;
  if (!permissions) return fallback;
  return permissions[key] === true;
}
