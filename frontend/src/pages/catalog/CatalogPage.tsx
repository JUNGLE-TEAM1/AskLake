import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import {
  type ColumnDef,
} from "@tanstack/react-table";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, useUpdateNodeInternals } from "@xyflow/react";
import type { Edge, Node as FlowNode, ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  LayoutGrid,
  Pin,
  Star,
  Search,
  Share2,
  Table2,
  TerminalSquare,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumnMeta } from "@/components/ui/data-table";
import {
  FilterToolbar,
  FilterToolbarActions,
  FilterToolbarCheckbox,
  FilterToolbarCheckboxGroup,
  FilterToolbarFieldGroup,
  FilterToolbarInput,
  FilterToolbarMenu,
  FilterToolbarSearch,
} from "@/components/ui/filter-toolbar";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { PageTitle } from "../../components/common";
import { getDatasetLineageGraph } from "../../services/mockApi";
import type { AuditResult, CatalogDataset, DatasetMaterializationRun, LineageGraph, LineageGraphDataset, LineageLayer } from "../../types";
import { datasetStatusMeta } from "../../utils/statusMeta";

type LineageColumn = {
  baseId: string;
  id: string;
  name: string;
  type: string;
};

type LineageTableNodeData = Record<string, unknown> & {
  activeColumnKey: string | null;
  columns: LineageColumn[];
  dimmed: boolean;
  engine: string;
  handleMode: "source" | "target" | "both";
  highlighted: boolean;
  layerLabel: string;
  nodeId: string;
  onColumnSelect: (columnKey: string | null) => void;
  relatedColumnKeys: string[] | null;
  tableName: string;
  tone: "source" | "bronze" | "silver" | "gold" | "downstream";
};

const lineageNodeTypes = {
  lineageTable: LineageTableNode,
};
const lineageFitViewOptions = { maxZoom: 1.08, padding: 0.08 };

type CatalogFilterState = {
  approvalRequired: boolean;
  available: boolean;
  rag: boolean;
};

type CatalogSearchQuery = {
  keywords: string[];
  tags: string[];
};

type CatalogSortMode = "default" | "name" | "updated" | "quality";
type CatalogSchemaTableVariant = "full" | "preview";
type CatalogSchemaRow = {
  description: string;
  id: string;
  name: string;
  nullable: "NO" | "YES";
  type: string;
};

const catalogSortOptions: Array<{ label: string; mode: CatalogSortMode }> = [
  { label: "기본순", mode: "default" },
  { label: "이름순", mode: "name" },
  { label: "최근 갱신순", mode: "updated" },
  { label: "품질 높은순", mode: "quality" },
];

const catalogPageSize = 5;
const materializationRunPageSize = 5;
const catalogSearchDebounceMs = 300;
const lineageNodeWidth = 220;
const lineageNodeHeaderHeight = 76;
const lineageColumnRowHeight = 32;
const lineageGroupGap = 44;

