import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";

import { getJob as getPipelineJob } from "../../services/pipelineApi";
import type { FlowId, JobRowData } from "../../types";
import { normalizeJobRow } from "./jobState";
import { mergeJobDetailWithCurrentStatus } from "./snapshotStatusState";


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
  const matchedJob = jobId ? jobs.find((job) => job.id === jobId) : undefined;
  const matchedJobId = matchedJob?.id;

  useEffect(() => {
    if (!jobId) return;
    const nextJob = matchedJob ?? buildMissingJobFromRoute(jobId);
    setSelectedJob((job) => (
      job === nextJob || (job.id === nextJob.id && job.tag !== "Missing")
        ? job
        : nextJob
    ));
  }, [jobId, jobs, matchedJob, setSelectedJob]);

  useEffect(() => {
    let cancelled = false;
    const needsFullJobDetail = matchedJobId
      && (flow === "jobDetail" || flow === "jobRuns");
    if (needsFullJobDetail) {
      void getPipelineJob(matchedJobId)
        .then((detail) => {
          if (cancelled) return;
          const normalizedDetail = normalizeJobRow(detail);
          setSelectedJob((job) => (
            job.id === normalizedDetail.id
              ? mergeJobDetailWithCurrentStatus(job, normalizedDetail)
              : job
          ));
        })
        .catch(() => {
          // Keep the list summary visible; an explicit edit or refresh can retry detail hydration.
        });
    }

    return () => {
      cancelled = true;
    };
  }, [flow, matchedJobId, setSelectedJob]);
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
