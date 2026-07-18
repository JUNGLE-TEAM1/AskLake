import type { CatalogDataset } from "../../types";
import { ApiError } from "../../types/audit.ts";

export type ContinuousSqlUniqueKeyIssue = { columns: string[]; datasetId: string };

export function getContinuousSqlUniqueKeyIssue(error: unknown): ContinuousSqlUniqueKeyIssue | null {
  if (!(error instanceof ApiError) || error.code !== "CONTINUOUS_SQL_STATIC_KEY_NOT_UNIQUE") return null;
  const datasetId = typeof error.details?.datasetId === "string" ? error.details.datasetId : "";
  const rawColumns = error.details?.joinColumns ?? error.details?.columns;
  const columns = Array.isArray(rawColumns)
    ? rawColumns.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
  return datasetId && columns.length ? { columns, datasetId } : null;
}

export type ContinuousSqlRelationMix = {
  staticDatasets: CatalogDataset[];
  streamingDataset: CatalogDataset;
};

export function isStreamingCatalogDataset(dataset: CatalogDataset) {
  const hasContinuousKafkaRun = (dataset.materializationRuns ?? []).some((run) => (
    run.sourceKind === "kafka" && run.materializationMode === "delta"
  ));
  if (hasContinuousKafkaRun) return true;

  const evidence = [
    dataset.source,
    dataset.description,
    dataset.nextRefresh,
    ...dataset.tags,
    ...dataset.upstream,
  ].join(" ");
  return /(?:kafka|stream(?:ing)?|continuous|real[- ]?time|실시간|스트림)/i.test(evidence);
}

export function getContinuousSqlRelationMix(datasets: CatalogDataset[]): ContinuousSqlRelationMix | null {
  const streamingDatasets = datasets.filter(isStreamingCatalogDataset);
  const staticDatasets = datasets.filter((dataset) => !isStreamingCatalogDataset(dataset));
  if (streamingDatasets.length !== 1 || staticDatasets.length < 1) return null;
  return { staticDatasets, streamingDataset: streamingDatasets[0] };
}

export function buildContinuousSqlOutputName(streamingDataset: CatalogDataset) {
  return `${streamingDataset.name}_live_join`;
}

export function buildClickHouseOutputIdentity() {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  return {
    datasetId: `continuous-${timestamp}-${random}`,
    table: `live_join_${timestamp}_${random}`,
  };
}
