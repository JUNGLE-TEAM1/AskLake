import { useEffect, useMemo, useState } from "react";
import type { DashboardDatasetOption } from "./dashboardRuntimeTypes";
import { getDashboardCatalogDatasets } from "./dashboardCatalogApi";
import {
  catalogDatasetToDashboardOption,
  isUsableDashboardDataset,
} from "./dashboardDatasetAdapters";
import { onCatalogDatasetDeleted } from "../../../services/catalogEvents";

export function useDashboardDatasets(enabled = true) {
  const [datasets, setDatasets] = useState<DashboardDatasetOption[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);

  useEffect(() => {
    if (!enabled) {
      setError(null);
      setIsLoading(false);
      return;
    }

    let ignore = false;

    const loadDatasets = () => {
      setIsLoading(true);
      setError(null);
      void getDashboardCatalogDatasets()
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
    };

    loadDatasets();
    const removeDatasetDeletedListener = onCatalogDatasetDeleted(loadDatasets);

    return () => {
      ignore = true;
      removeDatasetDeletedListener();
    };
  }, [enabled]);

  return useMemo(
    () => ({
      datasets,
      error,
      isLoading,
    }),
    [datasets, error, isLoading],
  );
}
