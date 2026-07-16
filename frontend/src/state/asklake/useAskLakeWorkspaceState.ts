import { useEffect, useMemo, useState } from "react";

import { createMutationLifecycle } from "../../state/requestOwnership";
import type { CatalogDataset, DagStepsByRunId, DraftPipeline, JobListFacets, JobRowData, RunsByJobId, SelectedRunIdByJobId, SqlResultDraft } from "../../types";
import { emptySelectedDataset, getInitialDatasets } from "./catalogState";

import { initialDraftPipeline, loadStoredEtlDraft, saveStoredEtlDraft } from "./etlDraftState";

import { CommandPendingByJobId, buildJobExecutionEvidence, emptySelectedJob, getInitialJobs, getJobListFacets } from "./jobState";

export function useAskLakeWorkspaceState() {
  const [jobs, setJobs] = useState<JobRowData[]>(getInitialJobs);
  const [jobListFacets, setJobListFacets] = useState<JobListFacets>(() => getJobListFacets(getInitialJobs()));
  const [datasets, setDatasets] = useState<CatalogDataset[]>(getInitialDatasets);
  const [draftPipeline, setDraftPipeline] = useState<DraftPipeline>(() => loadStoredEtlDraft(initialDraftPipeline));
  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const [selectedDataset, setSelectedDataset] = useState<CatalogDataset>(() => getInitialDatasets()[0] ?? emptySelectedDataset);
  const [selectedJob, setSelectedJob] = useState<JobRowData>(() => getInitialJobs()[0] ?? emptySelectedJob);
  const [runsByJobId, setRunsByJobId] = useState<RunsByJobId>({});
  const [selectedRunIdByJobId, setSelectedRunIdByJobId] = useState<SelectedRunIdByJobId>({});
  const [dagStepsByRunId, setDagStepsByRunId] = useState<DagStepsByRunId>({});
  const [commandPendingByJobId, setCommandPendingByJobId] = useState<CommandPendingByJobId>({});
  const [sqlResultDraft, setSqlResultDraft] = useState<SqlResultDraft | null>(null);
  const [apiPending, setApiPending] = useState(false);
  const [createMutationState, setCreateMutationState] = useState(createMutationLifecycle);
  const [dataLoading, setDataLoading] = useState(false);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);

  useEffect(() => {
    saveStoredEtlDraft(draftPipeline);
  }, [draftPipeline]);

  const jobExecutionEvidence = useMemo(
    () => buildJobExecutionEvidence(runsByJobId, selectedRunIdByJobId, dagStepsByRunId),
    [dagStepsByRunId, runsByJobId, selectedRunIdByJobId],
  );

  return {
    apiPending,
    commandPendingByJobId,
    createMutationState,
    dagStepsByRunId,
    dataError,
    dataLoading,
    datasets,
    draftPipeline,
    editingJobId,
    jobExecutionEvidence,
    jobListFacets,
    jobs,
    jobsLoading,
    runsByJobId,
    selectedDataset,
    selectedJob,
    selectedRunIdByJobId,
    sqlResultDraft,
    setApiPending,
    setCommandPendingByJobId,
    setCreateMutationState,
    setDagStepsByRunId,
    setDataError,
    setDataLoading,
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
  };
}

export type AskLakeWorkspaceState = ReturnType<typeof useAskLakeWorkspaceState>;
