import "@xyflow/react/dist/style.css";
import type { CatalogDataset, DatasetMaterializationRun, LineageGraphDataset } from "../../types";
export type LineageColumn = {
  baseId: string;
  id: string;
  name: string;
  type: string;
};

export type LineageTableNodeData = Record<string, unknown> & {
  activeColumnKey: string | null;
  columns: LineageColumn[];
  dataset: LineageGraphDataset;
  dimmed: boolean;
  handleMode: "source" | "target" | "both";
  highlighted: boolean;
  nodeId: string;
  onColumnSelect: (columnKey: string | null) => void;
  relatedColumnKeys: string[] | null;
  selected: boolean;
};

export const lineageFitViewOptions = { maxZoom: 1.08, padding: 0.08 };

export type CatalogFilterState = {
  approvalRequired: boolean;
  available: boolean;
  rag: boolean;
};

export type CatalogStatusFilter = "all" | keyof CatalogFilterState;

export type CatalogSearchQuery = {
  keywords: string[];
  tags: string[];
};

export type CatalogSortMode = "default" | "name" | "updated" | "quality";

export type CatalogSchemaTableVariant = "full" | "preview";

export type CatalogSchemaRow = {
  description: string;
  id: string;
  name: string;
  sample: string;
  type: string;
};

export const catalogSortOptions: Array<{ label: string; mode: CatalogSortMode }> = [
  { label: "기본순", mode: "default" },
  { label: "이름순", mode: "name" },
  { label: "최근 갱신순", mode: "updated" },
  { label: "품질 높은순", mode: "quality" },
];

export const catalogStatusFilterOptions: Array<{ label: string; value: CatalogStatusFilter }> = [
  { label: "전체", value: "all" },
  { label: "사용 가능", value: "available" },
  { label: "승인 필요", value: "approvalRequired" },
  { label: "RAG 여부", value: "rag" },
];

export const catalogPageSize = 5;

export const materializationRunPageSize = 5;

export const catalogSearchDebounceMs = 300;

export const lineageNodeWidth = 220;

export const lineageNodeHeaderHeight = 76;

export const lineageColumnRowHeight = 32;

export const lineageGroupGap = 44;

export function normalizeCatalogText(value: string) {
  return value.trim().toLowerCase();
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function getCatalogTagsByFrequency(datasets: CatalogDataset[]) {
  const tagCounts = new Map<string, { count: number; firstIndex: number; tag: string }>();
  let nextIndex = 0;

  datasets.forEach((dataset) => {
    const datasetTags = new Set(dataset.tags.map((tag) => tag.trim()).filter(Boolean));

    datasetTags.forEach((tag) => {
      const normalizedTag = normalizeCatalogText(tag);
      const current = tagCounts.get(normalizedTag);

      if (current) {
        tagCounts.set(normalizedTag, { ...current, count: current.count + 1 });
        return;
      }

      tagCounts.set(normalizedTag, { count: 1, firstIndex: nextIndex, tag });
      nextIndex += 1;
    });
  });

  return Array.from(tagCounts.values())
    .sort((left, right) => right.count - left.count || left.firstIndex - right.firstIndex)
    .map(({ tag }) => tag);
}

export function formatCatalogDateTime(value: string) {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value || "-";
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(new Date(parsed));
}

export function formatRunCreatedAt(value: string) {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value || "-";
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(parsed));
}

export function formatRunStorageSize(sizeBytes: number) {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return "0B";
  if (sizeBytes < 1024) return `${sizeBytes}B`;

  const units = ["KB", "MB", "GB", "TB"];
  let size = sizeBytes;
  for (const unit of units) {
    size /= 1024;
    if (size < 1024) return `${size.toFixed(1)}${unit}`;
  }
  return `${size.toFixed(1)}PB`;
}

export function materializationRunStatusLabel(status: DatasetMaterializationRun["status"]) {
  if (status === "success") return "성공";
  if (status === "failed") return "실패";
  if (status === "canceled") return "취소";
  if (status === "running") return "실행 중";
  return "대기";
}

export function formatCatalogModelExecution(executionMode?: string, fallbackUsed?: boolean) {
  if (fallbackUsed || executionMode === "fallback_rule") return "규칙 Fallback";
  if (executionMode === "selected_model") return "선택 모델";
  if (executionMode === "auto_model") return "자동 모델";
  if (executionMode === "missing_model") return "모델 없음";
  return executionMode || "처리 정보 없음";
}

export function parseCatalogSearchQuery(query: string, knownTags: string[]): CatalogSearchQuery {
  let remainingQuery = normalizeCatalogText(query);
  const tags: string[] = [];

  knownTags
    .map(normalizeCatalogText)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .forEach((tag) => {
      const tagPattern = new RegExp(`(^|\\s)${escapeRegExp(tag)}(?=\\s|$)`);

      if (!tagPattern.test(remainingQuery)) return;

      tags.push(tag);
      remainingQuery = remainingQuery.replace(new RegExp(`(^|\\s)${escapeRegExp(tag)}(?=\\s|$)`, "g"), " ");
    });

  return {
    keywords: remainingQuery.split(/\s+/).filter(Boolean),
    tags: Array.from(new Set(tags)),
  };
}

export function datasetMatchesSearch(dataset: CatalogDataset, searchQuery: CatalogSearchQuery) {
  if (searchQuery.keywords.length === 0 && searchQuery.tags.length === 0) return true;

  const searchableText = [
    dataset.name,
    dataset.description,
    dataset.source,
    dataset.owner,
    dataset.layer,
    dataset.status,
    dataset.freshness,
    ...dataset.tags,
    ...dataset.upstream,
    ...dataset.downstream,
    ...dataset.schema.flatMap(([name, type]) => [name, type]),
  ].map(normalizeCatalogText).join(" ");
  const datasetTags = new Set(dataset.tags.map(normalizeCatalogText));

  return searchQuery.tags.every((tag) => datasetTags.has(tag))
    && searchQuery.keywords.every((keyword) => searchableText.includes(keyword));
}

export function datasetMatchesFilters(dataset: CatalogDataset, filters: CatalogFilterState) {
  const statusFilterActive = filters.available || filters.approvalRequired;
  const matchesStatus = !statusFilterActive
    || (filters.available && dataset.status === "available")
    || (filters.approvalRequired && dataset.status === "approval_required");
  const matchesRag = !filters.rag || dataset.rag;

  return matchesStatus && matchesRag;
}

export function parseCatalogDateTime(value: string) {
  if (value.includes("현재")) return Number.POSITIVE_INFINITY;

  const parsedTime = Date.parse(value.replace(" ", "T"));
  return Number.isNaN(parsedTime) ? 0 : parsedTime;
}

export function parseCatalogQualityScore(value: string) {
  const [score] = value.match(/\d+(?:\.\d+)?/) ?? [];
  return score ? Number(score) : 0;
}

export function compareCatalogDatasetsBySort(
  left: { dataset: CatalogDataset; index: number },
  right: { dataset: CatalogDataset; index: number },
  sortMode: CatalogSortMode,
) {
  if (sortMode === "name") {
    return left.dataset.name.localeCompare(right.dataset.name, "ko");
  }

  if (sortMode === "updated") {
    return parseCatalogDateTime(right.dataset.lastUpdated) - parseCatalogDateTime(left.dataset.lastUpdated);
  }

  if (sortMode === "quality") {
    return parseCatalogQualityScore(right.dataset.quality) - parseCatalogQualityScore(left.dataset.quality);
  }

  return 0;
}
