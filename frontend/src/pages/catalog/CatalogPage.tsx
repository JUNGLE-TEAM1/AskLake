import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import {
  type ColumnDef,
} from "@tanstack/react-table";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, useUpdateNodeInternals } from "@xyflow/react";
import type { Edge, Node as FlowNode } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AlertCircle,
  ArrowUpDown,
  ExternalLink,
  Filter,
  LayoutGrid,
  PanelRight,
  Pin,
  Star,
  Search,
  Share2,
  Table2,
  TerminalSquare,
  X,
} from "lucide-react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { DataTable, type DataTableColumnMeta } from "@/components/ui/data-table";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Empty, EmptyDescription, EmptyHeader, EmptyIcon, EmptyTitle } from "@/components/ui/empty";
import {
  FilterToolbar,
  FilterToolbarActions,
  FilterToolbarInput,
  FilterToolbarSearch,
} from "@/components/ui/filter-toolbar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PageHeader } from "@/components/ui/page-header";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TagList } from "@/components/ui/tag-list";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { IconButton } from "@/components/ui/icon-button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { getCatalogDatasetRows } from "../../services/catalogApi";
import { getDatasetLineageGraph } from "../../services/mockApi";
import type { AuditResult, CatalogDataset, CatalogDatasetRowsResponse, CurrentUserResponse, DatasetMaterializationRun, LineageGraph, LineageGraphDataset, LineageLayer } from "../../types";
import { canDeleteDatasetMaterializationRun, canQueryDatasetAs, datasetQueryBlockedMessage, permissionDeniedMessage } from "../../utils/permissions";
import { datasetStatusMeta } from "../../utils/statusMeta";
import { cn } from "@/lib/utils";

type LineageColumn = {
  baseId: string;
  id: string;
  name: string;
  type: string;
};

