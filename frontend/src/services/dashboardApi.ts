import type { DashboardListFilterOptions, DashboardListQuery, DashboardListResponse, SavedDashboardCard } from "../types";
import { normalizeDashboardStatus } from "../utils/statusMeta";
import { apiClient } from "./apiClient";

type DashboardQueryPayload = Omit<DashboardListQuery, "search"> & {
  searchQuery?: string;
};

type DashboardPageResponse = {
  dashboards: SavedDashboardCard[];
  facets: DashboardListFilterOptions;
  page: {
    current: number;
    pageSize: number;
    total: number;
  };
};

type DeleteDashboardResponse = {
  deletedDashboardId: string;
};

type UpdateDashboardTitleResponse = {
  dashboard: Pick<SavedDashboardCard, "id" | "name"> & Partial<SavedDashboardCard>;
};

export type CreateDashboardInput = {
  datasetId?: string;
  owner?: string;
  source?: "manual" | "sql" | "catalog";
  sqlRunId?: string;
  title?: string;
};

type CreateDashboardResponse = {
  dashboard: SavedDashboardCard;
};

function normalizePage(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

function normalizePageSize(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 10;
}

function buildIdentityProfile(name: string) {
  const displayName = name.trim() || "Admin User";
  const initials = displayName
    .replace(/[_-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("") || displayName.slice(0, 2).toUpperCase();
  return {
    avatarInitials: initials.slice(0, 2),
    displayName,
  };
}

function buildPermissionGrants(owner: string, actions: Array<"view" | "query" | "run" | "manage" | "delete" | "share">) {
  return owner
    ? [{ actions, principalId: owner, principalType: "group" as const, source: "owner" }]
    : [];
}

function buildResourcePermissions() {
  return {
    canDelete: true,
    canManage: true,
    canQuery: false,
    canRun: false,
    canShare: true,
    canView: true,
    computedFor: "Admin User",
    enforced: false,
  };
}

function normalizeDashboardCard(card: SavedDashboardCard): SavedDashboardCard {
  const createdBy = card.createdBy?.trim() || card.owner || "Admin User";
  return {
    ...card,
    createdBy,
    createdByProfile: card.createdByProfile ?? buildIdentityProfile(createdBy),
    permissionGrants: card.permissionGrants ?? buildPermissionGrants(card.owner, ["view", "manage", "share"]),
    permissions: card.permissions ?? buildResourcePermissions(),
    status: normalizeDashboardStatus(card.status),
  };
}

export function toDashboardListSearchParams(query: DashboardListQuery) {
  const params = new URLSearchParams();
  const search = query.search?.trim();
  const tags = query.tags?.filter(Boolean);

  if (search) params.set("search", search);
  if (query.owner) params.set("owner", query.owner);
  if (tags?.length) params.set("tags", tags.join(","));
  params.set("sort", query.sort);
  params.set("page", String(normalizePage(query.page)));
  params.set("pageSize", String(normalizePageSize(query.pageSize)));

  return params.toString();
}

function normalizeDashboardListResponse(response: DashboardListResponse): DashboardListResponse {
  const pageSize = normalizePageSize(response.pageSize);
  const totalPages = Math.max(1, Math.ceil(response.total / pageSize));

  return {
    filterOptions: {
      owners: response.filterOptions?.owners ?? [],
      tags: response.filterOptions?.tags ?? [],
    },
    items: response.items.map(normalizeDashboardCard),
    page: Math.min(normalizePage(response.page), totalPages),
    pageSize,
    total: Math.max(0, response.total),
  };
}

function toDashboardQueryPayload(query: DashboardListQuery): DashboardQueryPayload {
  return {
    owner: query.owner,
    page: normalizePage(query.page),
    pageSize: normalizePageSize(query.pageSize),
    searchQuery: query.search?.trim() || undefined,
    sort: query.sort,
    tags: query.tags?.filter(Boolean),
  };
}

function normalizeDashboardPageResponse(response: DashboardPageResponse): DashboardListResponse {
  const pageSize = normalizePageSize(response.page?.pageSize ?? 10);
  const total = Math.max(0, response.page?.total ?? response.dashboards.length);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return {
    filterOptions: {
      owners: response.facets?.owners ?? [],
      tags: response.facets?.tags ?? [],
    },
    items: response.dashboards.map(normalizeDashboardCard),
    page: Math.min(normalizePage(response.page?.current ?? 1), totalPages),
    pageSize,
    total,
  };
}

export async function listDashboards(query: DashboardListQuery): Promise<DashboardListResponse> {
  const response = await apiClient.post<DashboardListResponse | DashboardPageResponse>("/api/dashboards/query", toDashboardQueryPayload(query));
  if ("dashboards" in response) return normalizeDashboardPageResponse(response);
  return normalizeDashboardListResponse(response);
}

export async function createDashboard(input: CreateDashboardInput = {}): Promise<CreateDashboardResponse> {
  const response = await apiClient.post<CreateDashboardResponse>("/api/dashboards", input);
  return {
    dashboard: normalizeDashboardCard(response.dashboard),
  };
}

export async function deleteDashboard(dashboardId: string): Promise<DeleteDashboardResponse> {
  return apiClient.delete<DeleteDashboardResponse>(`/api/dashboards/${encodeURIComponent(dashboardId)}`);
}

export async function updateDashboardTitle(dashboardId: string, title: string): Promise<UpdateDashboardTitleResponse> {
  return apiClient.patch<UpdateDashboardTitleResponse>(`/api/dashboards/${encodeURIComponent(dashboardId)}`, {
    title: title.trim(),
  });
}
