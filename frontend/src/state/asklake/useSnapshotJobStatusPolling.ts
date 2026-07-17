import { useEffect, useRef } from "react";

import { apiConfig } from "../../services/apiClient";
import { getJobStatuses } from "../../services/pipelineApi";
import type { JobStatusSnapshot } from "../../types";
import { moveJobFacetCounts, upsertRunByRunId } from "./jobState";
import {
  activeSnapshotJobIds,
  mergeJobStatusSnapshot,
  shouldApplyJobStatusSnapshot,
  snapshotStatusPollDelayMs,
} from "./snapshotStatusState";
import type { AskLakeWorkspaceState } from "./useAskLakeWorkspaceState";


export function useSnapshotJobStatusPolling({
  enabled,
  showToast,
  state,
}: {
  enabled: boolean;
  showToast: (message: string, tone?: "success" | "info") => void;
  state: AskLakeWorkspaceState;
}) {
  const {
    jobs,
    runsByJobId,
    setDagStepsByRunId,
    setJobListFacets,
    setJobs,
    setRunsByJobId,
    setSelectedJob,
  } = state;
  const jobsRef = useRef(jobs);
  const showToastRef = useRef(showToast);
  jobsRef.current = jobs;
  showToastRef.current = showToast;

  const activeJobIds = activeSnapshotJobIds(jobs, runsByJobId);
  const activeJobKey = activeJobIds.join("\u0000");

  useEffect(() => {
    if (!enabled || apiConfig.useMock || activeJobIds.length === 0) return;

    let cancelled = false;
    let consecutiveErrors = 0;
    let failureNoticeShown = false;
    let inFlight = false;
    let timer: number | undefined;

    const clearTimer = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    };
    const schedule = (delay: number) => {
      clearTimer();
      if (!cancelled && document.visibilityState !== "hidden") {
        timer = window.setTimeout(() => void poll(), delay);
      }
    };
    const applySnapshots = (snapshots: JobStatusSnapshot[]) => {
      const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
      const currentJobs = jobsRef.current;
      const acceptedSnapshots = snapshots.filter((snapshot) => {
        const current = currentJobs.find((job) => job.id === snapshot.id);
        return current ? shouldApplyJobStatusSnapshot(current, snapshot) : false;
      });
      if (acceptedSnapshots.length === 0) return;

      const nextJobs = currentJobs.map((job) => {
        const snapshot = snapshotsById.get(job.id);
        return snapshot ? mergeJobStatusSnapshot(job, snapshot) : job;
      });
      jobsRef.current = nextJobs;
      setJobs(nextJobs);
      setSelectedJob((job) => {
        const snapshot = snapshotsById.get(job.id);
        return snapshot ? mergeJobStatusSnapshot(job, snapshot) : job;
      });
      setJobListFacets((facets) => acceptedSnapshots.reduce((nextFacets, snapshot) => {
        const previousJob = currentJobs.find((job) => job.id === snapshot.id);
        if (!previousJob) return nextFacets;
        return moveJobFacetCounts(nextFacets, previousJob, mergeJobStatusSnapshot(previousJob, snapshot));
      }, facets));
      setRunsByJobId((currentRuns) => {
        const nextRuns = { ...currentRuns };
        acceptedSnapshots.forEach((snapshot) => {
          if (!snapshot.latestRun) return;
          nextRuns[snapshot.id] = upsertRunByRunId(nextRuns[snapshot.id] ?? [], snapshot.latestRun);
        });
        return nextRuns;
      });
      setDagStepsByRunId((currentSteps) => {
        const nextSteps = { ...currentSteps };
        acceptedSnapshots.forEach((snapshot) => {
          if (snapshot.latestRun && snapshot.dagSteps.length > 0) {
            nextSteps[snapshot.latestRun.runId] = snapshot.dagSteps;
          }
        });
        return nextSteps;
      });
    };
    const poll = async () => {
      if (cancelled || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const response = await getJobStatuses(activeJobIds);
        if (cancelled) return;
        applySnapshots(response.jobs);
        consecutiveErrors = 0;
        failureNoticeShown = false;
      } catch {
        consecutiveErrors += 1;
        if (consecutiveErrors >= 3 && !failureNoticeShown) {
          failureNoticeShown = true;
          showToastRef.current("작업 상태 확인이 잠시 지연되고 있습니다. 자동으로 다시 시도합니다.", "info");
        }
      } finally {
        inFlight = false;
        schedule(snapshotStatusPollDelayMs(consecutiveErrors));
      }
    };
    const handleVisibilityChange = () => {
      clearTimer();
      if (document.visibilityState !== "hidden") void poll();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    void poll();
    return () => {
      cancelled = true;
      clearTimer();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [activeJobKey, enabled]);
}
