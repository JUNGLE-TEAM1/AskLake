import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";

import { apiConfig } from "../../services/apiClient";
import { getJob as getPipelineJob } from "../../services/pipelineApi";
import type { FlowId, JobRowData } from "../../types";
import { normalizeJobRow } from "./jobState";
import { mergeJobDetailWithCurrentStatus } from "./snapshotStatusState";


export function useJobRouteHydration({
  flow,
  jobId,
  jobs,
  setJobs,
  setSelectedJob,
}: {
  flow: FlowId;
  jobId?: string;
  jobs: JobRowData[];
  setJobs: Dispatch<SetStateAction<JobRowData[]>>;
  setSelectedJob: Dispatch<SetStateAction<JobRowData>>;
}) {
  const matchedJob = jobId ? jobs.find((job) => job.id === jobId) : undefined;
  const matchedJobRef = useRef(matchedJob);
  matchedJobRef.current = matchedJob;

  useEffect(() => {
    let cancelled = false;
    const requestController = new AbortController();
    const needsFullJobDetail = jobId
      && !apiConfig.useMock
      && (flow === "jobDetail" || flow === "jobRuns");
    if (needsFullJobDetail) {
      const initialMatchedJob = matchedJobRef.current;
      if (initialMatchedJob) setSelectedJob(initialMatchedJob);
      void getPipelineJob(jobId, { signal: requestController.signal })
        .then((detail) => {
          if (cancelled) return;
          const normalizedDetail = normalizeJobRow(detail);
          setJobs((currentJobs) => {
            const existing = currentJobs.find((job) => job.id === normalizedDetail.id);
            if (!existing) return [...currentJobs, normalizedDetail];
            return currentJobs.map((job) => (
              job.id === normalizedDetail.id
                ? mergeJobDetailWithCurrentStatus(job, normalizedDetail)
                : job
            ));
          });
          setSelectedJob((job) => (
            job.id === normalizedDetail.id || job.id === jobId
              ? mergeJobDetailWithCurrentStatus(job, normalizedDetail)
              : normalizedDetail
          ));
        })
        .catch((error: unknown) => {
          if (requestController.signal.aborted) return;
          if (cancelled || !(error instanceof Error) || !error.message.includes("404")) return;
          setSelectedJob(buildMissingJobFromRoute(jobId));
        });
    }

    return () => {
      cancelled = true;
      requestController.abort();
    };
  }, [flow, jobId, setJobs, setSelectedJob]);

  useEffect(() => {
    const needsFullJobDetail = flow === "jobDetail" || flow === "jobRuns";
    if (!needsFullJobDetail && jobId && matchedJob) {
      setSelectedJob(matchedJob);
    }
  }, [flow, jobId, matchedJob, setSelectedJob]);
}


function buildMissingJobFromRoute(jobId: string): JobRowData {
  return {
    id: jobId,
    lastRun: "-",
    lastState: "목록에서 찾을 수 없음",
    name: "선택한 Job을 찾을 수 없음",
    nextRun: "-",
    owner: "-",
    schedule: "-",
    source: "-",
    status: "paused",
    tag: "Missing",
    target: "-",
  };
}
