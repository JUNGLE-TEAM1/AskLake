import { useEffect, useRef } from "react";
import { ApiError } from "../../types";

import { apiConfig } from "../../services/apiClient";

import { getDatasets, getJobs } from "../../services/mockApi";

import { createResourceQueryKey, LatestRequestGate } from "../../state/requestOwnership";
import type { JobListQuery } from "../../types";
import { emptySelectedDataset, loadStoredCatalogDatasets, mergeCatalogDatasets, normalizeDatasetRow } from "./catalogState";

import { getInitialReadErrorMessage, readInitialResource } from "./initialRead";
import { buildRunStateFromJobs, emptySelectedJob, getInitialJobs, getJobListFacets, normalizeJobRow } from "./jobState";

import type { AskLakeWorkspaceState } from "./useAskLakeWorkspaceState";

export function useWorkspaceHydration({
  enabled,
  showToast,
  state,
}: {
  enabled: boolean;
  showToast: (message: string, tone?: "success" | "info") => void;
  state: AskLakeWorkspaceState;
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
  } = state;
  const dataHydrationRequests = useRef(new LatestRequestGate());
  const jobsFilterRequests = useRef(new LatestRequestGate());

  const applyHydratedJobs = (result: Awaited<ReturnType<typeof getJobs>>) => {
    const normalizedJobs = result.jobs.map(normalizeJobRow);
    const hydratedRunState = buildRunStateFromJobs(normalizedJobs);
    setJobs(normalizedJobs);
    setJobListFacets(result.facets);
    setSelectedJob((current) => normalizedJobs.find((job) => job.id === current.id) ?? normalizedJobs[0] ?? emptySelectedJob);
    setRunsByJobId(hydratedRunState.runsByJobId);
    setSelectedRunIdByJobId(hydratedRunState.selectedRunIdByJobId);
    setDagStepsByRunId(hydratedRunState.dagStepsByRunId);
  };

  const applyHydratedDatasets = (result: Awaited<ReturnType<typeof getDatasets>>) => {
    const normalizedDatasets = result.map(normalizeDatasetRow);
    setDatasets(normalizedDatasets);
    setSelectedDataset((current) => normalizedDatasets.find((dataset) => dataset.id === current.id) ?? normalizedDatasets[0] ?? emptySelectedDataset);
  };

  const refreshData = async () => {
    if (!enabled) return false;

    const hydrationLease = dataHydrationRequests.current.begin(createResourceQueryKey({ resource: "app-hydration", version: "manual-refresh" }));
    const jobsLease = jobsFilterRequests.current.begin(createResourceQueryKey({ resource: "jobs", version: "manual-refresh" }));
    setDataLoading(true);
    setJobsLoading(false);
    setDataError(null);
    try {
      const [jobsResult, datasetsResult] = await Promise.all([
        getJobs(),
        getDatasets(),
      ]);
      if (!dataHydrationRequests.current.isCurrent(hydrationLease)) return false;

      if (jobsFilterRequests.current.isCurrent(jobsLease)) applyHydratedJobs(jobsResult);
      applyHydratedDatasets(
        apiConfig.useMock
          ? mergeCatalogDatasets(datasetsResult, loadStoredCatalogDatasets())
          : datasetsResult,
      );
      showToast("Job과 데이터셋 목록을 새로고침했습니다.");
      return true;
    } catch (error) {
      if (!dataHydrationRequests.current.isCurrent(hydrationLease)) return false;
      const detail = getInitialReadErrorMessage(error);
      setDataError(`refresh: ${detail}`);
      showToast(`새로고침 실패: ${detail}`, "info");
      return false;
    } finally {
      if (dataHydrationRequests.current.complete(hydrationLease)) setDataLoading(false);
      jobsFilterRequests.current.complete(jobsLease);
    }
  };

  useEffect(() => {
    if (!enabled) {
      dataHydrationRequests.current.invalidate();
      jobsFilterRequests.current.invalidate();
      setDataLoading(false);
      setJobsLoading(false);
      return;
    }
    if (apiConfig.useMock) {
      const initialJobs = getInitialJobs();
      const hydratedRunState = buildRunStateFromJobs(initialJobs);
      setJobListFacets(getJobListFacets(initialJobs));
      setRunsByJobId(hydratedRunState.runsByJobId);
      setSelectedRunIdByJobId(hydratedRunState.selectedRunIdByJobId);
      setDagStepsByRunId(hydratedRunState.dagStepsByRunId);
      setDataLoading(false);
      setDataError(null);
      return;
    }

    let cancelled = false;
    const hydrationLease = dataHydrationRequests.current.begin(createResourceQueryKey({ resource: "app-hydration", version: "initial" }));
    const jobsLease = jobsFilterRequests.current.begin(createResourceQueryKey({ resource: "jobs", version: "initial" }));

    async function hydrateData() {
      setDataError(null);
      try {
        const [jobsResult, datasetsResult] = await Promise.all([
          readInitialResource(getJobs, "jobs", { facets: getJobListFacets([]), jobs: [] }),
          readInitialResource(getDatasets, "catalog", []),
        ]);
        if (cancelled || !dataHydrationRequests.current.isCurrent(hydrationLease)) return;

        if (jobsFilterRequests.current.isCurrent(jobsLease)) applyHydratedJobs(jobsResult.data);
        applyHydratedDatasets(datasetsResult.data);

        const fatalErrors = [jobsResult, datasetsResult]
          .filter((result) => result.fatal && result.error)
          .map((result) => result.error);
        const recoverableErrors = [jobsResult, datasetsResult]
          .filter((result) => !result.fatal && result.error)
          .map((result) => result.error);

        if (fatalErrors.length > 0) {
          setDataError(fatalErrors.join(" / "));
        } else if (recoverableErrors.length > 0) {
          setDataError(null);
          showToast("DB API 초기 목록을 불러오지 못해 빈 상태로 표시합니다.", "info");
        }
      } finally {
        if (!cancelled && dataHydrationRequests.current.complete(hydrationLease)) setDataLoading(false);
        jobsFilterRequests.current.complete(jobsLease);
      }
    }

    void hydrateData();

    return () => {
      cancelled = true;
      dataHydrationRequests.current.invalidate();
      jobsFilterRequests.current.invalidate();
    };
  }, [enabled]);

  const filterJobs = async (query: JobListQuery) => {
    const lease = jobsFilterRequests.current.begin(createResourceQueryKey({ resource: "jobs", params: query as Record<string, unknown>, version: "filtered" }));
    setJobsLoading(true);
    try {
      const result = await getJobs(query);
      if (!jobsFilterRequests.current.isCurrent(lease)) return;
      const normalizedJobs = result.jobs.map(normalizeJobRow);
      const hydratedRunState = buildRunStateFromJobs(normalizedJobs);
      setJobs(normalizedJobs);
      setJobListFacets(result.facets);
      setRunsByJobId(hydratedRunState.runsByJobId);
      setSelectedRunIdByJobId(hydratedRunState.selectedRunIdByJobId);
      setDagStepsByRunId(hydratedRunState.dagStepsByRunId);
    } catch (error) {
      if (!jobsFilterRequests.current.isCurrent(lease)) return;
      const message = error instanceof ApiError ? error.message : "작업 목록 필터를 불러오지 못했습니다.";
      showToast(message, "info");
    } finally {
      if (jobsFilterRequests.current.complete(lease)) setJobsLoading(false);
    }
  };

  return { filterJobs, refreshData };
}
