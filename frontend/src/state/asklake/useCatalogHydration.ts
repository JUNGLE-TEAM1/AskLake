import { useEffect, useRef } from "react";

import { apiConfig } from "../../services/apiClient";
import { getDatasets } from "../../services/mockApi";

import { createResourceQueryKey, LatestRequestGate } from "../../state/requestOwnership";
import { emptySelectedDataset, loadStoredCatalogDatasets, mergeCatalogDatasets, normalizeDatasetRow } from "./catalogState";
import { getInitialReadErrorMessage, readInitialResource } from "./initialRead";

import type { AskLakeWorkspaceState } from "./useAskLakeWorkspaceState";

export function useCatalogHydration({
  enabled,
  showToast,
  state,
}: {
  enabled: boolean;
  showToast: (message: string, tone?: "success" | "info") => void;
  state: AskLakeWorkspaceState;
}) {
  const {
    setCatalogError,
    setCatalogLoading,
    setDatasets,
    setSelectedDataset,
  } = state;
  const requests = useRef(new LatestRequestGate());

  const applyHydratedDatasets = (datasets: Awaited<ReturnType<typeof getDatasets>>) => {
    const mergedDatasets = apiConfig.useMock
      ? mergeCatalogDatasets(datasets, loadStoredCatalogDatasets())
      : datasets;
    const normalizedDatasets = mergedDatasets.map(normalizeDatasetRow);
    setDatasets(normalizedDatasets);
    setSelectedDataset((current) => normalizedDatasets.find((dataset) => dataset.id === current.id) ?? normalizedDatasets[0] ?? emptySelectedDataset);
  };

  useEffect(() => {
    if (!enabled) {
      requests.current.invalidate();
      setCatalogError(null);
      setCatalogLoading(false);
      return;
    }

    let cancelled = false;
    const lease = requests.current.begin(createResourceQueryKey({ resource: "catalog", version: "route-entry" }));

    async function hydrateCatalog() {
      setCatalogError(null);
      setCatalogLoading(true);
      try {
        const result = await readInitialResource(getDatasets, "catalog", state.datasets);
        if (cancelled || !requests.current.isCurrent(lease)) return;

        if (!result.error) {
          applyHydratedDatasets(result.data);
          return;
        }
        if (result.fatal) {
          setCatalogError(result.error);
          return;
        }
        showToast("Catalog 목록을 불러오지 못해 기존 목록을 유지합니다.", "info");
      } finally {
        if (!cancelled && requests.current.complete(lease)) setCatalogLoading(false);
      }
    }

    void hydrateCatalog();

    return () => {
      cancelled = true;
      requests.current.invalidate();
    };
  }, [enabled]);

  const refreshCatalog = async () => {
    if (!enabled) return false;
    const lease = requests.current.begin(createResourceQueryKey({ resource: "catalog", version: "manual-refresh" }));
    setCatalogError(null);
    setCatalogLoading(true);
    try {
      const datasets = await getDatasets();
      if (!requests.current.isCurrent(lease)) return false;
      applyHydratedDatasets(datasets);
      showToast("Catalog 목록을 새로고침했습니다.");
      return true;
    } catch (error) {
      if (!requests.current.isCurrent(lease)) return false;
      const detail = getInitialReadErrorMessage(error);
      setCatalogError(`refresh: ${detail}`);
      showToast(`Catalog 목록 새로고침 실패: ${detail}`, "info");
      return false;
    } finally {
      if (requests.current.complete(lease)) setCatalogLoading(false);
    }
  };

  return { refreshCatalog };
}
