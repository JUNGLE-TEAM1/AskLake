export type JobStatus = "scheduled" | "failed" | "running" | "paused" | "canceled";
export type JobCommand = "edit" | "run" | "retry" | "pause" | "cancel" | "delete";

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
  permissionSummary: string;
  targetDataset: string;
  targetLayer: "RAW" | "BRONZE" | "SILVER" | "GOLD";
  targetFormat: string;
  owner: string;
  rag: boolean;
};
