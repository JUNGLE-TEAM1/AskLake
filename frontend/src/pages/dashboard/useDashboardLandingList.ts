import { useEffect, useMemo, useState } from "react";
import { listDashboards } from "../../services/dashboardApi";
import type { DashboardListQuery, DashboardListResponse } from "../../types";
import { dashboardPageSize } from "./dashboardListUtils";
import type { DashboardListControl, DashboardSortOption } from "./dashboardListUtils";

type DashboardListAction = (action: string, apiPath: string, targetId: string) => void;
const dashboardSearchDebounceMs = 300;

export function useDashboardLandingList(onAction: DashboardListAction, refreshKey = 0) {
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [sortOption, setSortOption] = useState<DashboardSortOption>("updated-desc");
  const [openListControl, setOpenListControl] = useState<DashboardListControl | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [dashboardResponse, setDashboardResponse] = useState<DashboardListResponse>({
    filterOptions: { owners: [], tags: [] },
    items: [],
    page: 1,
    pageSize: dashboardPageSize,
    total: 0,
  });

  const dashboardQuery = useMemo<DashboardListQuery>(() => ({
    owner: ownerFilter === "all" ? undefined : ownerFilter,
    page: currentPage,
    pageSize: dashboardPageSize,
    search: debouncedSearchQuery.trim() || undefined,
    sort: sortOption,
    tags: selectedTags.length ? selectedTags : undefined,
  }), [currentPage, debouncedSearchQuery, ownerFilter, selectedTags, sortOption]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
      setCurrentPage(1);
    }, dashboardSearchDebounceMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [searchQuery]);

  useEffect(() => {
    let ignore = false;

    setDashboardLoading(true);
    setDashboardError(null);
    void listDashboards(dashboardQuery)
      .then((response) => {
        if (ignore) return;
        setDashboardResponse(response);
        if (response.page !== currentPage) setCurrentPage(response.page);
      })
      .catch((error) => {
        if (ignore) return;
        setDashboardError(error instanceof Error ? error.message : "Failed to load dashboards.");
      })
      .finally(() => {
        if (!ignore) setDashboardLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [currentPage, dashboardQuery, refreshKey, reloadKey]);

  const resetPage = () => {
    setCurrentPage(1);
  };

  const selectDashboardOwner = (owner: string) => {
    setOwnerFilter(owner);
    setOpenListControl(null);
    resetPage();
    onAction("dashboard.list.owner_filter_changed", "/api/dashboards/filters", owner);
  };

  const toggleDashboardTag = (tag: string) => {
    setSelectedTags((tags) => (tags.includes(tag) ? tags.filter((selectedTag) => selectedTag !== tag) : [...tags, tag]));
    resetPage();
    onAction("dashboard.list.tag_filter_changed", "/api/dashboards/filters", tag);
  };

  const clearDashboardTags = () => {
    setSelectedTags([]);
    resetPage();
    onAction("dashboard.list.tag_filter_cleared", "/api/dashboards/filters", "all-tags");
  };

  const selectDashboardSort = (nextSort: DashboardSortOption) => {
    setSortOption(nextSort);
    setOpenListControl(null);
    resetPage();
    onAction("dashboard.list.sort_changed", "/api/dashboards/sort", nextSort);
  };

  const toggleDashboardListControl = (control: DashboardListControl) => {
    setOpenListControl((currentControl) => (currentControl === control ? null : control));
  };

  const goToPreviousDashboardPage = () => {
    setCurrentPage((page) => Math.max(1, page - 1));
    onAction("dashboard.list.page_previous", "/api/dashboards?page=previous", "dashboards");
  };

  const goToNextDashboardPage = () => {
    setCurrentPage((page) => Math.min(totalDashboardPages, page + 1));
    onAction("dashboard.list.page_next", "/api/dashboards?page=next", "dashboards");
  };

  const totalDashboardPages = Math.max(1, Math.ceil(dashboardResponse.total / dashboardResponse.pageSize));
  const dashboardPageStart = dashboardResponse.total === 0 ? 0 : (dashboardResponse.page - 1) * dashboardResponse.pageSize + 1;
  const dashboardPageEnd = dashboardPageStart === 0 ? 0 : dashboardPageStart + dashboardResponse.items.length - 1;

  return {
    clearDashboardTags,
    dashboardCount: dashboardResponse.total,
    dashboardError,
    dashboardLoading,
    dashboardOwners: dashboardResponse.filterOptions.owners,
    dashboardPageEnd,
    dashboardPageStart,
    dashboardTags: dashboardResponse.filterOptions.tags,
    goToNextDashboardPage,
    goToPreviousDashboardPage,
    openListControl,
    ownerFilter,
    reloadDashboards: () => setReloadKey((key) => key + 1),
    safeDashboardPage: dashboardResponse.page,
    searchQuery,
    selectDashboardOwner,
    selectDashboardSort,
    selectedTags,
    setSearchQuery: (value: string) => {
      setSearchQuery(value);
    },
    sortOption,
    toggleDashboardListControl,
    toggleDashboardTag,
    totalDashboardPages,
    visibleDashboards: dashboardResponse.items,
  };
}
