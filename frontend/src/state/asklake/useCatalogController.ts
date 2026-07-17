

import { deleteDatasetMaterializationRun } from "../../services/catalogApi";

import type { CatalogDataset, FlowId } from "../../types";
import { normalizeDatasetRow } from "./catalogState";
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
      const nextDataset = normalizeDatasetRow((await deleteDatasetMaterializationRun(datasetId, runId)).dataset);

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

  return { deleteMaterializationRun, openDataset, openDatasetInSql };
}
