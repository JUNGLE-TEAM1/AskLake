

import { catalogDatasets } from "../../data/mockData";
import { apiConfig } from "../../services/apiClient";

import { normalizeDatasetStatus } from "../../utils/statusMeta";

import type { CatalogDataset, ResourcePermissions } from "../../types";

export const catalogDatasetStorageKey = "asklake.catalogDatasets";

export const legacyDerivedDatasetStorageKey = "asklake.derivedDatasets";

export const maxStoredCatalogDatasets = 30;

const mockCatalogDatasetPermissions = {
  canDelete: true,
  canManage: true,
  canQuery: true,
  canRun: true,
  canShare: true,
  canView: true,
  computedFor: "mock-admin",
  enforced: false,
} satisfies ResourcePermissions;

export const emptySelectedDataset: CatalogDataset = {
  description: "생성된 데이터셋이 없습니다. 수집/처리에서 파이프라인을 먼저 생성하고 실행하세요.",
  downstream: [],
  freshness: "approval",
  id: "dataset_not_selected",
  layer: "RAW",
  lastUpdated: "-",
  name: "데이터셋 없음",
  nextRefresh: "-",
  owner: "-",
  quality: "-",
  rag: false,
  rows: "0행",
  sampleRows: [],
  schema: [],
  size: "-",
  source: "-",
  status: "approval_required",
  tags: [],
  upstream: [],
};

export function isCatalogDataset(value: unknown): value is CatalogDataset {
  if (!value || typeof value !== "object") return false;
  const dataset = value as Partial<CatalogDataset>;
  return typeof dataset.id === "string"
    && typeof dataset.name === "string"
    && Array.isArray(dataset.schema)
    && Array.isArray(dataset.sampleRows)
    && Array.isArray(dataset.tags);
}

export function parseStoredCatalogDatasets(storageKey: string) {
  if (typeof window === "undefined") return [];

  try {
    const stored = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]");
    return Array.isArray(stored) ? stored.filter(isCatalogDataset).map(normalizeDatasetRow) : [];
  } catch {
    return [];
  }
}

export function loadStoredCatalogDatasets() {
  if (!apiConfig.useMock || typeof window === "undefined") return [];

  return mergeStoredCatalogDatasets([
    ...parseStoredCatalogDatasets(catalogDatasetStorageKey),
    ...parseStoredCatalogDatasets(legacyDerivedDatasetStorageKey),
  ]);
}

export function mergeStoredCatalogDatasets(datasets: CatalogDataset[]) {
  return datasets.filter((dataset, index, items) => (
    items.findIndex((item) => item.id === dataset.id) === index
  ));
}

export function mergeCatalogDatasets(baseDatasets: CatalogDataset[], storedDatasets: CatalogDataset[]) {
  const uniqueStoredDatasets = mergeStoredCatalogDatasets(storedDatasets);
  const storedDatasetIds = new Set(uniqueStoredDatasets.map((dataset) => dataset.id));
  const baseDatasetById = new Map(baseDatasets.map((dataset) => [dataset.id, dataset]));
  const mergedStoredDatasets = uniqueStoredDatasets.map((storedDataset) => {
    const baseDataset = baseDatasetById.get(storedDataset.id);
    if (!baseDataset) return storedDataset;

    const materializationRuns = new Map([
      ...(baseDataset.materializationRuns ?? []),
      ...(storedDataset.materializationRuns ?? []),
    ].map((run) => [run.runId, run]));

    return {
      ...baseDataset,
      ...storedDataset,
      materializationRuns: Array.from(materializationRuns.values()),
    };
  });

  return [
    ...mergedStoredDatasets,
    ...baseDatasets.filter((dataset) => !storedDatasetIds.has(dataset.id)),
  ].map(normalizeDatasetRow);
}

export function saveStoredCatalogDataset(dataset: CatalogDataset) {
  if (!apiConfig.useMock || typeof window === "undefined") return;

  const previousDatasets = loadStoredCatalogDatasets();
  const nextDatasets = [dataset, ...previousDatasets.filter((item) => item.id !== dataset.id)]
    .slice(0, maxStoredCatalogDatasets);
  const nextLegacyDatasets = parseStoredCatalogDatasets(legacyDerivedDatasetStorageKey)
    .filter((item) => item.id !== dataset.id);

  window.localStorage.setItem(catalogDatasetStorageKey, JSON.stringify(nextDatasets));
  window.localStorage.setItem(legacyDerivedDatasetStorageKey, JSON.stringify(nextLegacyDatasets));
}

export function getInitialDatasets() {
  return apiConfig.useMock ? mergeCatalogDatasets(catalogDatasets, loadStoredCatalogDatasets()) : [];
}

export function normalizeDatasetRow(dataset: CatalogDataset): CatalogDataset {
  return {
    ...dataset,
    materializationRuns: dataset.materializationRuns ?? [],
    permissions: apiConfig.useMock ? dataset.permissions ?? { ...mockCatalogDatasetPermissions } : dataset.permissions,
    status: normalizeDatasetStatus(String(dataset.status)),
  };
}

export function formatStorageSize(sizeBytes: number) {
  if (sizeBytes < 1024) return `${sizeBytes}B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = sizeBytes;
  for (const unit of units) {
    size /= 1024;
    if (size < 1024) return `${size.toFixed(1)}${unit}`;
  }
  return `${size.toFixed(1)}PB`;
}

export function recalculateDatasetFromMaterializationRuns(dataset: CatalogDataset): CatalogDataset {
  const materializationRuns = dataset.materializationRuns ?? [];
  const activeRuns = activeDatasetMaterializationRuns(materializationRuns);
  const latestRun = activeRuns[0];
  const rowCount = activeRuns.reduce((total, run) => total + Math.max(run.rowCount || 0, 0), 0);
  const storageSizeBytes = activeRuns.reduce((total, run) => total + Math.max(run.storageSizeBytes || 0, 0), 0);

  return normalizeDatasetRow({
    ...dataset,
    lastUpdated: latestRun?.createdAt ?? dataset.lastUpdated,
    rows: `${rowCount.toLocaleString()} rows`,
    size: storageSizeBytes > 0 ? formatStorageSize(storageSizeBytes) : "0B",
    sourceRunId: latestRun?.runId,
    storageSizeBytes,
  });
}

export function activeDatasetMaterializationRuns(runs: NonNullable<CatalogDataset["materializationRuns"]>) {
  const activeRuns = [];
  for (const run of runs) {
    if (run.status !== "success") continue;
    activeRuns.push(run);
    if (run.materializationMode !== "delta") break;
  }
  return activeRuns;
}
