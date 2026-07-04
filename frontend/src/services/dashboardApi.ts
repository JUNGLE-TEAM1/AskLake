import type { DashboardListFilterOptions, DashboardListQuery, DashboardListResponse, DashboardSortOption, SavedDashboardCard } from "../types";
import { normalizeDashboardStatus } from "../utils/statusMeta";
import { apiClient, apiConfig } from "./apiClient";

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

function splitTags(tags: string) {
  return tags.split("|").flatMap((tag) => tag.split("·")).map((tag) => tag.trim()).filter(Boolean);
}

function dateValue(value?: string) {
  const parsed = Date.parse(value ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

function normalizePage(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

function normalizePageSize(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 10;
}

function normalizeDashboardCard(card: SavedDashboardCard): SavedDashboardCard {
  return {
    ...card,
    status: normalizeDashboardStatus(card.status),
  };
}

function sortDashboards(dashboards: SavedDashboardCard[], sort: DashboardSortOption) {
  return [...dashboards].sort((first, second) => {
    if (sort === "name-asc") return first.name.localeCompare(second.name);
    if (sort === "name-desc") return second.name.localeCompare(first.name);
    if (sort === "created-asc") return dateValue(first.createdAtValue) - dateValue(second.createdAtValue);
    if (sort === "created-desc") return dateValue(second.createdAtValue) - dateValue(first.createdAtValue);
    if (sort === "updated-asc") return dateValue(first.updatedAtValue) - dateValue(second.updatedAtValue);
    return dateValue(second.updatedAtValue) - dateValue(first.updatedAtValue);
  });
}

function getFilterOptions(dashboards: SavedDashboardCard[]) {
  return {
    owners: Array.from(new Set(dashboards.map((dashboard) => dashboard.owner))).sort((first, second) => first.localeCompare(second)),
    tags: Array.from(new Set(dashboards.flatMap((dashboard) => splitTags(dashboard.tags)))).sort((first, second) => first.localeCompare(second)),
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

export function getMockDashboardListResponse(query: DashboardListQuery, dashboards: SavedDashboardCard[]): DashboardListResponse {
  const sourceDashboards = dashboards.map(normalizeDashboardCard);
  const search = query.search?.trim().toLowerCase();
  const selectedTags = new Set(query.tags ?? []);
  const pageSize = normalizePageSize(query.pageSize);

  const filteredDashboards = sourceDashboards.filter((dashboard) => {
    const dashboardTags = splitTags(dashboard.tags);
    const matchesSearch = !search || [dashboard.name, dashboard.owner, dashboard.tags].some((value) => value.toLowerCase().includes(search));
    const matchesOwner = !query.owner || dashboard.owner === query.owner;
    const matchesTags = selectedTags.size === 0 || Array.from(selectedTags).every((tag) => dashboardTags.includes(tag));
    return matchesSearch && matchesOwner && matchesTags;
  });
  const sortedDashboards = sortDashboards(filteredDashboards, query.sort);
  const total = sortedDashboards.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(normalizePage(query.page), totalPages);
  const startIndex = (page - 1) * pageSize;

  return {
    filterOptions: getFilterOptions(sourceDashboards),
    items: sortedDashboards.slice(startIndex, startIndex + pageSize),
    page,
    pageSize,
    total,
  };
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

export async function listDashboards(query: DashboardListQuery, mockDashboards: SavedDashboardCard[]): Promise<DashboardListResponse> {
  if (apiConfig.useMock) return getMockDashboardListResponse(query, mockDashboards);

  const response = await apiClient.post<DashboardListResponse | DashboardPageResponse>("/api/dashboards/query", toDashboardQueryPayload(query));
  if ("dashboards" in response) return normalizeDashboardPageResponse(response);
  return normalizeDashboardListResponse(response);
}

export async function deleteDashboardCard(dashboardId: string): Promise<void> {
  if (apiConfig.useMock) return;

  await apiClient.delete<void>(`/api/dashboards/${encodeURIComponent(dashboardId)}`);
}
