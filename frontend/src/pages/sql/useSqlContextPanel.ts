import { useEffect, useMemo, useRef, useState } from "react";

import type { CatalogDataset } from "../../types";
import type { SqlContextPanelTab } from "./SqlDatasetContextPanel";

type SqlContextPanelOptions = {
  baseDatasetId: string | null;
  datasets: CatalogDataset[];
  onAction: (action: string, apiPath: string, targetId: string) => void;
  selectedDatasetIds: ReadonlySet<string>;
  selectedDatasetCount: number;
};

function isSqlCandidateDataset(dataset: CatalogDataset) {
  const normalizedName = dataset.name.toLowerCase();
  const normalizedTags = dataset.tags.map((tag) => tag.toLowerCase());
  return !normalizedName.includes("legacy") && !normalizedTags.includes("#legacy");
}

export function useSqlContextPanel({
  baseDatasetId,
  datasets,
  onAction,
  selectedDatasetCount,
  selectedDatasetIds,
}: SqlContextPanelOptions) {
  const [collapsed, setCollapsed] = useState(false);
  const [tab, setTab] = useState<SqlContextPanelTab>("tables");
  const [datasetSearch, setDatasetSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => Math.max(1, datasets.length));
  const [expandedDatasetId, setExpandedDatasetId] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const paginationRef = useRef<HTMLDivElement | null>(null);

  const candidateDatasets = useMemo(
    () => datasets.filter(isSqlCandidateDataset),
    [datasets],
  );
  const filteredDatasets = useMemo(() => {
    const keyword = datasetSearch.trim().toLowerCase();
    if (!keyword) return candidateDatasets;

    return candidateDatasets.filter((dataset) => [
      dataset.name,
      dataset.description,
      dataset.source,
      dataset.owner,
      dataset.layer,
      ...dataset.tags,
      ...dataset.schema.map(([name, type]) => `${name} ${type}`),
    ].join(" ").toLowerCase().includes(keyword));
  }, [candidateDatasets, datasetSearch]);
  const totalPages = Math.max(1, Math.ceil(filteredDatasets.length / pageSize));
  const currentPage = Math.min(Math.max(page, 1), totalPages);
  const pageStartIndex = (currentPage - 1) * pageSize;
  const pageDatasets = useMemo(
    () => filteredDatasets.slice(pageStartIndex, pageStartIndex + pageSize),
    [filteredDatasets, pageSize, pageStartIndex],
  );
  const rangeLabel = `${pageStartIndex + 1}-${pageStartIndex + pageDatasets.length} / ${filteredDatasets.length}`;

  useEffect(() => {
    setPage(1);
  }, [baseDatasetId, datasetSearch, selectedDatasetIds]);

  useEffect(() => {
    if (page !== currentPage) setPage(currentPage);
  }, [currentPage, page]);

  useEffect(() => {
    if (collapsed || tab !== "tables") return;
    let frameId = 0;

    const updatePageSize = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        const panel = panelRef.current;
        const list = listRef.current;
        if (!panel || !list) return;

        const firstRow = list.querySelector<HTMLElement>("[data-sql-dataset-row]");
        const rowHeight = Math.max(1, firstRow?.getBoundingClientRect().height ?? 56);
        const panelStyle = window.getComputedStyle(panel);
        const panelBottomPadding = Number.parseFloat(panelStyle.paddingBottom) || 0;
        const panelBottom = panel.getBoundingClientRect().bottom - panelBottomPadding;
        const availableHeight = Math.max(rowHeight, panelBottom - list.getBoundingClientRect().top);
        const rowsWithoutPagination = Math.max(1, Math.floor(availableHeight / rowHeight));
        const paginationHeight = paginationRef.current?.getBoundingClientRect().height ?? 38;
        const listStyle = window.getComputedStyle(list.parentElement ?? list);
        const resultGap = Number.parseFloat(listStyle.rowGap || listStyle.gap) || 0;
        const rowsWithPagination = Math.max(
          1,
          Math.floor((availableHeight - paginationHeight - resultGap) / rowHeight),
        );
        const nextPageSize = filteredDatasets.length > rowsWithoutPagination
          ? rowsWithPagination
          : rowsWithoutPagination;

        setPageSize((current) => current === nextPageSize ? current : nextPageSize);
      });
    };

    updatePageSize();
    const resizeObserver = new ResizeObserver(updatePageSize);
    if (panelRef.current) resizeObserver.observe(panelRef.current);
    window.addEventListener("resize", updatePageSize);

    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      window.removeEventListener("resize", updatePageSize);
    };
  }, [collapsed, datasetSearch, expandedDatasetId, filteredDatasets.length, selectedDatasetCount, tab]);

  const toggleCollapsed = () => {
    const nextCollapsed = !collapsed;
    setCollapsed(nextCollapsed);
    onAction(
      nextCollapsed ? "analysis.context.collapsed" : "analysis.context.expanded",
      "/api/query/context",
      baseDatasetId ?? "sql-empty",
    );
  };

  const toggleDatasetPreview = (dataset: CatalogDataset) => {
    setExpandedDatasetId((current) => current === dataset.id ? null : dataset.id);
    onAction(
      "analysis.context.dataset_schema_previewed",
      `/api/query/context/datasets/${dataset.id}/schema-preview`,
      dataset.id,
    );
  };

  return {
    candidateDatasets,
    collapsed,
    currentPage,
    datasetSearch,
    expandedDatasetId,
    filteredDatasetCount: filteredDatasets.length,
    listRef,
    nextPage: () => setPage((current) => Math.min(totalPages, current + 1)),
    pageDatasets,
    pageSize,
    paginationRef,
    panelRef,
    previousPage: () => setPage((current) => Math.max(1, current - 1)),
    rangeLabel,
    setDatasetSearch,
    setExpandedDatasetId,
    setTab,
    tab,
    toggleCollapsed,
    toggleDatasetPreview,
    totalPages,
  };
}
