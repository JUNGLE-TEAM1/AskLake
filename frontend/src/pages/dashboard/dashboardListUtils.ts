import { defaultDashboardCards } from "./DashboardParts";
import type { SavedDashboardCard } from "./DashboardParts";
import { normalizeDashboardStatus } from "../../utils/statusMeta";

export type DashboardListControl = "owner" | "tag" | "sort";
export type DashboardSortOption = "name-asc" | "name-desc" | "updated-asc" | "updated-desc" | "created-asc" | "created-desc";

export type DashboardSortOptionMeta = {
  ariaLabel: string;
  direction: "asc" | "desc";
  id: DashboardSortOption;
  label: string;
};

export const dashboardPageSize = 10;
export const fallbackDashboardDate = "2026-06-26 22:04";
export const fallbackDashboardDateValue = "2026-06-26T22:04:00";

export const dashboardSortOptions: DashboardSortOptionMeta[] = [
  { id: "name-asc", label: "알파벳순", direction: "asc", ariaLabel: "알파벳순 오름차순" },
  { id: "name-desc", label: "알파벳순", direction: "desc", ariaLabel: "알파벳순 내림차순" },
  { id: "updated-asc", label: "마지막 수정", direction: "asc", ariaLabel: "마지막 수정 오름차순" },
  { id: "updated-desc", label: "마지막 수정", direction: "desc", ariaLabel: "마지막 수정 내림차순" },
  { id: "created-asc", label: "생성일", direction: "asc", ariaLabel: "생성일 오름차순" },
  { id: "created-desc", label: "생성일", direction: "desc", ariaLabel: "생성일 내림차순" },
];

export function splitDashboardTags(tags: string) {
  return tags.split("·").map((tag) => tag.trim()).filter(Boolean);
}

function dashboardDateValue(value?: string) {
  const parsed = Date.parse(value ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function formatDashboardTimestamp(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDashboardDateLabel(value?: string) {
  const parsedDate = new Date(value ?? fallbackDashboardDateValue);
  if (Number.isNaN(parsedDate.getTime())) return fallbackDashboardDate;
  const minute = String(parsedDate.getMinutes()).padStart(2, "0");
  return `${parsedDate.getFullYear()}년 ${parsedDate.getMonth() + 1}월 ${parsedDate.getDate()}일 ${parsedDate.getHours()}시 ${minute}분`;
}

export function normalizeSavedDashboardCard(card: SavedDashboardCard, index: number): SavedDashboardCard {
  const fallbackCard = defaultDashboardCards.find((dashboard) => dashboard.id === card.id) ?? defaultDashboardCards[index] ?? defaultDashboardCards[0];
  const createdAt = card.createdAt ?? fallbackCard?.createdAt ?? fallbackDashboardDate;
  const createdAtValue = card.createdAtValue ?? fallbackCard?.createdAtValue ?? fallbackDashboardDateValue;

  return {
    ...card,
    createdAt,
    createdAtValue,
    status: normalizeDashboardStatus(card.status),
    updatedAtValue: card.updatedAtValue ?? fallbackCard?.updatedAtValue ?? createdAtValue,
  };
}

export function hydrateSavedDashboardCards(cards: SavedDashboardCard[]) {
  const normalizedCards = cards.map(normalizeSavedDashboardCard);
  const storedIds = new Set(normalizedCards.map((card) => card.id));
  const missingDefaultCards = defaultDashboardCards.filter((card) => !storedIds.has(card.id));
  return [...normalizedCards, ...missingDefaultCards];
}

export function getDashboardOwners(dashboards: SavedDashboardCard[]) {
  return Array.from(new Set(dashboards.map((dashboard) => dashboard.owner))).sort((first, second) => first.localeCompare(second));
}

export function getDashboardTags(dashboards: SavedDashboardCard[]) {
  return Array.from(new Set(dashboards.flatMap((dashboard) => splitDashboardTags(dashboard.tags)))).sort((first, second) => first.localeCompare(second));
}

export function filterAndSortDashboardCards({
  dashboards,
  ownerFilter,
  searchQuery,
  selectedTags,
  sortOption,
}: {
  dashboards: SavedDashboardCard[];
  ownerFilter: string;
  searchQuery: string;
  selectedTags: string[];
  sortOption: DashboardSortOption;
}) {
  const query = searchQuery.trim().toLowerCase();
  const selectedTagSet = new Set(selectedTags);

  return [...dashboards]
    .filter((dashboard) => {
      const dashboardTags = splitDashboardTags(dashboard.tags);
      const matchesSearch = !query || [dashboard.name, dashboard.owner, dashboard.tags].some((value) => value.toLowerCase().includes(query));
      const matchesOwner = ownerFilter === "all" || dashboard.owner === ownerFilter;
      const matchesTags = selectedTagSet.size === 0 || Array.from(selectedTagSet).every((tag) => dashboardTags.includes(tag));
      return matchesSearch && matchesOwner && matchesTags;
    })
    .sort((first, second) => {
      if (sortOption === "name-asc") return first.name.localeCompare(second.name);
      if (sortOption === "name-desc") return second.name.localeCompare(first.name);
      if (sortOption === "created-asc") return dashboardDateValue(first.createdAtValue) - dashboardDateValue(second.createdAtValue);
      if (sortOption === "created-desc") return dashboardDateValue(second.createdAtValue) - dashboardDateValue(first.createdAtValue);
      if (sortOption === "updated-asc") return dashboardDateValue(first.updatedAtValue) - dashboardDateValue(second.updatedAtValue);
      return dashboardDateValue(second.updatedAtValue) - dashboardDateValue(first.updatedAtValue);
    });
}

export function getDashboardPage(dashboards: SavedDashboardCard[], currentPage: number, pageSize = dashboardPageSize) {
  const totalPages = Math.max(1, Math.ceil(dashboards.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const pageStartIndex = (safePage - 1) * pageSize;
  const visibleDashboards = dashboards.slice(pageStartIndex, pageStartIndex + pageSize);
  const pageStart = dashboards.length === 0 ? 0 : pageStartIndex + 1;
  const pageEnd = pageStartIndex + visibleDashboards.length;

  return {
    pageEnd,
    pageStart,
    safePage,
    totalPages,
    visibleDashboards,
  };
}

export function getDashboardSortLabel(sortOption: DashboardSortOption) {
  return dashboardSortOptions.find((option) => option.id === sortOption)?.ariaLabel ?? "정렬 기준";
}
