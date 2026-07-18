import { useRef } from "react";
import { ApiError } from "../../types";

import { apiConfig } from "../../services/apiClient";

import { applyDraftPipelinePatch } from "../../services/draftPipelineContract";

import { createPipelineDraft as createMockPipelineDraft, updatePipelineDraft as updateMockPipelineDraft } from "../../services/mockApi";
import { createPipelineDraft as createLivePipelineDraft, createTrinoSqlJob as createLiveTrinoSqlJob, updatePipelineDraft as updateLivePipelineDraft } from "../../services/pipelineApi";

import { transitionMutation } from "../../state/requestOwnership";
import type { CreateDerivedDatasetRequest, CreateTrinoSqlJobRequest, DraftPipeline, DraftPipelinePatch, FlowId } from "../../types";
import { normalizeDatasetRow, saveStoredCatalogDataset } from "./catalogState";
import { WriteAuditLog } from "./contracts";
import { initialDraftPipeline } from "./etlDraftState";

import { normalizeJobRow, upsertJobById } from "./jobState";
import { buildSqlDatasetJobDraft } from "./sqlJobDraft";
import type { AskLakeWorkspaceState } from "./useAskLakeWorkspaceState";

export function usePipelineMutations({
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
  const createPendingRef = useRef(false);

  const updateDraftPipeline = (patch: DraftPipelinePatch) => {
    setDraftPipeline((draft) => applyDraftPipelinePatch(draft, patch));
  };

  const createPipelineFromDraft = async (
    pipelineDraft: DraftPipeline,
    {
      navigateToJobs = true,
      resetDraft = true,
    }: { navigateToJobs?: boolean; resetDraft?: boolean } = {},
  ) => {
    if (createPendingRef.current) {
      showToast("이미 생성 요청이 처리 중입니다.", "info");
      return false;
    }

    const previousState = {
      datasets,
      jobs,
      selectedDataset,
      selectedJob,
    };
    createPendingRef.current = true;
    setApiPending(true);
    setCreateMutationState((state) => transitionMutation(state, "pending"));
    try {
      const activeEditJobId = editingJobId === pipelineDraft.id ? editingJobId : null;
      const updatedJob = activeEditJobId
        ? await (apiConfig.useMock
          ? updateMockPipelineDraft(activeEditJobId, pipelineDraft)
          : updateLivePipelineDraft(activeEditJobId, pipelineDraft))
        : null;
      const result = updatedJob
        ? { job: updatedJob }
        : apiConfig.useMock
          ? await createMockPipelineDraft(pipelineDraft, jobs.length)
          : await createLivePipelineDraft(pipelineDraft);
      const normalizedJob = normalizeJobRow(result.job);
      const normalizedDataset = "dataset" in result && result.dataset ? normalizeDatasetRow(result.dataset) : null;
      setCreateMutationState((state) => transitionMutation(state, "accepted"));

      setJobs((items) => upsertJobById(items, normalizedJob));
      setSelectedJob(normalizedJob);
      setEditingJobId(null);
      if (normalizedDataset) {
        saveStoredCatalogDataset(normalizedDataset);
        setDatasets((items) => [normalizedDataset, ...items.filter((item) => item.id !== normalizedDataset.id)]);
        setSelectedDataset(normalizedDataset);
      }
      writeAuditLog(activeEditJobId ? "etl.job.updated" : "etl.job.created", activeEditJobId ? `/api/etl/jobs/${normalizedJob.id}` : "/api/etl/jobs", normalizedJob.id);
      if (!activeEditJobId) writeAuditLog("etl.run.queued", `/api/etl/jobs/${pipelineDraft.id}/runs`, pipelineDraft.id);
      showToast(normalizedDataset ? "파이프라인 생성 요청이 접수되었습니다." : "파이프라인 생성 요청을 접수했습니다. 실행 성공 후 카탈로그에 등록됩니다.");
      if (resetDraft) setDraftPipeline(initialDraftPipeline);
      if (navigateToJobs) onFlowChange("jobs");
      setCreateMutationState((state) => transitionMutation(state, "reconciled"));
      return true;
    } catch (error) {
      setJobs(previousState.jobs);
      setDatasets(previousState.datasets);
      setSelectedJob(previousState.selectedJob);
      setSelectedDataset(previousState.selectedDataset);
      writeAuditLog("etl.job.create_failed", "/api/etl/jobs", pipelineDraft.id, "failed");
      const message = error instanceof ApiError ? error.message : "파이프라인 생성 요청에 실패했습니다.";
      setCreateMutationState((state) => transitionMutation(state, "failed", message));
      showToast(message, "info");
      return false;
    } finally {
      createPendingRef.current = false;
      setApiPending(false);
    }
  };

  const createPipeline = async () => {
    await createPipelineFromDraft(draftPipeline);
  };

  const createSqlDatasetJob = async (request: CreateDerivedDatasetRequest) => {
    const sourceDataset = datasets.find((item) => item.id === request.sourceDatasetId);
    const currentSqlResult = sqlResultDraft?.runId === request.sourceRunId ? sqlResultDraft : null;

    if (!sourceDataset || !currentSqlResult) {
      writeAuditLog("analysis.derived_dataset.job_draft_failed", "/api/etl/jobs", request.sourceDatasetId, "failed");
      showToast("처리 Job 생성에 필요한 SQL Preview 결과를 찾지 못했습니다.", "info");
      return false;
    }

    const nextDraft = buildSqlDatasetJobDraft(request, sourceDataset, currentSqlResult);
    writeAuditLog("analysis.derived_dataset.job_draft_prepared", "/api/etl/jobs", nextDraft.id);
    return createPipelineFromDraft(nextDraft, { resetDraft: false });
  };

  const createTrinoSqlJob = async (request: CreateTrinoSqlJobRequest) => {
    if (createPendingRef.current) {
      showToast("이미 생성 요청이 처리 중입니다.", "info");
      return false;
    }
    if (apiConfig.useMock) {
      showToast("Trino SQL Job은 실제 API 모드에서 생성할 수 있습니다.", "info");
      return false;
    }

    createPendingRef.current = true;
    setApiPending(true);
    try {
      const result = await createLiveTrinoSqlJob(request);
      const normalizedJob = normalizeJobRow(result.job);
      setJobs((items) => [normalizedJob, ...items.filter((item) => item.id !== normalizedJob.id)]);
      setSelectedJob(normalizedJob);
      writeAuditLog("analysis.trino_sql_job.created", "/api/etl/sql-jobs", normalizedJob.id);
      showToast("반복 SQL Job을 생성했습니다.", "success");
      onFlowChange("jobs");
      return true;
    } catch (error) {
      writeAuditLog("analysis.trino_sql_job.create_failed", "/api/etl/sql-jobs", request.baseDatasetId, "failed");
      showToast(error instanceof ApiError ? error.message : "반복 SQL Job 생성에 실패했습니다.", "info");
      return false;
    } finally {
      createPendingRef.current = false;
      setApiPending(false);
    }
  };

  return { createPipeline, createSqlDatasetJob, createTrinoSqlJob, updateDraftPipeline };
}
