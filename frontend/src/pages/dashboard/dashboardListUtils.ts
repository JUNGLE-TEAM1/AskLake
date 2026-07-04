import { defaultDashboardCards } from "./dashboardListData";
import type { DashboardSortOption, SavedDashboardCard } from "../../types";
import { normalizeDashboardStatus } from "../../utils/statusMeta";

export type DashboardListControl = "owner" | "tag" | "sort";
export type { DashboardSortOption } from "../../types";

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
  return tags.split("|").flatMap((tag) => tag.split("·")).map((tag) => tag.trim()).filter(Boolean);
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

export function normalizeSavedDashboardCard(card: SavedDashboardCard, index = 0): SavedDashboardCard {
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

export function getDashboardSortLabel(sortOption: DashboardSortOption) {
  return dashboardSortOptions.find((option) => option.id === sortOption)?.ariaLabel ?? "정렬 기준";
}
