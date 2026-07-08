import { useEffect, useMemo, useState } from "react";
import type { CatalogDataset } from "../../../types";
import { getDatasets } from "../../../services/mockApi";
import type { DashboardDatasetColumn, DashboardDatasetOption } from "./dashboardRuntimeTypes";

function dashboardColumnType(type: string): DashboardDatasetColumn["type"] {
  const normalized = type.trim().toLowerCase();
  if (["date", "time", "timestamp"].some((hint) => normalized.includes(hint))) return "date";
  if (["bigint", "decimal", "double", "float", "int", "long", "number", "numeric", "real"].some((hint) => normalized.includes(hint))) return "number";
  return "string";
}

function sampleRowsToRecords(dataset: CatalogDataset) {
  return dataset.sampleRows.map((row) => Object.fromEntries(
    dataset.schema.map(([name], index) => [name, row[index] ?? null]),
  ));
}

function catalogDatasetToDashboardOption(dataset: CatalogDataset): DashboardDatasetOption {
  return {
    columns: dataset.schema.map(([name, type]) => ({
      name,
      type: dashboardColumnType(type),
    })),
    description: dataset.description,
    id: dataset.id,
    layer: dataset.layer,
    name: dataset.name,
    rows: sampleRowsToRecords(dataset),
    status: dataset.status,
    updatedAt: dataset.lastUpdated,
  };
}

function isUsableDashboardDataset(dataset: CatalogDataset) {
  return dataset.status === "available" && dataset.schema.length > 0;
}

function mergeDashboardDatasets(
  primary: DashboardDatasetOption[],
  fallback: DashboardDatasetOption[],
) {
  const seen = new Set<string>();
  return [...primary, ...fallback].filter((dataset) => {
    if (seen.has(dataset.id)) return false;
    seen.add(dataset.id);
    return true;
  });
}

export function useDashboardDatasets(fallbackCatalogDatasets: CatalogDataset[] = []) {
  const fallbackDatasets = useMemo(
    () => fallbackCatalogDatasets
      .filter(isUsableDashboardDataset)
      .map(catalogDatasetToDashboardOption),
    [fallbackCatalogDatasets],
  );
  const [datasets, setDatasets] = useState<DashboardDatasetOption[]>(fallbackDatasets);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let ignore = false;

    setIsLoading(true);
    setError(null);
    if (fallbackDatasets.length) setDatasets(fallbackDatasets);
    void getDatasets()
      .then((catalogDatasets) => {
        if (ignore) return;
        const liveDatasets = catalogDatasets
            .filter(isUsableDashboardDataset)
          .map(catalogDatasetToDashboardOption);
        setDatasets(mergeDashboardDatasets(liveDatasets, fallbackDatasets));
      })
      .catch((unknownError) => {
        if (ignore) return;
        if (fallbackDatasets.length) {
          setError(null);
          setDatasets(fallbackDatasets);
          return;
        }
        setError(unknownError instanceof Error ? unknownError : new Error("Dataset request failed."));
        setDatasets([]);
      })
      .finally(() => {
        if (!ignore) setIsLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [fallbackDatasets]);

  return useMemo(
    () => ({
      datasets,
      error,
      isLoading,
    }),
    [datasets, error, isLoading],
  );
}
