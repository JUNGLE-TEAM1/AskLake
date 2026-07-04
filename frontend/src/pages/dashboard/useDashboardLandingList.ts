import { useEffect, useMemo, useState } from "react";
import { getMockDashboardListResponse, listDashboards } from "../../services/dashboardApi";
import type { DashboardListQuery, DashboardListResponse, SavedDashboardCard } from "../../types";
import { dashboardPageSize } from "./dashboardListUtils";
import type { DashboardListControl, DashboardSortOption } from "./dashboardListUtils";

type DashboardListAction = (action: string, apiPath: string, targetId: string) => void;

export function useDashboardLandingList(dashboards: SavedDashboardCard[], onAction: DashboardListAction) {
  const [searchQuery, setSearchQuery] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [sortOption, setSortOption] = useState<DashboardSortOption>("updated-desc");
  const [openListControl, setOpenListControl] = useState<DashboardListControl | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [dashboardResponse, setDashboardResponse] = useState<DashboardListResponse>(() => getMockDashboardListResponse({
    page: 1,
    pageSize: dashboardPageSize,
    sort: "updated-desc",
  }, dashboards));

  const dashboardQuery = useMemo<DashboardListQuery>(() => ({
    owner: ownerFilter === "all" ? undefined : ownerFilter,
    page: currentPage,
    pageSize: dashboardPageSize,
    search: searchQuery.trim() || undefined,
    sort: sortOption,
    tags: selectedTags.length ? selectedTags : undefined,
  }), [currentPage, ownerFilter, searchQuery, selectedTags, sortOption]);

  useEffect(() => {
    let ignore = false;

    void listDashboards(dashboardQuery, dashboards)
      .then((response) => {
        if (ignore) return;
        setDashboardResponse(response);
        if (response.page !== currentPage) setCurrentPage(response.page);
      })
      .catch(() => undefined);

    return () => {
      ignore = true;
    };
  }, [currentPage, dashboardQuery, dashboards]);

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
    dashboardOwners: dashboardResponse.filterOptions.owners,
    dashboardPageEnd,
    dashboardPageStart,
    dashboardTags: dashboardResponse.filterOptions.tags,
    goToNextDashboardPage,
    goToPreviousDashboardPage,
    openListControl,
    ownerFilter,
    safeDashboardPage: dashboardResponse.page,
    searchQuery,
    selectDashboardOwner,
    selectDashboardSort,
    selectedTags,
    setSearchQuery: (value: string) => {
      setSearchQuery(value);
      resetPage();
    },
    sortOption,
    toggleDashboardListControl,
    toggleDashboardTag,
    totalDashboardPages,
    visibleDashboards: dashboardResponse.items,
  };
}