function normalizeCatalogText(value: string) {
  return value.trim().toLowerCase();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getCatalogTagsByFrequency(datasets: CatalogDataset[]) {
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

function formatRunCreatedAt(value: string) {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value || "-";
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(parsed));
}

function formatRunStorageSize(sizeBytes: number) {
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

function materializationRunStatusLabel(status: DatasetMaterializationRun["status"]) {
  if (status === "success") return "성공";
  if (status === "failed") return "실패";
  if (status === "canceled") return "취소";
  if (status === "running") return "실행 중";
  return "대기";
}

function parseCatalogSearchQuery(query: string, knownTags: string[]): CatalogSearchQuery {
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

function removeCatalogTagFromSearchText(searchText: string, tag: string) {
  return searchText
    .replace(new RegExp(`(^|\\s)${escapeRegExp(tag)}(?=\\s|$)`, "gi"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

function datasetMatchesSearch(dataset: CatalogDataset, searchQuery: CatalogSearchQuery) {
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

function datasetMatchesFilters(dataset: CatalogDataset, filters: CatalogFilterState) {
  const statusFilterActive = filters.available || filters.approvalRequired;
  const matchesStatus = !statusFilterActive
    || (filters.available && dataset.status === "available")
    || (filters.approvalRequired && dataset.status === "approval_required");
  const matchesRag = !filters.rag || dataset.rag;

  return matchesStatus && matchesRag;
}

function parseCatalogDateTime(value: string) {
  if (value.includes("현재")) return Number.POSITIVE_INFINITY;

  const parsedTime = Date.parse(value.replace(" ", "T"));
  return Number.isNaN(parsedTime) ? 0 : parsedTime;
}

function parseCatalogQualityScore(value: string) {
  const [score] = value.match(/\d+(?:\.\d+)?/) ?? [];
  return score ? Number(score) : 0;
}

function compareCatalogDatasetsBySort(
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

export function CatalogPage({
  datasets,
  onAction,
  onMaterializationRunDelete,
  onOpenSql,
  selectedDataset,
}: {
  datasets: CatalogDataset[];
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onMaterializationRunDelete: (datasetId: string, runId: string) => void;
  onOpenSql: (dataset: CatalogDataset) => void;
  selectedDataset: CatalogDataset;
}) {
  const [previewDataset, setPreviewDataset] = useState<CatalogDataset>(selectedDataset);
  const [activeModal, setActiveModal] = useState<"lineage" | "schema" | null>(null);
  const [filterState, setFilterState] = useState<CatalogFilterState>({ approvalRequired: false, available: false, rag: false });
  const [currentPage, setCurrentPage] = useState(1);
  const [expandedDatasetIds, setExpandedDatasetIds] = useState<string[]>([]);
  const [materializationRunPageByDatasetId, setMaterializationRunPageByDatasetId] = useState<Record<string, number>>({});
  const [pinnedDatasetIds, setPinnedDatasetIds] = useState<string[]>([]);
  const [selectedSqlRunTarget, setSelectedSqlRunTarget] = useState<{ datasetId: string; datasetName: string; runId: string } | null>(null);
  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [debouncedSearchText, setDebouncedSearchText] = useState("");
  const [sortMode, setSortMode] = useState<CatalogSortMode>("default");
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const tags = useMemo(() => getCatalogTagsByFrequency(datasets), [datasets]);
  const topTags = useMemo(() => tags.slice(0, 10), [tags]);
  const inputSearchQuery = useMemo(() => parseCatalogSearchQuery(searchText, tags), [searchText, tags]);
  const searchQuery = useMemo(() => parseCatalogSearchQuery(debouncedSearchText, tags), [debouncedSearchText, tags]);
  const selectedSearchTags = useMemo(() => new Set(inputSearchQuery.tags), [inputSearchQuery.tags]);
  const selectedSortOption = catalogSortOptions.find((option) => option.mode === sortMode) ?? catalogSortOptions[0];
  const filteredDatasets = useMemo(() => datasets
    .map((dataset, index) => ({ dataset, index }))
    .filter(({ dataset }) => {
      const isPinned = pinnedDatasetIds.includes(dataset.id);
      const matchesSearch = datasetMatchesSearch(dataset, searchQuery);
      const matchesFilters = datasetMatchesFilters(dataset, filterState);

      return (isPinned || matchesSearch) && matchesFilters;
    })
    .sort((left, right) => {
      const leftPinnedIndex = pinnedDatasetIds.indexOf(left.dataset.id);
      const rightPinnedIndex = pinnedDatasetIds.indexOf(right.dataset.id);
      const leftPinned = leftPinnedIndex !== -1;
      const rightPinned = rightPinnedIndex !== -1;

      if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
      if (leftPinned && rightPinned) return leftPinnedIndex - rightPinnedIndex;
      const sortResult = compareCatalogDatasetsBySort(left, right, sortMode);
      if (sortResult !== 0) return sortResult;
      return left.index - right.index;
    })
    .map(({ dataset }) => dataset), [datasets, filterState, pinnedDatasetIds, searchQuery, sortMode]);
  const hasCatalogResults = filteredDatasets.length > 0;
  const totalCatalogPages = Math.max(1, Math.ceil(filteredDatasets.length / catalogPageSize));
  const currentCatalogPage = Math.min(Math.max(currentPage, 1), totalCatalogPages);
  const currentPageStartIndex = (currentCatalogPage - 1) * catalogPageSize;
  const paginatedDatasets = useMemo(
    () => filteredDatasets.slice(currentPageStartIndex, currentPageStartIndex + catalogPageSize),
    [currentPageStartIndex, filteredDatasets],
  );
  const currentPageEndIndex = currentPageStartIndex + paginatedDatasets.length;
  const isPreviewPinned = pinnedDatasetIds.includes(previewDataset.id);

  useEffect(() => {
    const debounceTimerId = window.setTimeout(() => {
      setDebouncedSearchText(searchText);
    }, catalogSearchDebounceMs);

    return () => window.clearTimeout(debounceTimerId);
  }, [searchText]);

  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedSearchText, filterState.approvalRequired, filterState.available, filterState.rag, sortMode]);

  useEffect(() => {
    if (currentPage === currentCatalogPage) return;
    setCurrentPage(currentCatalogPage);
  }, [currentCatalogPage, currentPage]);

  useEffect(() => {
    if (!isSortMenuOpen) return undefined;

    const closeSortMenu = (event: MouseEvent) => {
      if (sortMenuRef.current?.contains(event.target as Node)) return;
      setIsSortMenuOpen(false);
    };

    document.addEventListener("mousedown", closeSortMenu);
    return () => document.removeEventListener("mousedown", closeSortMenu);
  }, [isSortMenuOpen]);

  useEffect(() => {
    if (!hasCatalogResults || paginatedDatasets.length === 0) return;

    const selectedInResults = paginatedDatasets.find((dataset) => dataset.id === selectedDataset.id);
    const previewInResults = paginatedDatasets.find((dataset) => dataset.id === previewDataset.id);
    const nextPreview = previewDataset.id === selectedDataset.id
      ? selectedInResults ?? previewInResults ?? paginatedDatasets[0]
      : previewInResults ?? selectedInResults ?? paginatedDatasets[0];

    if (nextPreview !== previewDataset) {
      setPreviewDataset(nextPreview);
    }
  }, [hasCatalogResults, paginatedDatasets, previewDataset, selectedDataset.id]);

  const handleSearchSubmit = () => {
    const query = searchText.trim();
    setDebouncedSearchText(searchText);
    onAction("catalog.search.submitted", `/api/catalog/datasets?q=${encodeURIComponent(query)}`, query || "empty");
  };

  const addTagToSearch = (tag: string) => {
    const normalizedTag = normalizeCatalogText(tag);

    if (selectedSearchTags.has(normalizedTag)) {
      const nextSearchText = removeCatalogTagFromSearchText(searchText, tag);

      setSearchText(nextSearchText);
      onAction("catalog.tag_search_removed", `/api/catalog/datasets?q=${encodeURIComponent(nextSearchText)}`, tag);
      return;
    }

    const nextSearchText = [searchText.trim(), tag].filter(Boolean).join(" ");

    setSearchText(nextSearchText);
    onAction("catalog.tag_search_added", `/api/catalog/datasets?q=${encodeURIComponent(nextSearchText)}`, tag);
  };

  const updateFilter = (filterName: keyof CatalogFilterState, checked: boolean) => {
    setFilterState((filters) => ({ ...filters, [filterName]: checked }));
    onAction("catalog.filter_changed", `/api/catalog/datasets?filter=${filterName}&enabled=${checked}`, filterName);
  };

  const updateSortMode = (nextSortMode: CatalogSortMode) => {
    setSortMode(nextSortMode);
    setIsSortMenuOpen(false);
    onAction("catalog.sort_changed", `/api/catalog/search/sort?sort=${nextSortMode}`, nextSortMode);
  };

  const updateResultPage = (nextPage: number) => {
    const normalizedPage = Math.min(Math.max(nextPage, 1), totalCatalogPages);
    setCurrentPage(normalizedPage);
    onAction("catalog.page_changed", `/api/catalog/datasets?page=${normalizedPage}&pageSize=${catalogPageSize}`, String(normalizedPage));
  };

  const togglePinnedDataset = () => {
    const nextPinned = !isPreviewPinned;
    setPinnedDatasetIds((ids) => nextPinned ? [previewDataset.id, ...ids.filter((id) => id !== previewDataset.id)] : ids.filter((id) => id !== previewDataset.id));
    onAction(nextPinned ? "catalog.dataset.pinned" : "catalog.dataset.unpinned", `/api/catalog/datasets/${previewDataset.id}/pin`, previewDataset.id);
  };

  const selectPreviewDataset = (dataset: CatalogDataset) => {
    setPreviewDataset(dataset);
    setExpandedDatasetIds((ids) => ids.includes(dataset.id) ? ids.filter((id) => id !== dataset.id) : [...ids, dataset.id]);
    onAction("catalog.dataset.preview_selected", `/api/catalog/datasets/${dataset.id}`, dataset.id);
  };

  const updateMaterializationRunPage = (event: React.MouseEvent, dataset: CatalogDataset, nextPage: number) => {
    event.stopPropagation();
    const totalPages = Math.max(1, Math.ceil((dataset.materializationRuns?.length ?? 0) / materializationRunPageSize));
    const normalizedPage = Math.min(Math.max(nextPage, 1), totalPages);
    setMaterializationRunPageByDatasetId((state) => ({
      ...state,
      [dataset.id]: normalizedPage,
    }));
    onAction("catalog.dataset.materialization_runs_page_changed", `/api/catalog/datasets/${dataset.id}/materialization-runs?page=${normalizedPage}`, dataset.id);
  };

  const selectSqlMaterializationRun = (event: React.MouseEvent | React.KeyboardEvent, dataset: CatalogDataset, run: DatasetMaterializationRun) => {
    event.stopPropagation();
    if (run.status !== "success") return;
    setPreviewDataset(dataset);
    setSelectedSqlRunTarget({ datasetId: dataset.id, datasetName: dataset.name, runId: run.runId });
    onAction("catalog.dataset.materialization_run_selected_for_sql", `/api/catalog/datasets/${dataset.id}/materialization-runs/${run.runId}`, dataset.id);
  };

  const deleteMaterializationRun = (event: React.MouseEvent, dataset: CatalogDataset, runId: string) => {
    event.stopPropagation();
    setSelectedSqlRunTarget((target) => target?.datasetId === dataset.id && target.datasetName === dataset.name && target.runId === runId ? null : target);
    onMaterializationRunDelete(dataset.id, runId);
  };

  const openSelectedSqlDataset = () => {
    if (!selectedSqlRunTarget || selectedSqlRunTarget.datasetId !== previewDataset.id || selectedSqlRunTarget.datasetName !== previewDataset.name) return;
    onAction("catalog.open_in_sql.materialization_run_confirmed", `/api/catalog/datasets/${previewDataset.id}/materialization-runs/${selectedSqlRunTarget.runId}/query`, previewDataset.id, "success");
    onOpenSql(previewDataset);
  };

  return (
    <div className="catalog-page">
      <PageTitle title="검색/카탈로그" description="데이터셋을 검색하고 스키마, 리니지, 활용 흐름을 확인합니다." />
      <div className="catalog-content-grid">
        <div className="catalog-main">
          <Panel className="catalog-search-panel">
            <PanelHeader
              description="테이블명, 컬럼명, 태그, 업무 키워드로 데이터셋을 찾습니다."
              icon={<Search size={16} />}
              meta={<Badge size="sm">{selectedSearchTags.size ? `${selectedSearchTags.size}개 태그` : "전체 검색"}</Badge>}
              title="검색 조건"
            />
            <FilterToolbar layout="stacked">
              <FilterToolbarSearch icon={<Search size={18} />}>
                <FilterToolbarInput
                  aria-label="카탈로그 검색"
                  onChange={(event) => setSearchText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      handleSearchSubmit();
                    }
                  }}
                  placeholder="테이블명, 컬럼명, 태그 또는 업무 키워드로 검색하세요..."
                  type="search"
                  value={searchText}
                />
              </FilterToolbarSearch>
              <FilterToolbarFieldGroup label="태그">
                {topTags.map((tag) => {
                  const isTagInSearch = selectedSearchTags.has(normalizeCatalogText(tag));

                  return (
                    <Button
                      aria-pressed={isTagInSearch}
                      className={isTagInSearch ? "catalog-tag active" : "catalog-tag"}
                      key={tag}
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => addTagToSearch(tag)}
                    >
                      {tag}
                    </Button>
                  );
                })}
              </FilterToolbarFieldGroup>
            </FilterToolbar>
          </Panel>

          <Panel className="catalog-results-section">
            <div className="catalog-results-header">
              <PanelHeader
                bordered={false}
                description="조건에 맞는 데이터셋을 선택하면 우측에서 상세 정보를 확인합니다."
                icon={<LayoutGrid size={16} />}
                meta={<Badge size="sm">{filteredDatasets.length}건</Badge>}
                title="검색 결과"
              />
              <FilterToolbar
                className="grid-cols-[minmax(0,1fr)_max-content] gap-3 py-3 max-xl:grid-cols-1"
                layout="actions"
              >
                <FilterToolbarCheckboxGroup>
                  <FilterToolbarCheckbox checked={filterState.available} onCheckedChange={(checked) => updateFilter("available", checked)}>
                    사용 가능
                  </FilterToolbarCheckbox>
                  <FilterToolbarCheckbox checked={filterState.approvalRequired} onCheckedChange={(checked) => updateFilter("approvalRequired", checked)}>
                    승인 필요
                  </FilterToolbarCheckbox>
                  <FilterToolbarCheckbox checked={filterState.rag} onCheckedChange={(checked) => updateFilter("rag", checked)}>
                    RAG 여부
                  </FilterToolbarCheckbox>
                </FilterToolbarCheckboxGroup>
                <FilterToolbarActions>
                  <FilterToolbarMenu className="catalog-sort-control" ref={sortMenuRef}>
                    <Button
                      aria-expanded={isSortMenuOpen}
                      aria-haspopup="menu"
                      className="catalog-sort-button"
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setIsSortMenuOpen((isOpen) => !isOpen);
                        onAction("catalog.sort_opened", "/api/catalog/search/sort", "catalog-sort");
                      }}
                    >
                      정렬: {selectedSortOption.label} ▾
                    </Button>
                    {isSortMenuOpen && (
                      <div className="catalog-sort-menu" role="menu" aria-label="정렬 기준">
                        {catalogSortOptions.map((option) => (
                          <Button
                            aria-checked={sortMode === option.mode}
                            className={sortMode === option.mode ? "active" : ""}
                            key={option.mode}
                            role="menuitemradio"
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => updateSortMode(option.mode)}
                          >
                            <span>{sortMode === option.mode ? "✓" : ""}</span>
                            {option.label}
                          </Button>
                        ))}
                      </div>
                    )}
                  </FilterToolbarMenu>
                </FilterToolbarActions>
              </FilterToolbar>
            </div>

            <div className="catalog-result-list">
              {paginatedDatasets.map((dataset) => {
                const isPinned = pinnedDatasetIds.includes(dataset.id);
                const isActive = dataset.id === previewDataset.id;
                const isExpanded = expandedDatasetIds.includes(dataset.id);

                return (
                  <div className={["catalog-result-item", isExpanded ? "expanded" : ""].filter(Boolean).join(" ")} key={`${dataset.id}:${dataset.name}`}>
                    <article
                      className={["catalog-result-card", isActive ? "active" : "", isPinned ? "pinned" : ""].filter(Boolean).join(" ")}
                      role="button"
                      tabIndex={0}
                      onClick={() => selectPreviewDataset(dataset)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          selectPreviewDataset(dataset);
                        }
                      }}
                    >
                      <div className="catalog-result-summary">
                        {isPinned && (
                          <span className="catalog-result-pin-badge" aria-label="상단 고정된 데이터셋">
                            <Pin size={13} />
                            고정됨
                          </span>
                        )}
                        <div className="catalog-result-title">
                          <strong>{dataset.name}</strong>
                          <DatasetStatusBadge dataset={dataset} />
                          <span className="catalog-result-expand-indicator">{isExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</span>
                        </div>
                        <div className="catalog-result-metrics">
                          <span>{dataset.rows}</span>
                          <span>{dataset.size}</span>
                          <span>{dataset.materializationRuns?.length ?? 0} runs</span>
                        </div>
                        <div className="catalog-result-tags">
                          {dataset.tags.map((tag) => <span key={tag}>{tag}</span>)}
                        </div>
                      </div>
                    </article>
                    {isExpanded && (
                      <CatalogMaterializationRuns
                        dataset={dataset}
                        onDelete={deleteMaterializationRun}
                        onPageChange={updateMaterializationRunPage}
                        onSelectRun={selectSqlMaterializationRun}
                        page={materializationRunPageByDatasetId[dataset.id] ?? 1}
                        selectedRunId={selectedSqlRunTarget?.runId ?? null}
                      />
                    )}
                  </div>
                );
              })}
              {!hasCatalogResults && (
                <div className="catalog-empty-state">
                  <strong>검색 결과가 없습니다.</strong>
                  <span>검색어, 태그, 상태 필터를 조정해 다시 확인하세요.</span>
                </div>
              )}
            </div>

            {hasCatalogResults && (
              <div className="catalog-pagination" aria-label="검색 결과 페이지">
                <span>{currentPageStartIndex + 1}-{currentPageEndIndex} / {filteredDatasets.length}</span>
                <div>
                  <Button
                    type="button"
                    disabled={currentCatalogPage === 1}
                    onClick={() => updateResultPage(currentCatalogPage - 1)}
                    size="sm"
                    variant="outline"
                  >
                    이전
                  </Button>
                  <strong>{currentCatalogPage} / {totalCatalogPages}</strong>
                  <Button
                    type="button"
                    disabled={currentCatalogPage === totalCatalogPages}
                    onClick={() => updateResultPage(currentCatalogPage + 1)}
                    size="sm"
                    variant="outline"
                  >
                    다음
                  </Button>
                </div>
              </div>
            )}
          </Panel>
        </div>

        {hasCatalogResults ? (
          <Panel asChild className="catalog-preview-panel">
            <aside>
              <PanelHeader
                actions={(
                  <Button
                    aria-label={isPreviewPinned ? "데이터셋 고정 해제" : "데이터셋 상단 고정"}
                    aria-pressed={isPreviewPinned}
                    className={isPreviewPinned ? "catalog-favorite-button active" : "catalog-favorite-button"}
                    title={isPreviewPinned ? "데이터셋 고정 해제" : "데이터셋 상단 고정"}
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={togglePinnedDataset}
                  >
                    <Star size={18} />
                  </Button>
                )}
                className="catalog-preview-title"
                description={`${previewDataset.layer} 데이터셋 · ${previewDataset.owner}`}
                icon={<LayoutGrid size={16} />}
                iconVariant="success"
                title={previewDataset.name}
              />
              <div className="catalog-overview-metrics catalog-preview-metrics">
                <CatalogMiniMetric label="품질 지표" value={previewDataset.quality} />
                <CatalogMiniMetric label="최근 갱신 일시" value={previewDataset.lastUpdated} />
                <CatalogMiniMetric label="데이터 담당자" value={previewDataset.owner} />
                <CatalogMiniMetric label="행 수" value={previewDataset.rows} />
                <CatalogMiniMetric label="파일 크기" value={previewDataset.size} />
                <CatalogMiniMetric label="갱신 예정 일시" value={previewDataset.nextRefresh} />
              </div>

              <article className="catalog-preview-card">
                <div className="catalog-preview-card-header">
                  <TerminalSquare size={16} />
                  <h3>스키마 미리보기</h3>
                  <span>{previewDataset.schema.length} 컬럼</span>
                </div>
                <CatalogSchemaTable dataset={previewDataset} maxRows={5} variant="preview" />
                <Button className="catalog-text-button" type="button" onClick={() => {
                  onAction("catalog.schema.modal_opened", `/api/catalog/datasets/${previewDataset.id}/schema`, previewDataset.id);
                  setActiveModal("schema");
                }} size="sm" variant="link">전체 스키마 상세 보기</Button>
              </article>

              <article className="catalog-lineage-teaser" role="button" tabIndex={0} onClick={() => {
                onAction("catalog.lineage.opened", `/api/catalog/datasets/${previewDataset.id}/lineage`, previewDataset.id);
                setActiveModal("lineage");
              }} onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onAction("catalog.lineage.opened", `/api/catalog/datasets/${previewDataset.id}/lineage`, previewDataset.id);
                  setActiveModal("lineage");
                }
              }}>
                <Share2 size={16} />
                <div>
                  <strong>리니지 보기</strong>
                </div>
                <span>›</span>
              </article>

              <Button
                className="primary-button catalog-wide-button"
                disabled={selectedSqlRunTarget?.datasetId !== previewDataset.id || selectedSqlRunTarget.datasetName !== previewDataset.name}
                title={selectedSqlRunTarget?.datasetId === previewDataset.id && selectedSqlRunTarget.datasetName === previewDataset.name ? "선택한 append 결과 기준으로 SQL 분석을 엽니다." : "생성/append 결과를 먼저 선택해 주세요."}
                type="button"
                size="sm"
                variant="primary"
                onClick={openSelectedSqlDataset}
              >
                <ExternalLink size={16} /> SQL 분석에서 열기
              </Button>
              <p className={selectedSqlRunTarget?.datasetId === previewDataset.id && selectedSqlRunTarget.datasetName === previewDataset.name ? "catalog-sql-target-hint active" : "catalog-sql-target-hint"}>
                {selectedSqlRunTarget?.datasetId === previewDataset.id && selectedSqlRunTarget.datasetName === previewDataset.name
                  ? `선택된 결과: ${selectedSqlRunTarget.runId}`
                  : "생성/append 결과를 선택하면 SQL 분석 이동이 활성화됩니다."}
              </p>
            </aside>
          </Panel>
        ) : (
          <aside className="catalog-preview-panel catalog-preview-panel-empty">
            <LayoutGrid size={22} />
            <strong>선택할 데이터셋이 없습니다.</strong>
            <p>검색 조건을 바꾸면 일치하는 데이터셋의 스키마, 리니지, SQL 이동 정보를 다시 확인할 수 있습니다.</p>
          </aside>
        )}
      </div>
      {activeModal && (
        <CatalogModal
          dataset={previewDataset}
          onClose={() => setActiveModal(null)}
          title={activeModal === "schema" ? "전체 스키마" : "리니지"}
          variant={activeModal}
        >
          {activeModal === "schema" ? <CatalogSchema dataset={previewDataset} /> : <CatalogLineage dataset={previewDataset} compact />}
        </CatalogModal>
      )}
    </div>
  );
}

