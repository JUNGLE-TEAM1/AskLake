export type JobStatus = "scheduled" | "failed" | "running" | "paused" | "canceled";
export type JobCommand = "edit" | "run" | "retry" | "pause" | "cancel" | "delete";
export type JobRunStatus = "queued" | "running" | "success" | "failed" | "canceled";
export type JobDagStepStatus = "pending" | "running" | "success" | "failed" | "blocked";
export type TargetLayer = "RAW" | "BRONZE" | "SILVER" | "GOLD";

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

export type SourceDraft = {
  connectionMessage?: string;
  connectionStatus: "idle" | "testing" | "success" | "failed";
  sourceConfig: Array<[string, string]>;
  sourceLabel: string;
  sourceType: string;
};

export type SchemaColumnDraft = {
  confidence?: number;
  nullable: boolean;
  role?: string;
  sourceName: string;
  targetName: string;
  type: string;
};

export type SchemaDraft = {
  columns: SchemaColumnDraft[];
  sampleRows: string[][];
  schemaFingerprint?: string;
  summary: string;
};

export type TransformStepDraft = {
  enabled: boolean;
  id: string;
  kind: "rename" | "cast" | "trim" | "jsonPath" | "mask" | "derive";
  label: string;
};

export type TransformDraft = {
  outputColumns: Array<[string, string]>;
  steps: TransformStepDraft[];
  summary: string;
};

export type QualityRuleDraft = {
  enabled: boolean;
  id: string;
  kind: "notNull" | "range" | "acceptedValues" | "regex" | "unique";
  targetColumn: string;
};

export type QualityDraft = {
  invalidRows: string[][];
  rules: QualityRuleDraft[];
  score?: number;
  status: "idle" | "pass" | "warn" | "fail";
  summary: string;
};

export type ScheduleDraft = {
  label: string;
  mode: "manual" | "once" | "repeat";
  nextRun?: string;
  retryPolicy: RetryPolicyDraft;
};

export type RetryFailureAction = "retry_then_fail" | "retry_then_quarantine" | "notify_only";

export type RetryPolicyDraft = {
  failureAction: RetryFailureAction;
  maxRetries: number;
  retryIntervalMinutes: number;
  timeoutMinutes: number;
};

export type PermissionDraft = {
  owner: string;
  summary: string;
};

export type TargetDraft = {
  datasetName: string;
  format: string;
  layer: TargetLayer;
  rag: boolean;
};

export type DraftPipeline = {
  id: string;
  permission: PermissionDraft;
  quality: QualityDraft;
  schedule: ScheduleDraft;
  schema: SchemaDraft;
  source: SourceDraft;
  target: TargetDraft;
  transform: TransformDraft;
};

export type CreatePipelineRequest = {
  id: string;
  jobName: string;
  sourceConfig: Array<[string, string]>;
  sourceType: string;
  sourceLabel: string;
  schemaSummary: string;
  ruleSummary: string;
  scheduleLabel: string;
  retryPolicy: RetryPolicyDraft;
  retryPolicySummary: string;
  permissionSummary: string;
  targetDataset: string;
  targetLayer: TargetLayer;
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

export type DraftPipelineSlicePatch = {
  id?: string;
  permission?: Partial<PermissionDraft>;
  quality?: Partial<QualityDraft>;
  schedule?: Partial<ScheduleDraft>;
  schema?: Partial<SchemaDraft>;
  source?: Partial<SourceDraft>;
  target?: Partial<TargetDraft>;
  transform?: Partial<TransformDraft>;
};

export type DraftPipelinePatch = DraftPipelineSlicePatch & Partial<CreatePipelineRequest>;
