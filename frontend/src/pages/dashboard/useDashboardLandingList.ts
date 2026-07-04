import { useEffect, useMemo, useState } from "react";
import type { SavedDashboardCard } from "./dashboardListData";
import {
  filterAndSortDashboardCards,
  getDashboardOwners,
  getDashboardPage,
  getDashboardTags,
} from "./dashboardListUtils";
import type { DashboardListControl, DashboardSortOption } from "./dashboardListUtils";

type DashboardListAction = (action: string, apiPath: string, targetId: string) => void;

export function useDashboardLandingList(dashboards: SavedDashboardCard[], onAction: DashboardListAction) {
  const [searchQuery, setSearchQuery] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [sortOption, setSortOption] = useState<DashboardSortOption>("updated-desc");
  const [openListControl, setOpenListControl] = useState<DashboardListControl | null>(null);
  const [currentPage, setCurrentPage] = useState(1);

  const dashboardOwners = useMemo(() => getDashboardOwners(dashboards), [dashboards]);
  const dashboardTags = useMemo(() => getDashboardTags(dashboards), [dashboards]);
  const filteredDashboards = useMemo(() => filterAndSortDashboardCards({
    dashboards,
    ownerFilter,
    searchQuery,
    selectedTags,
    sortOption,
  }), [dashboards, ownerFilter, searchQuery, selectedTags, sortOption]);
  const dashboardPage = useMemo(() => getDashboardPage(filteredDashboards, currentPage), [currentPage, filteredDashboards]);

  useEffect(() => {
    setCurrentPage(1);
  }, [ownerFilter, searchQuery, selectedTags, sortOption]);

  const selectDashboardOwner = (owner: string) => {
    setOwnerFilter(owner);
    setOpenListControl(null);
    onAction("dashboard.list.owner_filter_changed", "/api/dashboards/filters", owner);
  };

  const toggleDashboardTag = (tag: string) => {
    setSelectedTags((tags) => (tags.includes(tag) ? tags.filter((selectedTag) => selectedTag !== tag) : [...tags, tag]));
    onAction("dashboard.list.tag_filter_changed", "/api/dashboards/filters", tag);
  };

  const clearDashboardTags = () => {
    setSelectedTags([]);
    onAction("dashboard.list.tag_filter_cleared", "/api/dashboards/filters", "all-tags");
  };

  const selectDashboardSort = (nextSort: DashboardSortOption) => {
    setSortOption(nextSort);
    setOpenListControl(null);
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
    setCurrentPage((page) => Math.min(dashboardPage.totalPages, page + 1));
    onAction("dashboard.list.page_next", "/api/dashboards?page=next", "dashboards");
  };

  return {
    clearDashboardTags,
    dashboardCount: filteredDashboards.length,
    dashboardOwners,
    dashboardPageEnd: dashboardPage.pageEnd,
    dashboardPageStart: dashboardPage.pageStart,
    dashboardTags,
    goToNextDashboardPage,
    goToPreviousDashboardPage,
    openListControl,
    ownerFilter,
    safeDashboardPage: dashboardPage.safePage,
    searchQuery,
    selectDashboardOwner,
    selectDashboardSort,
    selectedTags,
    setSearchQuery,
    sortOption,
    toggleDashboardListControl,
    toggleDashboardTag,
    totalDashboardPages: dashboardPage.totalPages,
    visibleDashboards: dashboardPage.visibleDashboards,
  };
}
