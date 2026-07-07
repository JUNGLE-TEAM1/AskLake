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
    status: dataset.status,
  };
}

function isUsableDashboardDataset(dataset: CatalogDataset) {
  return dataset.status === "available" && dataset.schema.length > 0;
}

export function useDashboardDatasets() {
  const [datasets, setDatasets] = useState<DashboardDatasetOption[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let ignore = false;

    setIsLoading(true);
    setError(null);
    void getDatasets()
      .then((catalogDatasets) => {
        if (ignore) return;
        setDatasets(
          catalogDatasets
            .filter(isUsableDashboardDataset)
            .map(catalogDatasetToDashboardOption),
        );
      })
      .catch((unknownError) => {
        if (ignore) return;
        setError(unknownError instanceof Error ? unknownError : new Error("Dataset request failed."));
        setDatasets([]);
      })
      .finally(() => {
        if (!ignore) setIsLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, []);

  return useMemo(
    () => ({
      datasets,
      error,
      isLoading,
    }),
    [datasets, error, isLoading],
  );
}
