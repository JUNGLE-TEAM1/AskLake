import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";

import { apiConfig } from "../../services/apiClient";
import { getJob as getPipelineJob } from "../../services/pipelineApi";
import type { FlowId, JobRowData } from "../../types";
import { normalizeJobRow } from "./jobState";


export function useJobRouteHydration({
  flow,
  jobId,
  jobs,
  setSelectedJob,
}: {
  flow: FlowId;
  jobId?: string;
  jobs: JobRowData[];
  setSelectedJob: Dispatch<SetStateAction<JobRowData>>;
}) {
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    const matchedJob = jobs.find((job) => job.id === jobId);
    const nextJob = matchedJob ?? buildMissingJobFromRoute(jobId);
    setSelectedJob((job) => (
      job === nextJob || (job.id === nextJob.id && job.name === nextJob.name && job.lastState === nextJob.lastState)
        ? job
        : nextJob
    ));

    const needsFullJobDetail = matchedJob
      && !apiConfig.useMock
      && (flow === "jobDetail" || flow === "jobRuns");
    if (needsFullJobDetail) {
      void getPipelineJob(jobId)
        .then((detail) => {
          if (cancelled) return;
          const normalizedDetail = normalizeJobRow(detail);
          setSelectedJob((job) => job.id === normalizedDetail.id ? normalizedDetail : job);
        })
        .catch(() => {
          // Keep the list summary visible; an explicit edit or refresh can retry detail hydration.
        });
    }

    return () => {
      cancelled = true;
    };
  }, [flow, jobId, jobs, setSelectedJob]);
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
