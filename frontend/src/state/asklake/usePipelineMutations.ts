import { useRef } from "react";
import { ApiError } from "../../types";

import { apiConfig } from "../../services/apiClient";

import { applyDraftPipelinePatch } from "../../services/draftPipelineContract";

import { createPipelineDraft as createMockPipelineDraft, runJobCommand as runMockJobCommand, updatePipelineDraft as updateMockPipelineDraft } from "../../services/mockApi";
import { createPipelineDraft as createLivePipelineDraft, createTrinoSqlJob as createLiveTrinoSqlJob, getJob as getLiveJob, runJobCommand as runLiveJobCommand, updatePipelineDraft as updateLivePipelineDraft, type JobCommandResult } from "../../services/pipelineApi";

import { transitionMutation } from "../../state/requestOwnership";
import type { CreateDerivedDatasetRequest, CreateTrinoSqlJobRequest, DraftPipeline, DraftPipelinePatch, FlowId, JobRowData } from "../../types";
import { normalizeDatasetRow, saveStoredCatalogDataset } from "./catalogState";
import { WriteAuditLog } from "./contracts";
import { initialDraftPipeline } from "./etlDraftState";

import { normalizeJobRow, upsertJobById, upsertRunByRunId } from "./jobState";
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

  const resetDraftPipeline = () => {
    setDraftPipeline(initialDraftPipeline);
  };

  const applyJobSnapshot = (job: JobRowData) => {
    const normalizedJob = normalizeJobRow(job);
    const runHistory = normalizedJob.runHistory ?? [];
    setJobs((items) => upsertJobById(items, normalizedJob));
    setSelectedJob(normalizedJob);
    if (runHistory.length > 0) {
      setRunsByJobId((state) => ({
        ...state,
        [normalizedJob.id]: runHistory,
      }));
      setSelectedRunIdByJobId((state) => ({
        ...state,
        [normalizedJob.id]: runHistory[0].runId,
      }));
    }
    if (normalizedJob.dagStepsByRunId) {
      setDagStepsByRunId((state) => ({
        ...state,
        ...normalizedJob.dagStepsByRunId,
      }));
    }
    return normalizedJob;
  };

  const applyInitialRunResult = (createdJob: JobRowData, result: JobCommandResult) => {
    const effectiveJob = result.job ? applyJobSnapshot(result.job) : createdJob;
    const run = result.run;
    if (!run) throw new Error("실행 응답에 Run 정보가 없습니다.");
    setRunsByJobId((state) => ({
      ...state,
      [effectiveJob.id]: upsertRunByRunId(state[effectiveJob.id] ?? [], run),
    }));
    setSelectedRunIdByJobId((state) => ({
      ...state,
      [effectiveJob.id]: run.runId,
    }));
    if (result.dagSteps) {
      setDagStepsByRunId((state) => ({
        ...state,
        [run.runId]: result.dagSteps!,
      }));
    }
    if (result.dataset) {
      const normalizedDataset = normalizeDatasetRow(result.dataset);
      saveStoredCatalogDataset(normalizedDataset);
      setDatasets((items) => [normalizedDataset, ...items.filter((item) => item.id !== normalizedDataset.id)]);
      setSelectedDataset(normalizedDataset);
    }
  };

  const requestInitialSqlRun = async (createdJob: JobRowData) => {
    setCommandPendingByJobId((state) => ({ ...state, [createdJob.id]: "run" }));
    try {
      const result = apiConfig.useMock
        ? await runMockJobCommand(createdJob, "run")
        : await runLiveJobCommand(createdJob, "run");
      applyInitialRunResult(createdJob, result);
      writeAuditLog(result.action, result.apiPath, createdJob.id);
      return { accepted: true as const };
    } catch (error) {
      if (!apiConfig.useMock) {
        try {
          applyJobSnapshot(await getLiveJob(createdJob.id));
        } catch {
          // The durable create response remains the source of truth when refresh also fails.
        }
      }
      writeAuditLog("analysis.sql_job.initial_run_failed", `/api/etl/jobs/${createdJob.id}/commands`, createdJob.id, "failed");
      return {
        accepted: false as const,
        message: error instanceof ApiError ? error.message : error instanceof Error ? error.message : "실행 요청을 처리하지 못했습니다.",
      };
    } finally {
      setCommandPendingByJobId((state) => {
        const { [createdJob.id]: _pendingCommand, ...rest } = state;
        return rest;
      });
    }
  };

  const createPipelineFromDraft = async (
    pipelineDraft: DraftPipeline,
    {
      navigateToJobs = true,
      resetDraft = true,
      runAfterCreate = false,
    }: { navigateToJobs?: boolean; resetDraft?: boolean; runAfterCreate?: boolean } = {},
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
      const initialRun = runAfterCreate && !activeEditJobId
        ? await requestInitialSqlRun(normalizedJob)
        : null;
      if (initialRun?.accepted) {
        showToast("SQL Job을 생성하고 첫 실행 요청을 접수했습니다.", "success");
      } else if (initialRun && !initialRun.accepted) {
        showToast(`SQL Job은 생성됐지만 첫 실행 요청에 실패했습니다: ${initialRun.message}`, "info");
      } else {
        showToast(normalizedDataset ? "파이프라인 생성 요청이 접수되었습니다." : "파이프라인 생성 요청을 접수했습니다. 실행 성공 후 카탈로그에 등록됩니다.");
      }
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
    return createPipelineFromDraft(nextDraft, { resetDraft: false, runAfterCreate: true });
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
      const initialRun = await requestInitialSqlRun(normalizedJob);
      if (initialRun.accepted) {
        showToast("반복 SQL Job을 생성하고 첫 실행 요청을 접수했습니다.", "success");
      } else {
        showToast(`반복 SQL Job은 생성됐지만 첫 실행 요청에 실패했습니다: ${initialRun.message}`, "info");
      }
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

  return { createPipeline, createSqlDatasetJob, createTrinoSqlJob, resetDraftPipeline, updateDraftPipeline };
}
