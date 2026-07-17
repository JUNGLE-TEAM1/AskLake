import { useEffect, useRef } from "react";
import { ApiError } from "../../types";

import { getJobs } from "../../services/mockApi";

import { createResourceQueryKey, LatestRequestGate } from "../../state/requestOwnership";
import type { JobListQuery } from "../../types";
import { getInitialReadErrorMessage, readInitialResource } from "./initialRead";
import { buildRunStateFromJobs, emptySelectedJob, normalizeJobRow } from "./jobState";

import type { AskLakeWorkspaceState } from "./useAskLakeWorkspaceState";

export function useJobsHydration({
  enabled,
  showToast,
  state,
}: {
  enabled: boolean;
  showToast: (message: string, tone?: "success" | "info") => void;
  state: AskLakeWorkspaceState;
}) {
  const {
    setDagStepsByRunId,
    setJobListFacets,
    setJobs,
    setJobsError,
    setJobsLoading,
    setRunsByJobId,
    setSelectedJob,
    setSelectedRunIdByJobId,
  } = state;
  const requests = useRef(new LatestRequestGate());

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

  useEffect(() => {
    if (!enabled) {
      requests.current.invalidate();
      setJobsError(null);
      setJobsLoading(false);
      return;
    }

    let cancelled = false;
    const lease = requests.current.begin(createResourceQueryKey({ resource: "jobs", version: "route-entry" }));

    async function hydrateJobs() {
      setJobsError(null);
      setJobsLoading(true);
      try {
        const result = await readInitialResource(
          getJobs,
          "jobs",
          { facets: state.jobListFacets, jobs: state.jobs },
        );
        if (cancelled || !requests.current.isCurrent(lease)) return;

        if (!result.error) {
          applyHydratedJobs(result.data);
          return;
        }
        if (result.fatal) {
          setJobsError(result.error);
          return;
        }
        showToast("Job 목록을 불러오지 못해 기존 목록을 유지합니다.", "info");
      } finally {
        if (!cancelled && requests.current.complete(lease)) setJobsLoading(false);
      }
    }

    void hydrateJobs();

    return () => {
      cancelled = true;
      requests.current.invalidate();
    };
  }, [enabled]);

  const filterJobs = async (query: JobListQuery) => {
    const lease = requests.current.begin(createResourceQueryKey({ resource: "jobs", params: query as Record<string, unknown>, version: "filtered" }));
    setJobsLoading(true);
    try {
      const result = await getJobs(query);
      if (!requests.current.isCurrent(lease)) return;
      applyHydratedJobs(result);
    } catch (error) {
      if (!requests.current.isCurrent(lease)) return;
      const message = error instanceof ApiError ? error.message : "작업 목록 필터를 불러오지 못했습니다.";
      showToast(message, "info");
    } finally {
      if (requests.current.complete(lease)) setJobsLoading(false);
    }
  };

  const refreshJobs = async () => {
    if (!enabled) return false;
    const lease = requests.current.begin(createResourceQueryKey({ resource: "jobs", version: "manual-refresh" }));
    setJobsError(null);
    setJobsLoading(true);
    try {
      const result = await getJobs();
      if (!requests.current.isCurrent(lease)) return false;
      applyHydratedJobs(result);
      showToast("Job 목록을 새로고침했습니다.");
      return true;
    } catch (error) {
      if (!requests.current.isCurrent(lease)) return false;
      const detail = getInitialReadErrorMessage(error);
      setJobsError(`refresh: ${detail}`);
      showToast(`Job 목록 새로고침 실패: ${detail}`, "info");
      return false;
    } finally {
      if (requests.current.complete(lease)) setJobsLoading(false);
    }
  };

  return { filterJobs, refreshJobs };
}