type LineageTableNodeData = Record<string, unknown> & {
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

const lineageNodeTypes = {
  lineageTable: LineageTableNode,
};
const lineageFitViewOptions = { maxZoom: 1.08, padding: 0.08 };

type CatalogFilterState = {
  approvalRequired: boolean;
  available: boolean;
  rag: boolean;
};
type CatalogStatusFilter = "all" | keyof CatalogFilterState;

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
const catalogStatusFilterOptions: Array<{ label: string; value: CatalogStatusFilter }> = [
  { label: "전체", value: "all" },
  { label: "사용 가능", value: "available" },
  { label: "승인 필요", value: "approvalRequired" },
  { label: "RAG 여부", value: "rag" },
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

function formatCatalogModelExecution(executionMode?: string, fallbackUsed?: boolean) {
  if (fallbackUsed || executionMode === "fallback_rule") return "규칙 Fallback";
  if (executionMode === "selected_model") return "선택 모델";
  if (executionMode === "auto_model") return "자동 모델";
  if (executionMode === "missing_model") return "모델 없음";
  return executionMode || "처리 정보 없음";
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
  currentUser,
  datasets,
  error = null,
  loading = false,
  onAction,
  onOpenSql,
  selectedDataset,
}: {
  currentUser?: CurrentUserResponse | null;
  datasets: CatalogDataset[];
  error?: string | null;
  loading?: boolean;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onOpenSql: (dataset: CatalogDataset) => void;
  selectedDataset: CatalogDataset;
}) {
  const [previewDataset, setPreviewDataset] = useState<CatalogDataset>(selectedDataset);
  const [activeModal, setActiveModal] = useState<"lineage" | "schema" | null>(null);
  const [filterState, setFilterState] = useState<CatalogFilterState>({ approvalRequired: false, available: false, rag: false });
  const [currentPage, setCurrentPage] = useState(1);
  const [mobilePreviewOpen, setMobilePreviewOpen] = useState(false);
  const [pinnedDatasetIds, setPinnedDatasetIds] = useState<string[]>([]);
  const [selectedSqlDatasetId, setSelectedSqlDatasetId] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [debouncedSearchText, setDebouncedSearchText] = useState("");
  const [sortMode, setSortMode] = useState<CatalogSortMode>("default");
  const tags = useMemo(() => getCatalogTagsByFrequency(datasets), [datasets]);
  const searchQuery = useMemo(() => parseCatalogSearchQuery(debouncedSearchText, tags), [debouncedSearchText, tags]);
  const canQueryCurrentDataset = (dataset: CatalogDataset | null | undefined) => canQueryDatasetAs(dataset, currentUser);
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

  const activeStatusFilter: CatalogStatusFilter = filterState.available
    ? "available"
    : filterState.approvalRequired
      ? "approvalRequired"
      : filterState.rag
        ? "rag"
        : "all";

  const updateStatusFilter = (nextStatus: CatalogStatusFilter) => {
    setFilterState({
      approvalRequired: nextStatus === "approvalRequired",
      available: nextStatus === "available",
      rag: nextStatus === "rag",
    });
    onAction(
      "catalog.filter_changed",
      `/api/catalog/datasets?filter=${nextStatus}&enabled=${nextStatus !== "all"}`,
      nextStatus,
    );
  };

  const updateSortMode = (nextSortMode: CatalogSortMode) => {
    setSortMode(nextSortMode);
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
    setSelectedSqlDatasetId(dataset.id);
    onAction("catalog.dataset.preview_selected", `/api/catalog/datasets/${dataset.id}`, dataset.id);
  };

  const openSelectedSqlDataset = () => {
    if (selectedSqlDatasetId !== previewDataset.id || !canQueryCurrentDataset(previewDataset)) return;
    onOpenSql(previewDataset);
  };

  const openPreviewModal = (variant: "lineage" | "schema", fromMobileSheet = false) => {
    if (fromMobileSheet) setMobilePreviewOpen(false);
    onAction(
      variant === "schema" ? "catalog.schema.modal_opened" : "catalog.lineage.opened",
      `/api/catalog/datasets/${previewDataset.id}/${variant}`,
      previewDataset.id,
    );
    setActiveModal(variant);
  };

  const renderPreviewContent = (fromMobileSheet = false) => (
    <>
      <PanelHeader
        actions={(
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={isPreviewPinned ? "데이터셋 고정 해제" : "데이터셋 상단 고정"}
                aria-pressed={isPreviewPinned}
                shape="compact"
                type="button"
                size="iconSm"
                variant={isPreviewPinned ? "subtle" : "ghost"}
                onClick={togglePinnedDataset}
              >
                <Star fill={isPreviewPinned ? "currentColor" : "none"} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{isPreviewPinned ? "상단 고정 해제" : "상단에 고정"}</TooltipContent>
          </Tooltip>
        )}
        bordered={false}
        className="catalog-preview-title"
        icon={<LayoutGrid size={16} />}
        iconVariant="success"
        title={(
          <Tooltip>
            <TooltipTrigger asChild><span className="block min-w-0 truncate">{previewDataset.name}</span></TooltipTrigger>
            <TooltipContent>{previewDataset.name}</TooltipContent>
          </Tooltip>
        )}
      />
      <Separator />
      <ScrollArea className="catalog-preview-scroll" type="auto">
        <div className="catalog-preview-body">
          <Accordion className="catalog-preview-accordion" type="multiple">
            <AccordionItem value="overview">
              <AccordionTrigger>
                <span className="catalog-preview-accordion-label"><LayoutGrid /> 기본 정보</span>
              </AccordionTrigger>
              <AccordionContent>
                <div className="catalog-overview-metrics catalog-preview-metrics">
                  <CatalogMiniMetric label="품질 지표" value={previewDataset.quality} />
                  <CatalogMiniMetric label="최근 갱신 일시" value={previewDataset.lastUpdated} />
                  <CatalogMiniMetric label="데이터 담당자" value={previewDataset.owner} />
                  <CatalogMiniMetric label="행 수" value={previewDataset.rows} />
                  <CatalogMiniMetric label="파일 크기" value={previewDataset.size} />
                  <CatalogMiniMetric label="갱신 예정 일시" value={previewDataset.nextRefresh} />
                </div>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="schema">
              <AccordionTrigger>
                <span className="catalog-preview-accordion-label"><TerminalSquare /> 스키마 미리보기</span>
              </AccordionTrigger>
              <AccordionContent className="catalog-preview-accordion-content">
                <CatalogSchemaTable dataset={previewDataset} maxRows={5} variant="preview" />
                <Button className="catalog-text-button" type="button" onClick={() => openPreviewModal("schema", fromMobileSheet)} size="sm" variant="link">전체 스키마 상세 보기</Button>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="lineage">
              <AccordionTrigger>
                <span className="catalog-preview-accordion-label"><Share2 /> 리니지</span>
              </AccordionTrigger>
              <AccordionContent>
                <Button className="catalog-wide-button" shape="compact" size="sm" type="button" variant="outline" onClick={() => openPreviewModal("lineage", fromMobileSheet)}>
                  <Share2 data-icon="inline-start" /> 전체 리니지 보기
                </Button>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
          <Button
            className="catalog-wide-button"
            disabled={selectedSqlDatasetId !== previewDataset.id || !canQueryCurrentDataset(previewDataset)}
            shape="compact"
            size="sm"
            title={!canQueryCurrentDataset(previewDataset)
              ? permissionDeniedMessage("데이터셋", "SQL 실행")
              : selectedSqlDatasetId === previewDataset.id
                ? "선택한 데이터셋을 SQL 분석에서 엽니다."
                : "왼쪽 목록에서 데이터셋을 선택해 주세요."}
            type="button"
            variant="outline"
            onClick={openSelectedSqlDataset}
          >
            <ExternalLink data-icon="inline-start" /> SQL 분석에서 열기
          </Button>
          <TagList align="center" className="catalog-preview-tags" density="compact">
            {previewDataset.tags.map((tag) => (
              <Badge key={tag} shape="compact" size="sm" variant="secondary">{tag}</Badge>
            ))}
          </TagList>
        </div>
      </ScrollArea>
    </>
  );

  return (
    <TooltipProvider delayDuration={300}>
    <div className="catalog-page">
      <PageHeader
        className="catalog-page-header"
        icon={<Search size={18} />}
        title="검색/카탈로그"
      />
      {error ? (
        <Alert className="border-red-200 bg-red-50 text-red-800" variant="destructive">
          <AlertCircle />
          <AlertTitle>카탈로그를 불러오지 못했습니다.</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="catalog-content-grid">
        <div className="catalog-main">
          {hasCatalogResults && (
            <Sheet open={mobilePreviewOpen} onOpenChange={setMobilePreviewOpen}>
              <SheetTrigger asChild>
                <Button className="catalog-preview-mobile-trigger" shape="compact" type="button" variant="outline">
                  <PanelRight data-icon="inline-start" /> 데이터셋 미리보기
                </Button>
              </SheetTrigger>
              <SheetContent className="catalog-preview-sheet" closeLabel="미리보기 닫기" side="right">
                <SheetHeader className="sr-only">
                  <SheetTitle>{previewDataset.name} 미리보기</SheetTitle>
                  <SheetDescription>데이터셋 정보와 빠른 작업</SheetDescription>
                </SheetHeader>
                {renderPreviewContent(true)}
              </SheetContent>
            </Sheet>
          )}

          <Panel className="catalog-results-section">
            <div className="catalog-results-header">
              <PanelHeader
                bordered={false}
                icon={<LayoutGrid size={16} />}
                title="검색 결과"
              />
              <FilterToolbar className="py-3" layout="actions">
                <FilterToolbarSearch icon={<Search size={18} />}>
                  <FilterToolbarInput
                    aria-label="카탈로그 검색"
                    onChange={(event) => setSearchText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        handleSearchSubmit();
                      }
                    }}
                    placeholder="테이블명, 컬럼명 또는 업무 키워드로 검색하세요..."
                    type="search"
                    value={searchText}
                  />
                </FilterToolbarSearch>
                <FilterToolbarActions>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        aria-label="상태 필터"
                        className="h-9 justify-start gap-1.5 px-0 text-lg font-semibold text-slate-600 hover:bg-transparent hover:text-slate-950"
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        상태
                        <Filter className="size-[18px]" aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="min-w-44">
                      <DropdownMenuLabel>상태 필터</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuRadioGroup value={activeStatusFilter} onValueChange={(value) => updateStatusFilter(value as CatalogStatusFilter)}>
                        {catalogStatusFilterOptions.map((option) => (
                          <DropdownMenuRadioItem key={option.value} value={option.value}>
                            {option.label}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <DropdownMenu onOpenChange={(open) => open && onAction("catalog.sort_opened", "/api/catalog/search/sort", "catalog-sort")}>
                    <DropdownMenuTrigger asChild>
                      <Button
                        aria-label="정렬 기준"
                        className="h-9 justify-start gap-1.5 px-0 text-lg font-semibold text-slate-600 hover:bg-transparent hover:text-slate-950"
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        정렬
                        <ArrowUpDown className="size-[18px]" aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-44">
                      <DropdownMenuLabel>정렬 기준</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuRadioGroup value={sortMode} onValueChange={(value) => updateSortMode(value as CatalogSortMode)}>
                        {catalogSortOptions.map((option) => (
                          <DropdownMenuRadioItem key={option.mode} value={option.mode}>{option.label}</DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </FilterToolbarActions>
              </FilterToolbar>
            </div>

            <div className="catalog-result-list">
                {loading ? Array.from({ length: 3 }, (_, index) => (
                  <Card className="catalog-result-card flex items-center gap-3 p-4" key={`catalog-skeleton-${index}`} size="none">
                    <Skeleton className="h-5 w-2/5" />
                    <Skeleton className="ml-auto size-8" />
                  </Card>
                )) : paginatedDatasets.map((dataset) => {
                const isPinned = pinnedDatasetIds.includes(dataset.id);
                const isActive = dataset.id === previewDataset.id;
                return (
                  <div className="catalog-result-item" key={`${dataset.id}:${dataset.name}`}>
                    <Card className={cn("catalog-result-card", isActive && "active", isPinned && "pinned")} size="none">
                      <Button
                        aria-pressed={isActive}
                        className="catalog-result-select"
                        shape="compact"
                        size="content"
                        type="button"
                        variant="ghost"
                        onClick={() => selectPreviewDataset(dataset)}
                        title="데이터셋 선택"
                      >
                        <div className="catalog-result-summary">
                          <div className="catalog-result-title">
                            <Tooltip>
                              <TooltipTrigger asChild><strong className="truncate" title={undefined}>{dataset.name}</strong></TooltipTrigger>
                              <TooltipContent>{dataset.name}</TooltipContent>
                            </Tooltip>
                            <DatasetStatusBadge dataset={dataset} shape="compact" />
                            {isPinned && (
                              <Badge className="catalog-result-pin-badge" aria-label="상단 고정된 데이터셋" shape="compact" size="sm">
                                <Pin />
                                고정됨
                              </Badge>
                            )}
                          </div>
                        </div>
                      </Button>
                    </Card>
                  </div>
                );
                })}
                {!loading && !hasCatalogResults && (
                  <Empty className="catalog-empty-state" size="sm" variant="bordered">
                    <EmptyIcon><Search /></EmptyIcon>
                    <EmptyHeader>
                      <EmptyTitle>검색 결과가 없습니다.</EmptyTitle>
                      <EmptyDescription>검색어, 태그, 상태 필터를 조정해 다시 확인하세요.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
            </div>

            {!loading && hasCatalogResults && (
              <PaginationBar
                aria-label="검색 결과 페이지"
                className="catalog-pagination"
                currentPage={currentCatalogPage}
                onNext={() => updateResultPage(currentCatalogPage + 1)}
                onPrevious={() => updateResultPage(currentCatalogPage - 1)}
                rangeLabel={`${currentPageStartIndex + 1}-${currentPageEndIndex} / ${filteredDatasets.length}`}
                totalPages={totalCatalogPages}
              />
            )}
          </Panel>
        </div>

        {hasCatalogResults ? (
          <Card className="catalog-preview-panel catalog-preview-desktop" size="none">
            {renderPreviewContent()}
          </Card>
        ) : (
          <Empty className="catalog-preview-panel catalog-preview-panel-empty" size="lg" variant="bordered">
            <EmptyIcon><LayoutGrid /></EmptyIcon>
            <EmptyHeader>
              <EmptyTitle>선택할 데이터셋이 없습니다.</EmptyTitle>
              <EmptyDescription>검색 조건을 바꾸면 일치하는 데이터셋의 스키마, 리니지, SQL 이동 정보를 다시 확인할 수 있습니다.</EmptyDescription>
            </EmptyHeader>
          </Empty>
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
    </TooltipProvider>
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
    <DialogShell
      aria-label={`${dataset.name} ${title}`}
      bodyClassName="catalog-modal-body"
      bodyScrollArea={variant === "schema"}
      closeLabel="닫기"
      contentClassName={`catalog-modal ${variant === "lineage" ? "lineage-modal" : ""}`}
      headerActions={<IconButton label="닫기" size="xs" type="button" variant="ghost" onClick={onClose}><X /></IconButton>}
      headerClassName="catalog-modal-header"
      onClose={onClose}
      showCloseButton={false}
      size={variant === "lineage" ? "wide" : "xl"}
      title={dataset.name}
    >
      {children}
    </DialogShell>
  );
}

export function CatalogDetailPage({
  currentUser,
  dataset,
  onAction,
  onBack,
  onLineage,
  onOpenSql,
}: {
  currentUser?: CurrentUserResponse | null;
  dataset: CatalogDataset;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onBack: () => void;
  onLineage: () => void;
  onOpenSql: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"overview" | "schema" | "sample" | "lineage">("overview");
  const canQueryCurrentDataset = canQueryDatasetAs(dataset, currentUser);

  const openLineage = () => {
    setActiveTab("lineage");
    onLineage();
  };

  const updateActiveTab = (nextTab: string) => {
    const normalizedTab = nextTab as typeof activeTab;
    if (normalizedTab === "lineage") onLineage();
    setActiveTab(normalizedTab);
  };

  return (
    <Tabs className="catalog-detail-page" value={activeTab} onValueChange={updateActiveTab}>
      <header className="catalog-detail-header">
        <Button className="job-detail-breadcrumb" type="button" onClick={onBack} size="sm" variant="link">검색/카탈로그 &gt; {dataset.name}</Button>
        <div className="catalog-detail-title-row">
          <div>
            <h1>{dataset.name}</h1>
            <div className="job-detail-meta">
              <DatasetStatusBadge dataset={dataset} />
              <Badge shape="compact" size="sm" variant="outline">{dataset.owner}</Badge>
              <Badge shape="compact" size="sm" variant="secondary">{dataset.layer} 레이어</Badge>
              {dataset.tags.map((tag) => <Badge key={tag} shape="compact" size="sm" variant="secondary">{tag}</Badge>)}
            </div>
          </div>
          <div className="job-detail-actions">
            <Button className="job-action-button primary" disabled={!canQueryCurrentDataset} title={canQueryCurrentDataset ? "SQL 분석에서 엽니다." : datasetQueryBlockedMessage(dataset)} type="button" onClick={onOpenSql} size="sm" variant="primary"><ExternalLink size={14} /> SQL 분석에서 열기</Button>
            <Button className="job-action-button" type="button" onClick={openLineage} size="sm" variant="outline">리니지 보기</Button>
            <Button className="job-action-button" type="button" onClick={() => onAction("catalog.dataset.refreshed", `/api/catalog/datasets/${dataset.id}`, dataset.id)} size="sm" variant="outline">새로고침</Button>
          </div>
        </div>
        <TabsList aria-label="데이터셋 상세 탭" className="catalog-detail-tabs">
          <TabsTrigger value="overview">개요</TabsTrigger>
          <TabsTrigger value="schema">스키마</TabsTrigger>
          <TabsTrigger value="sample">샘플 데이터</TabsTrigger>
          <TabsTrigger value="lineage">리니지</TabsTrigger>
        </TabsList>
      </header>

      <TabsContent className="catalog-detail-tab-content" value="overview"><CatalogOverview dataset={dataset} onLineage={openLineage} /></TabsContent>
      <TabsContent className="catalog-detail-tab-content" value="schema"><CatalogSchema dataset={dataset} /></TabsContent>
      <TabsContent className="catalog-detail-tab-content" value="sample"><CatalogSample dataset={dataset} /></TabsContent>
      <TabsContent className="catalog-detail-tab-content" value="lineage"><CatalogLineage dataset={dataset} /></TabsContent>
    </Tabs>
  );
}

export function DatasetStatusBadge({ dataset, shape = "default" }: { dataset: CatalogDataset; shape?: BadgeProps["shape"] }) {
  const statusMeta = datasetStatusMeta[dataset.status];
  const statusTone = dataset.status === "available" ? "success" : dataset.status === "approval_required" ? "warning" : "outline";

  return (
    <>
      {dataset.rag && <Badge shape={shape} size="sm">RAG</Badge>}
      <StatusBadge shape={shape} size="sm" tone={statusTone}>{statusMeta.label}</StatusBadge>
    </>
  );
}

function CatalogMiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <Card className="catalog-mini-metric" size="sm" variant="muted">
      <span>{label}</span>
      <strong>{value}</strong>
    </Card>
  );
}

function CatalogMaterializationRuns({
  canQueryDatasetForCurrentUser,
  dataset,
  onDelete,
  onPageChange,
  onSelectRun,
  page,
  selectedRunId,
}: {
  canQueryDatasetForCurrentUser: (dataset: CatalogDataset | null | undefined) => boolean;
  dataset: CatalogDataset;
  onDelete: (event: React.MouseEvent, dataset: CatalogDataset, runId: string) => void;
  onPageChange: (dataset: CatalogDataset, nextPage: number) => void;
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
    <div className="catalog-materialization-panel grid gap-3" onClick={(event) => event.stopPropagation()}>
      <p className="m-0 text-xs font-semibold leading-5 text-slate-500">
        SQL 분석에 사용할 데이터 저장 시점을 선택합니다.
      </p>
      {visibleRuns.length > 0 ? (
        <div className="grid gap-2">
          {visibleRuns.map((run) => {
            const isSelectable = run.status === "success" && canQueryDatasetForCurrentUser(dataset);
            const isSelected = run.runId === selectedRunId;
            const statusTone = run.status === "success" ? "success" : run.status === "failed" ? "danger" : run.status === "running" ? "default" : "muted";
            const textStructuringChecks = run.textStructuringExecution?.columns ?? run.textStructuring ?? [];
            const modelProvenance = textStructuringChecks.map((check) => {
              const targetColumn = check.targetColumn || check.target || check.output || "컬럼";
              const modelArtifact = check.selectedModelArtifact || check.modelArtifact;
              const execution = modelArtifact
                ? `${formatCatalogModelExecution(check.executionMode, check.fallbackUsed)} · ${modelArtifact}`
                : formatCatalogModelExecution(check.executionMode || check.runtimeStatus, check.fallbackUsed);
              return `${targetColumn}: ${execution}`;
            }).join(", ");
            const quarantineRows = Number(run.quarantine?.rows ?? 0);

            return (
            <Card
              aria-disabled={!isSelectable}
              aria-pressed={isSelected}
              className={cn(
                "grid gap-2 p-3 transition-colors",
                isSelectable ? "cursor-pointer hover:border-blue-300 hover:bg-blue-50/40" : "opacity-70",
                isSelected && "border-blue-500 bg-blue-50 ring-1 ring-blue-200",
              )}
              key={run.runId}
              role="button"
              size="none"
              tabIndex={isSelectable ? 0 : -1}
              title={isSelectable ? "SQL 분석 대상으로 선택" : !canQueryDatasetForCurrentUser(dataset) ? datasetQueryBlockedMessage(dataset) : "성공한 데이터 버전만 SQL 분석 대상으로 선택할 수 있습니다."}
              onClick={(event) => onSelectRun(event, dataset, run)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectRun(event, dataset, run);
                }
              }}
            >
              <div className="flex min-w-0 items-center gap-2">
                <StatusBadge shape="compact" size="sm" tone={statusTone}>{materializationRunStatusLabel(run.status)}</StatusBadge>
                <strong className="min-w-0 truncate" title={run.runId}>{run.runId}</strong>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      aria-label={`${run.runId} 데이터 버전 삭제`}
                      className="ml-auto"
                      disabled={!canDeleteDatasetMaterializationRun(dataset)}
                      shape="compact"
                      size="sm"
                      title={canDeleteDatasetMaterializationRun(dataset) ? "데이터 버전을 삭제합니다." : permissionDeniedMessage("데이터셋", "데이터 버전 삭제")}
                      type="button"
                      variant="ghost"
                      onClick={(event) => event.stopPropagation()}
                    >
                      삭제
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent onClick={(event) => event.stopPropagation()}>
                    <AlertDialogHeader>
                      <AlertDialogTitle>데이터 버전을 삭제하시겠습니까?</AlertDialogTitle>
                      <AlertDialogDescription>{run.runId} 버전은 삭제 후 복구할 수 없습니다.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>취소</AlertDialogCancel>
                      <AlertDialogAction onClick={(event) => onDelete(event, dataset, run.runId)}>삭제</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
              <div className="grid gap-1 text-xs text-slate-600 sm:grid-cols-2">
                <span>{formatRunCreatedAt(run.createdAt)}</span>
                <span>{run.rowCount.toLocaleString()}행 · {formatRunStorageSize(run.storageSizeBytes)}</span>
                <span className="truncate sm:col-span-2" title={run.sourceLabel}>{run.sourceLabel}</span>
                {modelProvenance ? (
                  <span className="truncate font-semibold text-blue-700 sm:col-span-2" title={modelProvenance}>
                    모델 기반 변환 · {modelProvenance}
                  </span>
                ) : null}
                {quarantineRows > 0 ? (
                  <span className="truncate font-semibold text-amber-700 sm:col-span-2" title={run.quarantine?.path || undefined}>
                    검증 격리 · {quarantineRows.toLocaleString()}행
                  </span>
                ) : null}
              </div>
            </Card>
            );
          })}
        </div>
      ) : (
        <Empty size="sm" variant="bordered">
          <EmptyHeader>
            <EmptyTitle>데이터 버전이 없습니다.</EmptyTitle>
            <EmptyDescription>데이터셋 생성 또는 append가 완료되면 여기에서 SQL 분석 대상을 선택할 수 있습니다.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {runs.length > materializationRunPageSize && (
        <PaginationBar
          currentPage={currentPage}
          onNext={() => onPageChange(dataset, currentPage + 1)}
          onPrevious={() => onPageChange(dataset, currentPage - 1)}
          rangeLabel={`${pageStartIndex + 1}-${Math.min(pageStartIndex + visibleRuns.length, runs.length)} / ${runs.length}`}
          totalPages={totalPages}
        />
      )}
    </div>
  );
}

function CatalogOverview({ dataset, onLineage }: { dataset: CatalogDataset; onLineage: () => void }) {
  return (
    <div className="catalog-detail-grid catalog-detail-grid-single">
      <Panel asChild className="catalog-overview-card">
        <section>
          <h2>리니지</h2>
          <CatalogLineageMini dataset={dataset} />
          <Button className="catalog-text-button" type="button" onClick={onLineage} size="sm" variant="link">전체 리니지 보기</Button>
        </section>
      </Panel>
    </div>
  );
}

function CatalogSchema({ dataset }: { dataset: CatalogDataset }) {
  return (
    <Panel asChild className="catalog-table-card">
      <section>
        <div className="catalog-section-header">
          <h2>스키마</h2>
        </div>
        <CatalogSchemaTable dataset={dataset} />
      </section>
    </Panel>
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
          cell: (info) => <Badge shape="compact" size="sm" variant="muted">{info.getValue<string>()}</Badge>,
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
  const pageSize = 100;
  const [offset, setOffset] = useState(0);
  const [rowsResult, setRowsResult] = useState<CatalogDatasetRowsResponse | null>(null);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [isLoadingRows, setIsLoadingRows] = useState(false);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const [horizontalScrollPercent, setHorizontalScrollPercent] = useState(0);
  const fallbackColumns = dataset.schema.slice(0, 8).map(([name]) => name);
  const columns = rowsResult?.columns.length ? rowsResult.columns : fallbackColumns;
  const rows = rowsResult?.rows ?? dataset.sampleRows.slice(0, pageSize);
  const totalRows = rowsResult?.rowCount ?? rows.length;

  useEffect(() => {
    let cancelled = false;
    setIsLoadingRows(true);
    setRowsError(null);
    getCatalogDatasetRows(dataset.id, { limit: pageSize, offset })
      .then((result) => {
        if (!cancelled) setRowsResult(result);
      })
      .catch((error) => {
        if (cancelled) return;
        setRowsError(error instanceof Error ? error.message : "데이터셋 행을 불러오지 못했습니다.");
        setRowsResult(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingRows(false);
      });

    return () => {
      cancelled = true;
    };
  }, [dataset.id, offset]);

  useEffect(() => {
    setOffset(0);
    setHorizontalScrollPercent(0);
  }, [dataset.id]);

  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;

    const updateScrollState = () => {
      const nextMax = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      setHorizontalScrollPercent(nextMax > 0 ? (viewport.scrollLeft / nextMax) * 100 : 0);
    };
    const resizeObserver = new ResizeObserver(updateScrollState);

    resizeObserver.observe(viewport);
    if (viewport.firstElementChild) resizeObserver.observe(viewport.firstElementChild);
    updateScrollState();

    return () => resizeObserver.disconnect();
  }, [dataset.id, rowsResult]);

  const updateHorizontalScroll = ([nextPercent]: number[]) => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;

    const nextMax = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    viewport.scrollLeft = (nextPercent / 100) * nextMax;
    setHorizontalScrollPercent(nextPercent);
  };

  const nextOffset = offset + pageSize;
  const previousOffset = Math.max(0, offset - pageSize);
  const hasNext = rowsResult?.hasNext ?? false;
  const startLabel = totalRows === 0 ? 0 : offset + 1;
  const endLabel = Math.min(offset + rows.length, totalRows);
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const currentPage = Math.floor(offset / pageSize) + 1;

  return (
    <Panel asChild className="catalog-table-card">
      <section>
        <div className="catalog-section-header">
          <h2>샘플 데이터</h2>
          <span>{isLoadingRows ? "불러오는 중..." : `${startLabel}-${endLabel} / ${totalRows.toLocaleString()}행`}</span>
        </div>
        {rowsError ? (
          <Alert className="m-4" variant="destructive">
            <AlertCircle />
            <AlertTitle>실제 데이터를 불러오지 못했습니다.</AlertTitle>
            <AlertDescription>{rowsError} 저장된 미리보기 데이터를 표시합니다.</AlertDescription>
          </Alert>
        ) : null}
        <Slider
          aria-label="샘플 데이터 가로 이동"
          className="catalog-sample-slider"
          max={100}
          min={0}
          step={1}
          value={[horizontalScrollPercent]}
          onValueChange={updateHorizontalScroll}
        />
        <ScrollArea
          className="catalog-sample-scroll"
          scrollbars="none"
          viewportProps={{
            onScroll: (event) => {
              const viewport = event.currentTarget;
              const nextMax = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
              setHorizontalScrollPercent(nextMax > 0 ? (viewport.scrollLeft / nextMax) * 100 : 0);
            },
          }}
          viewportRef={scrollViewportRef}
        >
          <Table className="catalog-sample-table">
            <TableHeader>
              <TableRow>{columns.map((column, index) => <TableHead key={`${column}-${index}`}>{column}</TableHead>)}</TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, rowIndex) => (
                <TableRow key={`dataset-row-${offset + rowIndex}`}>
                  {columns.map((_, cellIndex) => <TableCell key={`${offset + rowIndex}-${cellIndex}`}>{row[cellIndex] ?? ""}</TableCell>)}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
        <PaginationBar
          className="catalog-pagination"
          currentPage={currentPage}
          nextDisabled={!hasNext || isLoadingRows}
          onNext={() => setOffset(nextOffset)}
          onPrevious={() => setOffset(previousOffset)}
          previousDisabled={offset === 0 || isLoadingRows}
          rangeLabel={`${startLabel}-${endLabel} / ${totalRows.toLocaleString()}`}
          totalPages={totalPages}
        />
      </section>
    </Panel>
  );
}

function CatalogLineage({ compact = false, dataset }: { compact?: boolean; dataset: CatalogDataset }) {
  const [lineageGraph, setLineageGraph] = useState<LineageGraph | null>(dataset.lineageGraph ?? null);
  const [selectedColumnKey, setSelectedColumnKey] = useState<string | null>(null);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);
  const { edges, nodes } = lineageGraph
    ? buildLineageGraph(lineageGraph, selectedColumnKey, selectedDatasetId, setSelectedColumnKey)
    : { edges: [], nodes: [] };
  const selectedLineageDataset = lineageGraph?.datasets.find((item) => item.id === selectedDatasetId) ?? null;

  useEffect(() => {
    let isActive = true;
    setLineageGraph(dataset.lineageGraph ?? null);
    setSelectedColumnKey(null);
    setSelectedDatasetId(null);
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

  return (
    <>
      <Panel asChild className={compact ? "catalog-lineage-card compact" : "catalog-lineage-card"}>
        <section>
          {!compact && (
            <PanelHeader
              bordered={false}
              className="catalog-lineage-title min-h-0 p-0"
              description="리니지"
              icon={<LayoutGrid size={18} />}
              title={dataset.name}
            />
          )}
          {lineageGraph ? (
            <div className="catalog-lineage-flow" aria-label={`${dataset.name} 리니지 그래프`}>
              <ReactFlow
                edges={edges}
                fitView
                fitViewOptions={lineageFitViewOptions}
                maxZoom={1.4}
                minZoom={0.25}
                nodes={nodes}
                nodesConnectable={false}
                nodesDraggable={false}
                nodeTypes={lineageNodeTypes}
                onNodeClick={(_, node) => setSelectedDatasetId(node.id)}
                onPaneClick={() => {
                  setSelectedColumnKey(null);
                  setSelectedDatasetId(null);
                }}
                proOptions={{ hideAttribution: true }}
              >
                <Background color="#d5dde8" gap={22} />
                <Controls position="bottom-left" showInteractive={false} />
              </ReactFlow>
            </div>
          ) : (
            <div className="catalog-lineage-empty">
              <strong>리니지를 불러오지 못했습니다.</strong>
              <span>백엔드 응답 또는 예시 데이터를 확인해 주세요.</span>
            </div>
          )}
        </section>
      </Panel>

      <Sheet open={selectedLineageDataset !== null} onOpenChange={(open) => !open && setSelectedDatasetId(null)}>
        {lineageGraph && selectedLineageDataset ? (
          <SheetContent className="flex h-full flex-col gap-0 p-0" closeLabel="리니지 상세 닫기" side="right">
            <SheetHeader className="gap-3 p-6 pr-16">
              <Badge className="w-fit" shape="compact" variant={getLineageLayerBadgeVariant(selectedLineageDataset.layer)}>
                {getLineageLayerLabel(selectedLineageDataset.layer)}
              </Badge>
              <SheetTitle className="break-words">{selectedLineageDataset.name}</SheetTitle>
              <SheetDescription>{selectedLineageDataset.engine} 데이터셋의 컬럼과 연결 정보를 확인합니다.</SheetDescription>
            </SheetHeader>
            <Separator />
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col gap-6 p-6">
                <section className="flex flex-col gap-3">
                  <h3 className="text-sm font-semibold text-slate-950">연결 정보</h3>
                  <div className="flex flex-wrap gap-2">
                    <Badge shape="compact" variant="outline">상위 {countLineageConnections(lineageGraph, selectedLineageDataset.id, "upstream")}개</Badge>
                    <Badge shape="compact" variant="outline">하위 {countLineageConnections(lineageGraph, selectedLineageDataset.id, "downstream")}개</Badge>
                    <Badge shape="compact" variant="outline">컬럼 {selectedLineageDataset.columns.length}개</Badge>
                  </div>
                </section>
                <Separator />
                <section className="flex flex-col gap-3">
                  <h3 className="text-sm font-semibold text-slate-950">컬럼</h3>
                  <Card className="overflow-hidden" size="none" variant="muted">
                    <CardContent className="divide-y divide-slate-200 p-0 pt-0">
                      {selectedLineageDataset.columns.map((column) => (
                        <div className="flex min-w-0 items-center justify-between gap-3 px-4 py-3" key={column.id}>
                          <span className="min-w-0 truncate text-sm font-medium text-slate-900" title={column.name}>{column.name}</span>
                          <Badge shape="compact" size="sm" variant={getColumnTypeBadgeVariant(column.type)}>{column.type}</Badge>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                </section>
              </div>
            </ScrollArea>
          </SheetContent>
        ) : null}
      </Sheet>
    </>
  );
}

function buildLineageGraph(
  graph: LineageGraph,
  selectedColumnKey: string | null,
  selectedDatasetId: string | null,
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
          dataset: lineageDataset,
          dimmed: !isRelated,
          handleMode: getLineageHandleMode(hasIncoming, hasOutgoing),
          highlighted: Boolean(selection && isRelated),
          nodeId: lineageDataset.id,
          onColumnSelect,
          relatedColumnKeys: relatedColumnKeys ? Array.from(relatedColumnKeys) : null,
          selected: selectedDatasetId === lineageDataset.id,
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
  const layerVariant = getLineageLayerBadgeVariant(data.dataset.layer);
  const displayName = getLineageNodeDisplayName(data.dataset);

  useEffect(() => {
    updateNodeInternals(data.nodeId);
  }, [data.nodeId, updateNodeInternals]);

  return (
    <Card
      className={cn(
        "w-60 overflow-visible p-0 transition-[border-color,box-shadow,opacity]",
        data.dimmed && "opacity-35",
        data.highlighted && "border-orange-400 shadow-md",
        data.selected && "border-blue-500 ring-2 ring-blue-100",
      )}
      size="none"
    >
      <CardHeader className="flex min-h-16 flex-row items-center gap-3 border-b border-slate-200 p-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-md border border-blue-100 bg-blue-50 text-blue-600">
          <Table2 className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <CardTitle className="break-words text-sm leading-5" title={displayName}>{displayName}</CardTitle>
          <CardDescription className="mt-1 flex flex-wrap items-center gap-1 text-xs leading-4">
            <Badge shape="compact" size="sm" variant={layerVariant}>{data.dataset.layer}</Badge>
            <span>{data.dataset.engine}</span>
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="p-0 pt-0">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-b border-slate-200 bg-slate-50 px-4 py-1.5 text-[10px] font-semibold text-slate-500">
        <span>컬럼</span>
        <span className="text-right">타입</span>
      </div>
      <div>
        {data.columns.map((column) => (
          <LineageColumnRow column={column} data={data} key={column.id} />
        ))}
      </div>
      </CardContent>
    </Card>
  );
}

function getLineageNodeDisplayName(dataset: LineageGraphDataset): string {
  if (dataset.layer !== "SOURCE") return dataset.name;

  const enginePrefix = new RegExp(`^${escapeRegExp(dataset.engine)}\\s+`, "i");
  return dataset.name.replace(enginePrefix, "").trim() || dataset.name;
}

function LineageColumnRow({ column, data }: { column: LineageColumn; data: LineageTableNodeData }) {
  const columnKey = lineageColumnKey(data.nodeId, column.id);
  const isActive = data.activeColumnKey === columnKey;
  const isRelated = !data.relatedColumnKeys || data.relatedColumnKeys.includes(columnKey);

  return (
    <Button
      className={cn(
        "nodrag relative grid min-h-8 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-none border-b border-slate-100 px-4 text-left text-xs last:border-b-0",
        isActive && "bg-orange-100 ring-1 ring-inset ring-orange-300 hover:bg-orange-100",
        data.relatedColumnKeys && !isRelated && "opacity-30",
        data.relatedColumnKeys && isRelated && !isActive && "bg-orange-50 hover:bg-orange-50",
      )}
      onClick={(event) => {
        event.stopPropagation();
        data.onColumnSelect(isActive ? null : columnKey);
      }}
      shape="compact"
      size="content"
      type="button"
      variant="ghost"
    >
      {(data.handleMode === "target" || data.handleMode === "both") && (
        <Handle
          className="!size-3 !border-2 !border-white !bg-blue-500"
          id={lineageHandleId(data.nodeId, column.name, "target")}
          position={Position.Left}
          type="target"
        />
      )}
      <span className="min-w-0 truncate" title={column.name}>{column.name}</span>
      <Badge className="justify-self-end" shape="compact" size="sm" variant={getColumnTypeBadgeVariant(column.type)}>{column.type}</Badge>
      {(data.handleMode === "source" || data.handleMode === "both") && (
        <Handle
          className="!size-3 !border-2 !border-white !bg-blue-500"
          id={lineageHandleId(data.nodeId, column.name, "source")}
          position={Position.Right}
          type="source"
        />
      )}
    </Button>
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
  const strokeColor = selected && active ? "#2563eb" : "#64748b";

  return {
    animated: false,
    id,
    markerEnd: { color: strokeColor, height: 16, type: MarkerType.ArrowClosed, width: 16 },
    source,
    sourceHandle,
    style: {
      opacity: selected && !active ? 0.28 : 1,
      stroke: strokeColor,
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

function getLineageLayerBadgeVariant(layer: LineageLayer): BadgeProps["variant"] {
  if (layer === "GOLD" || layer === "SILVER") return "default";
  if (layer === "BRONZE" || layer === "SOURCE") return "warning";
  return "success";
}

function getColumnTypeBadgeVariant(type: string): BadgeProps["variant"] {
  const normalized = type.toLowerCase();
  if (["int", "integer", "bigint", "decimal", "double", "float", "number"].includes(normalized)) return "default";
  if (["timestamp", "date", "datetime"].includes(normalized)) return "warning";
  if (normalized.includes("json")) return "secondary";
  return "success";
}

function countLineageConnections(graph: LineageGraph, datasetId: string, direction: "upstream" | "downstream"): number {
  const connectedDatasetIds = new Set(
    graph.edges
      .filter((edge) => direction === "upstream" ? edge.toDatasetId === datasetId : edge.fromDatasetId === datasetId)
      .map((edge) => direction === "upstream" ? edge.fromDatasetId : edge.toDatasetId),
  );
  return connectedDatasetIds.size;
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
