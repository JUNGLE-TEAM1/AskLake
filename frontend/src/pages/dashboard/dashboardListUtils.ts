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

const dashboardTagLabels: Record<string, string> = {
  Cohort: "고객군", Cost: "비용", Customer: "고객", Data: "데이터", Demo: "데모",
  Executive: "경영", Finance: "재무", Funnel: "전환", Growth: "성장", Health: "상태",
  Inventory: "재고", Logistics: "물류", Marketing: "마케팅", Mobile: "모바일", Monthly: "월간",
  Ops: "운영", Procurement: "구매", Quality: "품질", Quarterly: "분기 실적", Regional: "지역",
  Retention: "유지율", Revenue: "매출", Risk: "위험", ROI: "수익률", Sales: "영업",
  SLA: "서비스 수준", Spend: "광고비", Support: "고객 지원",
};

const dashboardOwnerLabels: Record<string, string> = {
  "Admin User": "관리자",
  "Jane Doe": "마케팅팀",
  "Michael Chen": "운영팀",
  "Robert Wilson": "경영기획팀",
  "Sarah Kim": "분석팀",
};

export function localizeDashboardName(dashboard: SavedDashboardCard) {
  return dashboard.name;
}

export function localizeDashboardTags(tags: string) {
  return splitDashboardTags(tags).map((tag) => dashboardTagLabels[tag] ?? tag);
}

export function localizeDashboardOwner(owner: string) {
  return dashboardOwnerLabels[owner] ?? owner;
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

export function normalizeSavedDashboardCard(card: SavedDashboardCard): SavedDashboardCard {
  const createdAt = card.createdAt ?? fallbackDashboardDate;
  const createdAtValue = card.createdAtValue ?? fallbackDashboardDateValue;

  return {
    ...card,
    createdAt,
    createdAtValue,
    status: normalizeDashboardStatus(card.status),
    updatedAtValue: card.updatedAtValue ?? createdAtValue,
  };
}

export function hydrateSavedDashboardCards(cards: SavedDashboardCard[]) {
  return cards.map(normalizeSavedDashboardCard);
}

export function getDashboardSortLabel(sortOption: DashboardSortOption) {
  return dashboardSortOptions.find((option) => option.id === sortOption)?.ariaLabel ?? "정렬 기준";
}
