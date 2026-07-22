import { useRef } from "react";

import { apiConfig } from "../../services/apiClient";

import { hydrateDraftPipelineFromJob } from "../../services/draftPipelineContract";
import { runJobCommand as runMockJobCommand } from "../../services/mockApi";
import { deletePipelineJob as deleteLivePipelineJob, getJob as getLiveJob, runJobCommand as runLiveJobCommand } from "../../services/pipelineApi";

import { MutationRevisionGate } from "../../state/requestOwnership";
import type { FlowId, JobCommand, JobRowData } from "../../types";
import { normalizeDatasetRow, saveStoredCatalogDataset } from "./catalogState";
import { WriteAuditLog } from "./contracts";
import { initialDraftPipeline } from "./etlDraftState";

import { buildClientRunId, buildOptimisticJob, buildOptimisticRun, commandSuccessMessage, emptySelectedJob, isOptimisticRunCommand, moveJobFacetCounts, normalizeJobRow, removeJobFacetCounts, replaceJobById, replaceTempRunByRunId, restoreRecordEntry, upsertRunByRunId, withoutRecordKey } from "./jobState";

import type { AskLakeWorkspaceState } from "./useAskLakeWorkspaceState";
import { useSnapshotJobStatusPolling } from "./useSnapshotJobStatusPolling";

