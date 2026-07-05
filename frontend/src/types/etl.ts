export type JobStatus = "scheduled" | "failed" | "running" | "paused" | "canceled";
export type JobCommand = "edit" | "run" | "retry" | "pause" | "cancel" | "delete";
export type JobRunStatus = "queued" | "running" | "success" | "failed" | "canceled";
export type JobDagStepStatus = "pending" | "running" | "success" | "failed" | "blocked";

export type JobRowData = {
  status: JobStatus;
  name: string;
  id: string;
  owner: string;
  tag: string;
  source: string;
  target: string;
  schedule: string;
  lastRun: string;
  lastState: string;
  nextRun: string;
  progress?: {
    label: string;
    value: number;
  };
};

export type DraftPipeline = {
  id: string;
  jobName: string;
  sourceConfig: Array<[string, string]>;
  sourceType: string;
  sourceLabel: string;
  schemaSummary: string;
  ruleSummary: string;
  scheduleLabel: string;
  scheduleSummary: string;
  startDate: string;
  endDate?: string;
  timezone: string;
  permissionSummary: string;
  storageType: "S3" | "Local" | "HDFS";
  partition: string;
  compression: "Snappy" | "Gzip" | "None";
  storagePath: string;
  targetDataset: string;
  targetLayer: "RAW" | "BRONZE" | "SILVER" | "GOLD";
  targetFormat: string;
  owner: string;
  rag: boolean;
};

export type JobRunSummary = {
  duration: string;
  endedAt: string;
  errorSummary: string;
  failedStage: string;
  inputRows: string;
  outputRows: string;
  runId: string;
  startedAt: string;
  status: JobRunStatus;
};

export type JobDagStep = {
  id: string;
  meta: string;
  note?: string;
  status: JobDagStepStatus;
  title: string;
};

export type JobExecutionEvidence = {
  dagSteps: JobDagStep[];
  runs: JobRunSummary[];
};
