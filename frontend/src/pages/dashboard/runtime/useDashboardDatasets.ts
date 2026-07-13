import { useEffect, useMemo, useState } from "react";
import type { CatalogDataset } from "../../../types";
import { getDatasets } from "../../../services/mockApi";
import type { DashboardDatasetOption } from "./dashboardRuntimeTypes";
import {
  catalogDatasetToDashboardOption,
  isUsableDashboardDataset,
  mergeDashboardDatasets,
} from "./dashboardDatasetAdapters";

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