export function useJobController({
  enabled,
  onFlowChange,
  showToast,
  state,
  writeAuditLog,
}: {
  enabled: boolean;
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
  const commandPendingRef = useRef<Set<string>>(new Set());
  const mutationRevisions = useRef(new MutationRevisionGate());

  useSnapshotJobStatusPolling({ enabled, showToast, state });

  const updateJobState = (jobId: string, updater: (job: JobRowData) => JobRowData) => {
    setJobs((items) => replaceJobById(items, jobId, updater));
    setSelectedJob((job) => (job.id === jobId ? updater(job) : job));
  };

  const selectRunForJob = (jobId: string, runId: string) => {
    setSelectedRunIdByJobId((state) => {
      const runExists = (runsByJobId[jobId] ?? []).some((run) => run.runId === runId);
      if (!runExists || state[jobId] === runId) return state;
      return {
        ...state,
        [jobId]: runId,
      };
    });
  };

  const handleJobCommand = async (job: JobRowData, command: JobCommand): Promise<JobRowData | undefined> => {
    if (command === "edit") {
      mutationRevisions.current.invalidate(job.id);
      writeAuditLog("etl.job.edit_opened", `/api/etl/jobs/${job.id}`, job.id);
      let editableJob = job;
      if (!apiConfig.useMock) {
        try {
          editableJob = normalizeJobRow(await getLiveJob(job.id));
          updateJobState(job.id, () => editableJob);
        } catch {
          // The list payload is still a valid fallback when the detail refresh fails.
        }
      }
      setSelectedJob(editableJob);
      setDraftPipeline(hydrateDraftPipelineFromJob(editableJob, initialDraftPipeline));
      setEditingJobId(editableJob.id);
      onFlowChange("source");
      return undefined;
    }

    if (command === "delete") {
      mutationRevisions.current.invalidate(job.id);
      if (commandPendingRef.current.has(job.id)) {
        showToast("이미 해당 Job 삭제를 처리 중입니다.", "info");
        return undefined;
      }
      commandPendingRef.current.add(job.id);
      setApiPending(true);
      writeAuditLog("etl.job.delete_requested", `/api/etl/jobs/${job.id}`, job.id);
      try {
        if (!apiConfig.useMock) await deleteLivePipelineJob(job.id);
        const remaining = jobs.filter((item) => item.id !== job.id);
        const deletedRunIds = new Set((runsByJobId[job.id] ?? []).map((run) => run.runId));
        setJobs(remaining);
        setJobListFacets((facets) => removeJobFacetCounts(facets, job));
        setSelectedJob(remaining[0] ?? emptySelectedJob);
        setRunsByJobId((state) => withoutRecordKey(state, job.id));
        setSelectedRunIdByJobId((state) => withoutRecordKey(state, job.id));
        setDagStepsByRunId((state) => Object.fromEntries(Object.entries(state).filter(([runId]) => !deletedRunIds.has(runId))));
        writeAuditLog("etl.job.deleted", `/api/etl/jobs/${job.id}`, job.id);
        onFlowChange("jobs");
      } catch (error) {
        writeAuditLog("etl.job.delete_failed", `/api/etl/jobs/${job.id}`, job.id, "failed");
        showToast(error instanceof Error ? error.message : "Job 삭제에 실패했습니다.", "info");
      } finally {
        commandPendingRef.current.delete(job.id);
        setApiPending(false);
      }
      return undefined;
    }

    if (commandPendingRef.current.has(job.id)) {
      showToast("이미 이 작업 명령을 처리 중입니다.", "info");
      return;
    }

    const mutationLease = mutationRevisions.current.begin(job.id);
    const previousJob = jobs.find((item) => item.id === job.id) ?? job;
    const previousRunsForJob = runsByJobId[job.id];
    const previousSelectedRunId = selectedRunIdByJobId[job.id];
    const tempRunId = isOptimisticRunCommand(command) ? buildClientRunId(job.id) : null;
    const rollbackOptimisticRun = () => {
      if (!mutationRevisions.current.isCurrent(mutationLease)) return false;
      setJobs((items) => items.map((item) => (item.id === job.id ? previousJob : item)));
      setSelectedJob((current) => (current.id === job.id ? previousJob : current));
      setRunsByJobId((state) => restoreRecordEntry(state, job.id, previousRunsForJob));
      setSelectedRunIdByJobId((state) => restoreRecordEntry(state, job.id, previousSelectedRunId));
      setDagStepsByRunId((state) => withoutRecordKey(state, tempRunId));
      return true;
    };

    if (tempRunId) {
      const optimisticRun = buildOptimisticRun(tempRunId);
      const optimisticJob = buildOptimisticJob(job);
      updateJobState(job.id, () => optimisticJob);
      setRunsByJobId((state) => ({
        ...state,
        [job.id]: upsertRunByRunId(state[job.id] ?? [], optimisticRun),
      }));
      setSelectedRunIdByJobId((state) => ({
        ...state,
        [job.id]: tempRunId,
      }));
    }

    commandPendingRef.current.add(job.id);
    setCommandPendingByJobId((state) => ({
      ...state,
      [job.id]: command,
    }));
    setApiPending(true);
    try {
      const { action, apiPath, dagSteps, dataset, job: updatedJob, run } = apiConfig.useMock
        ? await runMockJobCommand(job, command)
        : await runLiveJobCommand(job, command);
      writeAuditLog(action, apiPath, job.id);
      let normalizedUpdatedJob: JobRowData | undefined;
      if (updatedJob) {
        const nextJob = normalizeJobRow(updatedJob);
        normalizedUpdatedJob = nextJob;
        updateJobState(job.id, () => nextJob);
        setJobListFacets((facets) => moveJobFacetCounts(facets, previousJob, nextJob));
      }
      if (run) {
        setRunsByJobId((state) => ({
          ...state,
          [job.id]: tempRunId ? replaceTempRunByRunId(state[job.id] ?? [], tempRunId, run) : upsertRunByRunId(state[job.id] ?? [], run),
        }));
        setSelectedRunIdByJobId((state) => ({
          ...state,
          [job.id]: run.runId,
        }));
        setDagStepsByRunId((state) => {
          const rest = withoutRecordKey(state, tempRunId);
          return dagSteps
            ? {
                ...rest,
                [run.runId]: dagSteps,
              }
            : rest;
        });
      } else if (tempRunId) {
        rollbackOptimisticRun();
        showToast("실행 응답에 Run 정보가 없어 상태를 되돌렸습니다.", "info");
        return undefined;
      }
      if (dataset) {
        const normalizedDataset = normalizeDatasetRow(dataset);
        saveStoredCatalogDataset(normalizedDataset);
        setDatasets((items) => [normalizedDataset, ...items.filter((item) => item.id !== normalizedDataset.id)]);
        setSelectedDataset(normalizedDataset);
      }
      showToast(commandSuccessMessage(command, job));
      return normalizedUpdatedJob;
    } catch {
      if (tempRunId) {
        rollbackOptimisticRun();
      }
      writeAuditLog("etl.job.command_failed", `/api/etl/jobs/${job.id}`, job.id, "failed");
      showToast("작업 명령 처리에 실패했습니다.", "info");
      return undefined;
    } finally {
      commandPendingRef.current.delete(job.id);
      setCommandPendingByJobId((state) => {
        const { [job.id]: _pendingCommand, ...rest } = state;
        return rest;
      });
      setApiPending(false);
    }
  };

  const openJobDetail = (job: JobRowData) => {
    setSelectedJob(job);
    writeAuditLog("etl.job.detail_opened", `/api/etl/jobs/${job.id}`, job.id);
    onFlowChange("jobDetail");
  };

  const openJobRuns = (job: JobRowData) => {
    setSelectedJob(job);
    writeAuditLog("etl.job.runs_opened", `/api/etl/jobs/${job.id}/runs`, job.id);
    onFlowChange("jobRuns");
  };

  return { handleJobCommand, openJobDetail, openJobRuns, selectRunForJob };
}
