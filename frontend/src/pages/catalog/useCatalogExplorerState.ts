import { useCallback, useEffect, useMemo, useState } from "react";

import { getCatalogDataset } from "../../services/catalogApi";
import type { AuditResult, CatalogDataset } from "../../types";
import { canQueryDatasetAs } from "../../utils/permissions";
import {
  type CatalogFilterState,
  type CatalogSortMode,
  type CatalogStatusFilter,
  catalogPageSize,
  catalogSearchDebounceMs,
  compareCatalogDatasetsBySort,
  datasetMatchesFilters,
  datasetMatchesSearch,
  getCatalogTagsByFrequency,
  parseCatalogSearchQuery,
} from "./catalogModel";

type CatalogPreviewModal = "lineage" | "schema";

interface CatalogExplorerStateOptions {
  datasets: CatalogDataset[];
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onOpenSql: (dataset: CatalogDataset) => void;
  selectedDataset: CatalogDataset;
}

export function useCatalogExplorerState({
  datasets,
  onAction,
  onOpenSql,
  selectedDataset,
}: CatalogExplorerStateOptions) {
  const [previewDataset, setPreviewDataset] = useState<CatalogDataset>(selectedDataset);
  const [activeModal, setActiveModal] = useState<CatalogPreviewModal | null>(null);
  const [filterState, setFilterState] = useState<CatalogFilterState>({ approvalRequired: false, available: false, rag: false });
  const [currentPage, setCurrentPage] = useState(1);
  const [mobilePreviewOpen, setMobilePreviewOpen] = useState(false);
  const [pinnedDatasetIds, setPinnedDatasetIds] = useState<string[]>([]);
  const [previewDetailError, setPreviewDetailError] = useState<string | null>(null);
  const [previewDetailLoading, setPreviewDetailLoading] = useState(false);
  const [selectedSqlDatasetId, setSelectedSqlDatasetId] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [debouncedSearchText, setDebouncedSearchText] = useState("");
  const [sortMode, setSortMode] = useState<CatalogSortMode>("default");
  const tags = useMemo(() => getCatalogTagsByFrequency(datasets), [datasets]);
  const searchQuery = useMemo(() => parseCatalogSearchQuery(debouncedSearchText, tags), [debouncedSearchText, tags]);
  const canQueryCurrentDataset = useCallback(
    (dataset: CatalogDataset | null | undefined) => canQueryDatasetAs(dataset, undefined),
    [],
  );
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
    let cancelled = false;
    const datasetId = previewDataset.id;
    setPreviewDetailError(null);
    setPreviewDetailLoading(true);

    getCatalogDataset(datasetId)
      .then((dataset) => {
        if (cancelled) return;
        setPreviewDataset((currentDataset) => currentDataset.id === datasetId ? dataset : currentDataset);
      })
      .catch((detailError) => {
        if (cancelled) return;
        setPreviewDetailError(detailError instanceof Error ? detailError.message : "데이터셋 상세 정보를 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!cancelled) setPreviewDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [previewDataset.id]);

  useEffect(() => {
    if (!hasCatalogResults || paginatedDatasets.length === 0) return;

    const selectedInResults = paginatedDatasets.find((dataset) => dataset.id === selectedDataset.id);
    const previewInResults = paginatedDatasets.find((dataset) => dataset.id === previewDataset.id);
    const nextPreview = previewDataset.id === selectedDataset.id
      ? selectedInResults ?? previewInResults ?? paginatedDatasets[0]
      : previewInResults ?? selectedInResults ?? paginatedDatasets[0];

    if (nextPreview.id !== previewDataset.id) setPreviewDataset(nextPreview);
  }, [hasCatalogResults, paginatedDatasets, previewDataset, selectedDataset.id]);

  const handleSearchSubmit = useCallback(() => {
    const query = searchText.trim();
    setDebouncedSearchText(searchText);
    onAction("catalog.search.submitted", `/api/catalog/datasets?q=${encodeURIComponent(query)}`, query || "empty");
  }, [onAction, searchText]);

  const activeStatusFilter: CatalogStatusFilter = filterState.available
    ? "available"
    : filterState.approvalRequired
      ? "approvalRequired"
      : filterState.rag
        ? "rag"
        : "all";

  const updateStatusFilter = useCallback((nextStatus: CatalogStatusFilter) => {
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
  }, [onAction]);

  const updateSortMode = useCallback((nextSortMode: CatalogSortMode) => {
    setSortMode(nextSortMode);
    onAction("catalog.sort_changed", `/api/catalog/search/sort?sort=${nextSortMode}`, nextSortMode);
  }, [onAction]);

  const updateResultPage = useCallback((nextPage: number) => {
    const normalizedPage = Math.min(Math.max(nextPage, 1), totalCatalogPages);
    setCurrentPage(normalizedPage);
    onAction("catalog.page_changed", `/api/catalog/datasets?page=${normalizedPage}&pageSize=${catalogPageSize}`, String(normalizedPage));
  }, [onAction, totalCatalogPages]);

  const togglePinnedDataset = useCallback(() => {
    const nextPinned = !isPreviewPinned;
    setPinnedDatasetIds((ids) => nextPinned
      ? [previewDataset.id, ...ids.filter((id) => id !== previewDataset.id)]
      : ids.filter((id) => id !== previewDataset.id));
    onAction(nextPinned ? "catalog.dataset.pinned" : "catalog.dataset.unpinned", `/api/catalog/datasets/${previewDataset.id}/pin`, previewDataset.id);
  }, [isPreviewPinned, onAction, previewDataset.id]);

  const selectPreviewDataset = useCallback((dataset: CatalogDataset) => {
    setPreviewDataset(dataset);
    setSelectedSqlDatasetId(dataset.id);
    onAction("catalog.dataset.preview_selected", `/api/catalog/datasets/${dataset.id}`, dataset.id);
  }, [onAction]);

  const openSelectedSqlDataset = useCallback(() => {
    if (selectedSqlDatasetId !== previewDataset.id || !canQueryCurrentDataset(previewDataset)) return;
    onOpenSql(previewDataset);
  }, [canQueryCurrentDataset, onOpenSql, previewDataset, selectedSqlDatasetId]);

  const openPreviewModal = useCallback((variant: CatalogPreviewModal, fromMobileSheet = false) => {
    if (fromMobileSheet) setMobilePreviewOpen(false);
    onAction(
      variant === "schema" ? "catalog.schema.modal_opened" : "catalog.lineage.opened",
      `/api/catalog/datasets/${previewDataset.id}/${variant}`,
      previewDataset.id,
    );
    setActiveModal(variant);
  }, [onAction, previewDataset.id]);

  return {
    activeModal,
    activeStatusFilter,
    canQueryCurrentDataset,
    currentCatalogPage,
    currentPageEndIndex,
    currentPageStartIndex,
    filteredDatasets,
    handleSearchSubmit,
    hasCatalogResults,
    isPreviewPinned,
    mobilePreviewOpen,
    openPreviewModal,
    openSelectedSqlDataset,
    paginatedDatasets,
    pinnedDatasetIds,
    previewDataset,
    previewDetailError,
    previewDetailLoading,
    searchText,
    selectPreviewDataset,
    selectedSqlDatasetId,
    setActiveModal,
    setMobilePreviewOpen,
    setSearchText,
    sortMode,
    togglePinnedDataset,
    totalCatalogPages,
    updateResultPage,
    updateSortMode,
    updateStatusFilter,
  };
}
