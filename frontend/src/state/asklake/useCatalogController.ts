import { useState } from "react";

import { apiConfig } from "../../services/apiClient";
import { deleteCatalogDataset, deleteDatasetMaterializationRun, getCatalogDatasetDeletionImpact, getCatalogDatasetDeletionStatus } from "../../services/catalogApi";

import type { CatalogDataset, CatalogDatasetDeletionImpact, FlowId } from "../../types";
import { emptySelectedDataset, normalizeDatasetRow, recalculateDatasetFromMaterializationRuns } from "./catalogState";
import { WriteAuditLog } from "./contracts";

import type { AskLakeWorkspaceState } from "./useAskLakeWorkspaceState";

export function useCatalogController({
  onFlowChange,
  showToast,
  state,
  writeAuditLog,
}: {
  onFlowChange: (flow: FlowId) => void;
  showToast: (message: string, tone?: "success" | "info") => void;
  state: AskLakeWorkspaceState;
  writeAuditLog: WriteAuditLog;
}) {
  const [datasetDeletionPendingById, setDatasetDeletionPendingById] = useState<Record<string, boolean>>({});
  const {
    datasets,
    draftPipeline,
    editingJobId,
    jobs,
    runsByJobId,
    selectedDataset,
    selectedJob,
    selectedRunIdByJobId,
    sqlResultDraft,
    setApiPending,
    setCommandPendingByJobId,
    setCreateMutationState,
    setDagStepsByRunId,
    setDatasets,
    setDraftPipeline,
    setEditingJobId,
    setJobListFacets,
    setJobs,
    setJobsLoading,
    setRunsByJobId,
    setSelectedDataset,
    setSelectedJob,
    setSelectedRunIdByJobId,
    setSqlResultDraft,
  } = state;

  const deleteMaterializationRun = async (datasetId: string, runId: string) => {
    const previousState = {
      datasets,
      selectedDataset,
    };
    const targetDataset = datasets.find((dataset) => dataset.id === datasetId);
    if (!targetDataset) {
      showToast("삭제할 append 결과를 찾지 못했습니다.", "info");
      return;
    }

    const applyDataset = (dataset: CatalogDataset) => {
      const normalizedDataset = normalizeDatasetRow(dataset);
      setDatasets((items) => items.map((item) => (item.id === datasetId ? normalizedDataset : item)));
      setSelectedDataset((current) => (current.id === datasetId ? normalizedDataset : current));
      return normalizedDataset;
    };

    try {
      const nextDataset = apiConfig.useMock
        ? recalculateDatasetFromMaterializationRuns({
            ...targetDataset,
            materializationRuns: (targetDataset.materializationRuns ?? []).filter((run) => run.runId !== runId),
          })
        : normalizeDatasetRow((await deleteDatasetMaterializationRun(datasetId, runId)).dataset);

      applyDataset(nextDataset);
      writeAuditLog("catalog.dataset.materialization_run_deleted", `/api/catalog/datasets/${datasetId}/materialization-runs/${runId}`, runId, "success", { targetType: "dataset" });
      showToast("데이터셋 append 결과를 삭제했습니다.");
    } catch {
      setDatasets(previousState.datasets);
      setSelectedDataset(previousState.selectedDataset);
      writeAuditLog("catalog.dataset.materialization_run_delete_failed", `/api/catalog/datasets/${datasetId}/materialization-runs/${runId}`, runId, "failed", { targetType: "dataset" });
      showToast("append 결과 삭제에 실패했습니다.", "info");
    }
  };

  const loadDatasetDeletionImpact = async (datasetId: string): Promise<CatalogDatasetDeletionImpact> => {
    const dataset = datasets.find((item) => item.id === datasetId);
    if (apiConfig.useMock) {
      return {
        artifacts: [],
        blockers: [{
          reason: "데이터셋 전체 삭제는 live backend 연결에서만 사용할 수 있습니다.",
          resourceId: datasetId,
          resourceName: dataset?.name ?? datasetId,
          resourceType: "backend",
        }],
        canDelete: false,
        datasetId,
        datasetName: dataset?.name ?? datasetId,
        estimatedSizeBytes: 0,
        retainedResources: [],
      };
    }
    return getCatalogDatasetDeletionImpact(datasetId);
  };

  const deleteDataset = async (datasetId: string): Promise<boolean> => {
    const targetDataset = datasets.find((dataset) => dataset.id === datasetId);
    if (!targetDataset || datasetDeletionPendingById[datasetId]) return false;
    if (apiConfig.useMock) {
      showToast("데이터셋 전체 삭제는 live backend에서만 사용할 수 있습니다.", "info");
      return false;
    }
    setDatasetDeletionPendingById((current) => ({ ...current, [datasetId]: true }));
    try {
      const accepted = await deleteCatalogDataset(datasetId, targetDataset.name);
      const completed = await waitForDatasetDeletion(accepted.deletionId);
      if (completed.status !== "succeeded") {
        throw new Error(completed.errorMessage || "데이터셋 삭제 작업이 실패했습니다.");
      }
      const remaining = datasets.filter((dataset) => dataset.id !== datasetId);
      setDatasets((items) => items.filter((dataset) => dataset.id !== datasetId));
      setSelectedDataset((current) => current.id === datasetId ? remaining[0] ?? emptySelectedDataset : current);
      if (selectedDataset.id === datasetId) setSqlResultDraft(null);
      writeAuditLog("catalog.dataset.deleted", `/api/catalog/datasets/${datasetId}`, datasetId, "success", { targetType: "dataset" });
      showToast("데이터셋과 관리 물리 데이터를 삭제했습니다.", "success");
      return true;
    } catch (error) {
      writeAuditLog("catalog.dataset.delete_failed", `/api/catalog/datasets/${datasetId}`, datasetId, "failed", { targetType: "dataset" });
      showToast(error instanceof Error ? error.message : "데이터셋 삭제에 실패했습니다.", "info");
      return false;
    } finally {
      setDatasetDeletionPendingById((current) => {
        const next = { ...current };
        delete next[datasetId];
        return next;
      });
    }
  };

  const openDataset = (dataset: CatalogDataset) => {
    setSelectedDataset(dataset);
    writeAuditLog("catalog.dataset.opened", `/api/catalog/datasets/${dataset.id}`, dataset.id);
    onFlowChange("catalogDetail");
  };

  const openDatasetInSql = (dataset: CatalogDataset) => {
    setSelectedDataset(dataset);
    setSqlResultDraft(null);
    writeAuditLog("catalog.open_in_sql.clicked", `/api/catalog/datasets/${dataset.id}/query`, dataset.id, "success", { targetType: "dataset" });
    onFlowChange("sql");
  };

  return {
    datasetDeletionPendingById,
    deleteDataset,
    deleteMaterializationRun,
    loadDatasetDeletionImpact,
    openDataset,
    openDatasetInSql,
  };
}

async function waitForDatasetDeletion(deletionId: string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const current = await getCatalogDatasetDeletionStatus(deletionId);
    if (current.status === "succeeded" || current.status === "failed") return current;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 750));
  }
  throw new Error("삭제 작업이 제한 시간 안에 완료되지 않았습니다. 잠시 후 다시 확인해 주세요.");
}
