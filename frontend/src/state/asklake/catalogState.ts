

import { normalizeDatasetStatus } from "../../utils/statusMeta";

import type { CatalogDataset } from "../../types";

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

export function getInitialDatasets(): CatalogDataset[] {
  return [];
}

export function normalizeDatasetRow(dataset: CatalogDataset): CatalogDataset {
  return {
    ...dataset,
    materializationRuns: dataset.materializationRuns ?? [],
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