function CatalogModal({
  children,
  dataset,
  onClose,
  title,
  variant,
}: {
  children: React.ReactNode;
  dataset: CatalogDataset;
  onClose: () => void;
  title: string;
  variant: "lineage" | "schema";
}) {
  return (
    <div className="catalog-modal-backdrop" role="presentation" onClick={onClose}>
      <section className={`catalog-modal ${variant === "lineage" ? "lineage-modal" : ""}`} role="dialog" aria-modal="true" aria-label={`${dataset.name} ${title}`} onClick={(event) => event.stopPropagation()}>
        <header className="catalog-modal-header">
          <div>
            <span>{dataset.layer} 데이터셋</span>
            <h2>{dataset.name}</h2>
            <p>{title}</p>
          </div>
          <Button type="button" onClick={onClose} size="sm" variant="outline">닫기</Button>
        </header>
        <div className="catalog-modal-body">
          {children}
        </div>
      </section>
    </div>
  );
}

export function CatalogDetailPage({
  dataset,
  onAction,
  onBack,
  onLineage,
  onOpenSql,
}: {
  dataset: CatalogDataset;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onBack: () => void;
  onLineage: () => void;
  onOpenSql: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"overview" | "schema" | "sample" | "lineage">("overview");

  const openLineage = () => {
    setActiveTab("lineage");
    onLineage();
  };

  return (
    <div className="catalog-detail-page">
      <header className="catalog-detail-header">
        <Button className="job-detail-breadcrumb" type="button" onClick={onBack} size="sm" variant="link">검색/카탈로그 &gt; {dataset.name}</Button>
        <div className="catalog-detail-title-row">
          <div>
            <h1>{dataset.name}</h1>
            <div className="job-detail-meta">
              <DatasetStatusBadge dataset={dataset} />
              <span className="owner-chip">{dataset.owner}</span>
              <span className="tag-chip">{dataset.layer} 레이어</span>
              {dataset.tags.map((tag) => <span className="tag-chip" key={tag}>{tag}</span>)}
            </div>
          </div>
          <div className="job-detail-actions">
            <Button className="job-action-button primary" type="button" onClick={onOpenSql} size="sm" variant="primary"><ExternalLink size={14} /> SQL 분석에서 열기</Button>
            <Button className="job-action-button" type="button" onClick={openLineage} size="sm" variant="outline">리니지 보기</Button>
            <Button className="job-action-button" type="button" onClick={() => onAction("catalog.dataset.refreshed", `/api/catalog/datasets/${dataset.id}`, dataset.id)} size="sm" variant="outline">새로고침</Button>
          </div>
        </div>
        <nav className="job-detail-tabs" aria-label="데이터셋 상세 탭">
          {[
            ["overview", "개요"],
            ["schema", "스키마"],
            ["sample", "샘플 데이터"],
            ["lineage", "리니지"],
          ].map(([id, label]) => (
            <button className={activeTab === id ? "active" : ""} key={id} type="button" onClick={() => {
              if (id === "lineage") onLineage();
              setActiveTab(id as typeof activeTab);
            }}>{label}</button>
          ))}
        </nav>
      </header>

      {activeTab === "overview" && <CatalogOverview dataset={dataset} onLineage={openLineage} />}
      {activeTab === "schema" && <CatalogSchema dataset={dataset} />}
      {activeTab === "sample" && <CatalogSample dataset={dataset} />}
      {activeTab === "lineage" && <CatalogLineage dataset={dataset} />}
    </div>
  );
}

export function DatasetStatusBadge({ dataset }: { dataset: CatalogDataset }) {
  const statusMeta = datasetStatusMeta[dataset.status];

  return (
    <>
      {dataset.rag && <Badge className="dataset-rag-badge" size="sm" variant="success">RAG</Badge>}
      <Badge className={`dataset-status-badge ${statusMeta.className}`} size="sm" variant="outline">{statusMeta.label}</Badge>
    </>
  );
}

function CatalogMiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="catalog-mini-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CatalogMaterializationRuns({
  dataset,
  onDelete,
  onPageChange,
  onSelectRun,
  page,
  selectedRunId,
}: {
  dataset: CatalogDataset;
  onDelete: (event: React.MouseEvent, dataset: CatalogDataset, runId: string) => void;
  onPageChange: (event: React.MouseEvent, dataset: CatalogDataset, nextPage: number) => void;
  onSelectRun: (event: React.MouseEvent | React.KeyboardEvent, dataset: CatalogDataset, run: DatasetMaterializationRun) => void;
  page: number;
  selectedRunId: string | null;
}) {
  const runs = dataset.materializationRuns ?? [];
  const totalPages = Math.max(1, Math.ceil(runs.length / materializationRunPageSize));
  const currentPage = Math.min(Math.max(page, 1), totalPages);
  const pageStartIndex = (currentPage - 1) * materializationRunPageSize;
  const visibleRuns = runs.slice(pageStartIndex, pageStartIndex + materializationRunPageSize);

  return (
    <div className="catalog-materialization-panel" onClick={(event) => event.stopPropagation()}>
      <div className="catalog-materialization-header">
        <strong>생성/append 결과</strong>
        <span>{runs.length}개 결과 · {dataset.rows} · {dataset.size}</span>
      </div>
      {visibleRuns.length > 0 ? (
        <div className="catalog-materialization-list">
          {visibleRuns.map((run) => {
            const isSelectable = run.status === "success";
            const isSelected = run.runId === selectedRunId;

            return (
            <div
              aria-disabled={!isSelectable}
              aria-pressed={isSelected}
              className={["catalog-materialization-row", isSelectable ? "selectable" : "disabled", isSelected ? "selected" : ""].filter(Boolean).join(" ")}
              key={run.runId}
              role="button"
              tabIndex={isSelectable ? 0 : -1}
              title={isSelectable ? "SQL 분석 대상으로 선택" : "성공한 append 결과만 SQL 분석 대상으로 선택할 수 있습니다."}
              onClick={(event) => onSelectRun(event, dataset, run)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectRun(event, dataset, run);
                }
              }}
            >
              <span className={`catalog-run-status ${run.status}`}>{materializationRunStatusLabel(run.status)}</span>
              <strong title={run.runId}>{run.runId}</strong>
              <span>{formatRunCreatedAt(run.createdAt)}</span>
              <span>{run.rowCount.toLocaleString()} rows</span>
              <span>{formatRunStorageSize(run.storageSizeBytes)}</span>
              <span title={run.sourceLabel}>{run.sourceLabel}</span>
              <Button
                aria-label={`${run.runId} append 결과 삭제`}
                className="catalog-materialization-delete"
                type="button"
                size="sm"
                variant="destructive"
                onClick={(event) => {
                  if (window.confirm("이 append 결과를 데이터셋에서 삭제할까요?")) {
                    onDelete(event, dataset, run.runId);
                  } else {
                    event.stopPropagation();
                  }
                }}
              >
                삭제
              </Button>
            </div>
            );
          })}
        </div>
      ) : (
        <div className="catalog-materialization-empty">아직 append된 실행 결과가 없습니다.</div>
      )}
      {runs.length > materializationRunPageSize && (
        <div className="catalog-materialization-pagination">
          <span>{pageStartIndex + 1}-{Math.min(pageStartIndex + visibleRuns.length, runs.length)} / {runs.length}</span>
          <div>
            <Button disabled={currentPage === 1} type="button" onClick={(event) => onPageChange(event, dataset, currentPage - 1)} size="sm" variant="outline">이전</Button>
            <strong>{currentPage} / {totalPages}</strong>
            <Button disabled={currentPage === totalPages} type="button" onClick={(event) => onPageChange(event, dataset, currentPage + 1)} size="sm" variant="outline">다음</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function CatalogOverview({ dataset, onLineage }: { dataset: CatalogDataset; onLineage: () => void }) {
  return (
    <div className="catalog-detail-grid catalog-detail-grid-single">
      <section className="catalog-overview-card">
        <h2>리니지</h2>
        <CatalogLineageMini dataset={dataset} />
        <Button className="catalog-text-button" type="button" onClick={onLineage} size="sm" variant="link">전체 리니지 보기</Button>
      </section>
    </div>
  );
}

function CatalogSchema({ dataset }: { dataset: CatalogDataset }) {
  return (
    <section className="catalog-table-card">
      <div className="catalog-section-header">
        <h2>스키마</h2>
        <span>{dataset.schema.length} 컬럼</span>
      </div>
      <CatalogSchemaTable dataset={dataset} />
    </section>
  );
}

function CatalogSchemaTable({ dataset, maxRows, variant = "full" }: { dataset: CatalogDataset; maxRows?: number; variant?: CatalogSchemaTableVariant }) {
  const data = useMemo(
    () => dataset.schema.slice(0, maxRows ?? dataset.schema.length).map(([name, type], index) => ({
      description: `${dataset.name}의 ${name} 필드`,
      id: `${name}-${index}`,
      name,
      nullable: index % 2 === 0 ? "NO" as const : "YES" as const,
      type,
    })),
    [dataset.name, dataset.schema, maxRows],
  );
  const columns = useMemo<ColumnDef<CatalogSchemaRow>[]>(
    () => {
      const baseColumns: ColumnDef<CatalogSchemaRow>[] = [
        {
          accessorKey: "name",
          cell: (info) => <span title={info.getValue<string>()}>{info.getValue<string>()}</span>,
          enableSorting: variant !== "preview",
          header: "컬럼명",
          meta: {
            cellClassName: "catalog-schema-name-cell",
            widthClassName: variant === "preview" ? "w-[58%]" : "w-[28%]",
          } as DataTableColumnMeta,
        },
        {
          accessorKey: "type",
          cell: (info) => <span className="catalog-schema-type-pill">{info.getValue<string>()}</span>,
          enableSorting: variant !== "preview",
          header: "타입",
          meta: {
            widthClassName: variant === "preview" ? "w-[42%]" : "w-[18%]",
          } as DataTableColumnMeta,
        },
      ];

      if (variant === "preview") return baseColumns;

      return [
        ...baseColumns,
        {
          accessorKey: "nullable",
          cell: (info) => info.getValue<string>(),
          enableSorting: true,
          header: "NULL 허용",
          meta: {
            widthClassName: "w-[16%]",
          } as DataTableColumnMeta,
        },
        {
          accessorKey: "description",
          cell: (info) => <span title={info.getValue<string>()}>{info.getValue<string>()}</span>,
          enableSorting: true,
          header: "설명",
          meta: {
            cellClassName: "catalog-schema-description-cell",
            widthClassName: "w-[38%]",
          } as DataTableColumnMeta,
        },
      ];
    },
    [variant],
  );
  return (
    <DataTable
      className={variant === "preview" ? "catalog-schema-table-wrap preview" : "catalog-schema-table-wrap"}
      columns={columns}
      data={data}
      emptyState={{
        title: "스키마 컬럼이 없습니다.",
        description: "선택한 데이터셋에 표시할 컬럼 정보가 없습니다.",
      }}
      enableSorting={variant !== "preview"}
      getRowId={(row) => row.id}
      tableClassName={variant === "preview" ? "catalog-schema-preview" : "schema-table catalog-schema-table"}
      viewportClassName={variant === "preview" ? "catalog-schema-preview-viewport" : "catalog-schema-table-viewport"}
    />
  );
}

function CatalogSample({ dataset }: { dataset: CatalogDataset }) {
  const columns = dataset.schema.slice(0, 5).map(([name]) => name);
  return (
    <section className="catalog-table-card">
      <div className="catalog-section-header">
        <h2>샘플 데이터</h2>
        <span>읽기 전용 미리보기</span>
      </div>
      <div className="catalog-sample-scroll">
        <table className="schema-table">
          <thead><tr>{columns.map((column, index) => <th key={`${column}-${index}`}>{column}</th>)}</tr></thead>
          <tbody>{dataset.sampleRows.map((row, rowIndex) => <tr key={`sample-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{cell}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </section>
  );
}

function CatalogLineage({ compact = false, dataset }: { compact?: boolean; dataset: CatalogDataset }) {
  const [lineageGraph, setLineageGraph] = useState<LineageGraph | null>(dataset.lineageGraph ?? null);
  const [selectedColumnKey, setSelectedColumnKey] = useState<string | null>(null);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance | null>(null);
  const flowWrapperRef = useRef<HTMLDivElement | null>(null);
  const { edges, nodes } = lineageGraph
    ? buildLineageGraph(lineageGraph, selectedColumnKey, setSelectedColumnKey)
    : { edges: [], nodes: [] };
  const statusMeta = datasetStatusMeta[dataset.status];

  useEffect(() => {
    let isActive = true;
    setLineageGraph(dataset.lineageGraph ?? null);
    setSelectedColumnKey(null);
    getDatasetLineageGraph(dataset)
      .then((graph) => {
        if (isActive) setLineageGraph(graph);
      })
      .catch(() => {
        if (isActive) setLineageGraph(null);
      });

    return () => {
      isActive = false;
    };
  }, [dataset.id]);

  useEffect(() => {
    if (!flowInstance || !lineageGraph) return;

    const animationFrame = window.requestAnimationFrame(() => {
      void flowInstance.fitView(lineageFitViewOptions);
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [edges.length, flowInstance, lineageGraph, nodes.length]);

  useEffect(() => {
    if (!flowInstance || !flowWrapperRef.current || !lineageGraph || typeof ResizeObserver === "undefined") return;

    let animationFrame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        void flowInstance.fitView(lineageFitViewOptions);
      });
    });

    observer.observe(flowWrapperRef.current);

    return () => {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      observer.disconnect();
    };
  }, [flowInstance, lineageGraph]);

  return (
    <section className={compact ? "catalog-lineage-card compact" : "catalog-lineage-card"}>
      {!compact && (
        <div className="catalog-lineage-title">
          <div className="lineage-title-icon"><LayoutGrid size={22} /></div>
          <div>
            <h2>{dataset.name}</h2>
            <span>리니지</span>
          </div>
        </div>
      )}
      {lineageGraph ? (
        <div className="catalog-lineage-flow" ref={flowWrapperRef} aria-label={`${dataset.name} lineage graph`}>
          <ReactFlow
            edges={edges}
            fitView
            fitViewOptions={lineageFitViewOptions}
            maxZoom={1.2}
            minZoom={0.35}
            nodes={nodes}
            nodesDraggable={false}
            nodesConnectable={false}
            nodeTypes={lineageNodeTypes}
            onInit={setFlowInstance}
            onPaneClick={() => setSelectedColumnKey(null)}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#d5dde8" gap={22} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      ) : (
        <div className="catalog-lineage-empty">
          <strong>리니지를 불러오지 못했습니다.</strong>
          <span>백엔드 응답 또는 예시 데이터를 확인해 주세요.</span>
        </div>
      )}
      <div className="catalog-lineage-footer">
        <span>상위 데이터셋 <strong>{Math.max((lineageGraph?.datasets.length ?? 1) - 1, 0)}개</strong></span>
        <span>레이어 <strong>{dataset.layer}</strong></span>
        <span>상태 <strong>{statusMeta.label}</strong></span>
      </div>
    </section>
  );
}

function buildLineageGraph(
  graph: LineageGraph,
  selectedColumnKey: string | null,
  onColumnSelect: (columnKey: string | null) => void,
): { edges: Edge[]; nodes: FlowNode[] } {
  const graphDatasets = graph.datasets;
  const depthByDatasetId = getLineageDepths(graph);
  const groupedDatasets = groupLineageDatasets(graphDatasets, depthByDatasetId);
  const maxGroupHeight = Math.max(...groupedDatasets.map((group) => getLineageStackHeight(group.length, getMaxColumnCount(group))), 0);
  const nodeIdsWithIncoming = new Set(graph.edges.map((edge) => edge.toDatasetId));
  const nodeIdsWithOutgoing = new Set(graph.edges.map((edge) => edge.fromDatasetId));
  const selection = selectedColumnKey ? getLineageSelection(graph, selectedColumnKey) : null;
  const nodes: FlowNode<LineageTableNodeData>[] = groupedDatasets.flatMap((group, groupIndex) => {
    const groupColumnCount = getMaxColumnCount(group);
    const groupHeight = getLineageStackHeight(group.length, groupColumnCount);
    const groupStartY = (maxGroupHeight - groupHeight) / 2;
    return group.map((lineageDataset, itemIndex) => {
      const columns = buildLineageColumns(lineageDataset.columns);
      const hasIncoming = nodeIdsWithIncoming.has(lineageDataset.id);
      const hasOutgoing = nodeIdsWithOutgoing.has(lineageDataset.id);
      const isRelated = !selection || selection.nodeIds.has(lineageDataset.id);
      const relatedColumnKeys = selection?.columnKeysByNodeId.get(lineageDataset.id) ?? null;
      return {
        data: {
          activeColumnKey: selectedColumnKey,
          columns,
          dimmed: !isRelated,
          engine: lineageDataset.engine,
          handleMode: getLineageHandleMode(hasIncoming, hasOutgoing),
          highlighted: Boolean(selection && isRelated),
          layerLabel: getLineageLayerLabel(lineageDataset.layer),
          nodeId: lineageDataset.id,
          onColumnSelect,
          relatedColumnKeys: relatedColumnKeys ? Array.from(relatedColumnKeys) : null,
          tableName: lineageDataset.name,
          tone: getLayerTone(lineageDataset.layer),
        },
        id: lineageDataset.id,
        position: {
          x: groupIndex * 315 + 20,
          y: groupStartY + getLineageStackOffset(itemIndex, groupColumnCount),
        },
        type: "lineageTable",
      };
    });
  });
  const edges = graph.edges
    .filter((edge) => graphDatasets.some((dataset) => dataset.id === edge.fromDatasetId) && graphDatasets.some((dataset) => dataset.id === edge.toDatasetId))
    .map((edge) => {
      const sourceColumn = findLineageColumn(graphDatasets, edge.fromDatasetId, edge.fromColumnId);
      const targetColumn = findLineageColumn(graphDatasets, edge.toDatasetId, edge.toColumnId);
      return buildColumnEdge({
        active: !selection || selection.edgeIds.has(lineageEdgeId(edge)),
        selected: selectedColumnKey !== null,
        id: `${edge.fromDatasetId}-${edge.fromColumnId}-to-${edge.toDatasetId}-${edge.toColumnId}`,
        source: edge.fromDatasetId,
        sourceHandle: lineageHandleId(edge.fromDatasetId, sourceColumn?.name ?? edge.fromColumnId, "source"),
        target: edge.toDatasetId,
        targetHandle: lineageHandleId(edge.toDatasetId, targetColumn?.name ?? edge.toColumnId, "target"),
      });
    });

  return {
    edges,
    nodes,
  };
}

function getLineageStackHeight(nodeCount: number, columnCount: number): number {
  if (nodeCount === 0) return 0;
  return nodeCount * getLineageTableHeight(columnCount) + (nodeCount - 1) * lineageGroupGap;
}

function getLineageStackOffset(index: number, columnCount: number): number {
  return index * (getLineageTableHeight(columnCount) + lineageGroupGap);
}

function getLineageTableHeight(columnCount: number): number {
  return lineageNodeHeaderHeight + columnCount * lineageColumnRowHeight + 16;
}

function LineageTableNode({ data }: { data: LineageTableNodeData }) {
  const updateNodeInternals = useUpdateNodeInternals();

  useEffect(() => {
    updateNodeInternals(data.nodeId);
  }, [data.nodeId, updateNodeInternals]);

  return (
    <article className={[
      "lineage-schema-node",
      data.tone,
      data.dimmed ? "dimmed" : "",
      data.highlighted ? "highlighted" : "",
    ].filter(Boolean).join(" ")}>
      <header className="lineage-schema-header">
        <div className="lineage-schema-icon">
          <Table2 size={18} />
        </div>
        <div className="lineage-schema-title">
          <strong title={data.tableName}>{data.tableName}</strong>
          <span>{data.layerLabel} · {data.engine}</span>
        </div>
      </header>
      <div className="lineage-column-head">
        <span>컬럼</span>
        <span>타입</span>
      </div>
      <div className="lineage-schema-columns">
        {data.columns.map((column) => (
          <LineageColumnRow column={column} data={data} key={column.id} />
        ))}
      </div>
    </article>
  );
}

function LineageColumnRow({ column, data }: { column: LineageColumn; data: LineageTableNodeData }) {
  const columnKey = lineageColumnKey(data.nodeId, column.id);
  const isActive = data.activeColumnKey === columnKey;
  const isRelated = !data.relatedColumnKeys || data.relatedColumnKeys.includes(columnKey);

  return (
    <button
      className={[
        "lineage-column-row",
        isActive ? "active" : "",
        data.relatedColumnKeys && !isRelated ? "dimmed" : "",
        data.relatedColumnKeys && isRelated ? "related" : "",
      ].filter(Boolean).join(" ")}
      onClick={(event) => {
        event.stopPropagation();
        data.onColumnSelect(isActive ? null : columnKey);
      }}
      type="button"
    >
      {(data.handleMode === "target" || data.handleMode === "both") && (
        <Handle
          className="lineage-column-handle left target-handle"
          id={lineageHandleId(data.nodeId, column.name, "target")}
          position={Position.Left}
          type="target"
        />
      )}
      <span>{column.name}</span>
      <b className={`lineage-type-pill ${getColumnTypeTone(column.type)}`}>{column.type}</b>
      {(data.handleMode === "source" || data.handleMode === "both") && (
        <Handle
          className="lineage-column-handle right source-handle"
          id={lineageHandleId(data.nodeId, column.name, "source")}
          position={Position.Right}
          type="source"
        />
      )}
    </button>
  );
}

function buildColumnEdge({
  active,
  id,
  selected,
  source,
  sourceHandle,
  target,
  targetHandle,
}: {
  active: boolean;
  id: string;
  selected: boolean;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}): Edge {
  return {
    animated: false,
    className: selected ? active ? "lineage-column-edge active" : "lineage-column-edge muted" : "lineage-column-edge",
    id,
    markerEnd: { color: "#fb923c", type: MarkerType.ArrowClosed },
    source,
    sourceHandle,
    style: {
      stroke: "#fb923c",
      strokeDasharray: "6 5",
      strokeWidth: selected && active ? 2.4 : 1.5,
    },
    target,
    targetHandle,
    type: "smoothstep",
  };
}

function buildLineageColumns(columns: LineageGraphDataset["columns"]): LineageColumn[] {
  return columns.slice(0, 7).map((column) => ({
    baseId: column.id,
    id: column.id,
    name: column.name,
    type: column.type,
  }));
}

function findLineageColumn(datasets: LineageGraphDataset[], datasetId: string, columnId: string) {
  return datasets.find((dataset) => dataset.id === datasetId)?.columns.find((column) => column.id === columnId);
}

function getLineageSelection(graph: LineageGraph, selectedColumnKey: string) {
  const edgeIds = new Set<string>();
  const nodeIds = new Set<string>();
  const columnKeys = new Set<string>([selectedColumnKey]);
  const columnKeysByNodeId = new Map<string, Set<string>>();
  const adjacency = new Map<string, Array<{ edgeId: string; key: string }>>();

  const registerColumnKey = (key: string) => {
    const [nodeId] = key.split("::");
    if (!nodeId) return;
    nodeIds.add(nodeId);
    if (!columnKeysByNodeId.has(nodeId)) columnKeysByNodeId.set(nodeId, new Set());
    columnKeysByNodeId.get(nodeId)?.add(key);
  };
  const addAdjacency = (from: string, to: string, edgeId: string) => {
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from)?.push({ edgeId, key: to });
  };

  graph.edges.forEach((edge) => {
    const edgeId = lineageEdgeId(edge);
    const sourceKey = lineageColumnKey(edge.fromDatasetId, edge.fromColumnId);
    const targetKey = lineageColumnKey(edge.toDatasetId, edge.toColumnId);
    addAdjacency(sourceKey, targetKey, edgeId);
    addAdjacency(targetKey, sourceKey, edgeId);
  });

  const queue = [selectedColumnKey];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    columnKeys.add(current);
    registerColumnKey(current);

    (adjacency.get(current) ?? []).forEach(({ edgeId, key }) => {
      edgeIds.add(edgeId);
      if (!visited.has(key)) queue.push(key);
    });
  }

  return { columnKeys, columnKeysByNodeId, edgeIds, nodeIds };
}

function getLineageDepths(graph: LineageGraph): Map<string, number> {
  const depths = new Map(graph.datasets.map((dataset) => [dataset.id, 0]));
  for (let pass = 0; pass < graph.datasets.length; pass += 1) {
    let changed = false;
    graph.edges.forEach((edge) => {
      const sourceDepth = depths.get(edge.fromDatasetId) ?? 0;
      const targetDepth = depths.get(edge.toDatasetId) ?? 0;
      if (sourceDepth + 1 > targetDepth) {
        depths.set(edge.toDatasetId, sourceDepth + 1);
        changed = true;
      }
    });
    if (!changed) break;
  }
  return depths;
}

function groupLineageDatasets(datasets: LineageGraphDataset[], depthByDatasetId: Map<string, number>): LineageGraphDataset[][] {
  const groups = new Map<number, LineageGraphDataset[]>();
  datasets.forEach((dataset) => {
    const depth = depthByDatasetId.get(dataset.id) ?? 0;
    groups.set(depth, [...(groups.get(depth) ?? []), dataset]);
  });
  return Array.from(groups.entries())
    .sort(([leftDepth], [rightDepth]) => leftDepth - rightDepth)
    .map(([, group]) => group);
}

function getMaxColumnCount(datasets: LineageGraphDataset[]): number {
  return Math.max(...datasets.map((dataset) => dataset.columns.length), 1);
}

function getLineageHandleMode(hasIncoming: boolean, hasOutgoing: boolean): LineageTableNodeData["handleMode"] {
  if (hasIncoming && hasOutgoing) return "both";
  if (hasIncoming) return "target";
  return "source";
}

function getLineageLayerLabel(layer: LineageLayer): string {
  if (layer === "SOURCE") return "SOURCE";
  if (layer === "CONSUMER") return "CONSUMER";
  return `${layer} LAYER`;
}

function getLayerTone(layer: LineageLayer): LineageTableNodeData["tone"] {
  if (layer === "GOLD") return "gold";
  if (layer === "SILVER") return "silver";
  if (layer === "BRONZE") return "bronze";
  if (layer === "CONSUMER") return "downstream";
  return "source";
}

function getColumnTypeTone(type: string): string {
  const normalized = type.toLowerCase();
  if (["int", "integer", "bigint"].includes(normalized)) return "integer";
  if (["decimal", "double", "float", "number"].includes(normalized)) return "double";
  if (["timestamp", "date", "datetime"].includes(normalized)) return "timestamp";
  if (normalized.includes("json")) return "json";
  return "string";
}

function lineageHandleId(datasetId: string, columnName: string, kind: "source" | "target"): string {
  return `${kind}-col:${datasetId}:${columnName}`;
}

function lineageColumnKey(datasetId: string, columnId: string): string {
  return `${datasetId}::${columnId}`;
}

function lineageEdgeId(edge: LineageGraph["edges"][number]): string {
  return `${edge.fromDatasetId}::${edge.fromColumnId}->${edge.toDatasetId}::${edge.toColumnId}`;
}

function CatalogLineageMini({ dataset }: { dataset: CatalogDataset }) {
  return (
    <div className="catalog-lineage-mini">
      <div>{dataset.upstream.map((item) => <span key={item}>{item}</span>)}</div>
      <strong>{dataset.name}</strong>
      <div>{dataset.downstream.slice(0, 2).map((item) => <span key={item}>{item}</span>)}</div>
    </div>
  );
}
