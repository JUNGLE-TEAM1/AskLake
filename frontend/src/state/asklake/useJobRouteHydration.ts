import { useEffect } from "react";
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

  useEffect(() => {
    let cancelled = false;
    const needsFullJobDetail = jobId
      && !apiConfig.useMock
      && (flow === "jobDetail" || flow === "jobRuns");
    if (needsFullJobDetail) {
      if (matchedJob) setSelectedJob(matchedJob);
      void getPipelineJob(jobId)
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
          if (cancelled || !(error instanceof Error) || !error.message.includes("404")) return;
          setSelectedJob(buildMissingJobFromRoute(jobId));
        });
    } else if (jobId && matchedJob) {
      setSelectedJob(matchedJob);
    }

    return () => {
      cancelled = true;
    };
  }, [flow, jobId, matchedJob, setJobs, setSelectedJob]);
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
