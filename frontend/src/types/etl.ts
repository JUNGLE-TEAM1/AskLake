export type JobStatus = "scheduled" | "failed" | "running" | "paused" | "canceled";
export type JobCommand = "edit" | "run" | "retry" | "pause" | "cancel" | "delete";
export type TargetLayer = "RAW" | "BRONZE" | "SILVER" | "GOLD";
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
  sourceConfig?: Array<[string, string]>;
  sourceLabel?: string;
  sourceType?: string;
  targetFormat?: string;
  targetLayer?: TargetLayer;
  targetPath?: string;
  transformOutputColumns?: Array<[string, string]>;
  transformSteps?: TransformStepDraft[];
  qualityInvalidRows?: string[][];
  qualityRules?: QualityRuleDraft[];
  qualityScore?: number;
  qualityStatus?: QualityDraft["status"];
  lastRun: string;
  lastState: string;
  nextRun: string;
  progress?: {
    label: string;
    value: number;
  };
  stats?: JobStats;
  runHistory?: JobRunSummary[];
  dagSteps?: JobDagStep[];
};

export type JobStats = {
  averageDuration: string;
  currentStage: string;
  inputRows: string;
  lastSuccess: string;
  outputRows: string;
  outputPath?: string;
  sampleScope: string;
  schemaColumns: string;
  sourceUnits: string;
  successRate: string;
  totalRuns: string;
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
  input: string;
  kind: "rename" | "cast" | "trim" | "jsonPath" | "mask" | "derive";
  label: string;
  onError: string;
  operation: string;
  output: string;
  params: string;
};

export type TransformDraft = {
  outputColumns: Array<[string, string]>;
  steps: TransformStepDraft[];
  summary: string;
};

export type QualityRuleDraft = {
  enabled: boolean;
  failureAction: "Warn" | "Quarantine" | "Fail Run" | "Drop Row" | "Set Null";
  id: string;
  kind: "notNull" | "range" | "acceptedValues" | "regex" | "unique";
  severity: "Warning" | "Error";
  targetColumn: string;
  validationType: "Not Null" | "Range Check" | "Regex Match" | "Accepted Values";
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
  schemaColumns: SchemaColumnDraft[];
  schemaFingerprint?: string;
  schemaSampleRows: string[][];
  sourceConfig: Array<[string, string]>;
  sourceType: string;
  sourceLabel: string;
  schemaSummary: string;
  ruleSummary: string;
  transformOutputColumns: Array<[string, string]>;
  transformSteps: TransformStepDraft[];
  qualityInvalidRows: string[][];
  qualityRules: QualityRuleDraft[];
  qualityScore?: number;
  qualityStatus: QualityDraft["status"];
  scheduleLabel: string;
  retryPolicy: RetryPolicyDraft;
  retryPolicySummary: string;
  scheduleSummary?: string;
  startDate?: string;
  endDate?: string;
  timezone?: string;
  permissionSummary: string;
  storageType?: "S3" | "Local" | "HDFS";
  partition?: string;
  compression?: "Snappy" | "Gzip" | "None";
  storagePath?: string;
  targetDataset: string;
  targetLayer: TargetLayer;
  targetFormat: string;
  owner: string;
  rag: boolean;
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

export type JobRunSummary = {
  duration: string;
  endedAt: string;
  errorSummary: string;
  failedStage: string;
  inputRows: string;
  outputRows: string;
  outputPath?: string;
  runId: string;
  startedAt: string;
  status: JobRunStatus;
};

export type JobDagStep = {
  details?: Array<[string, string]>;
  id: string;
  logs?: string[];
  meta: string;
  note?: string;
  status: JobDagStepStatus;
  title: string;
};

export type JobExecutionEvidence = {
  dagSteps: JobDagStep[];
  runs: JobRunSummary[];
};

export type RunsByJobId = Record<string, JobRunSummary[]>;
export type SelectedRunIdByJobId = Record<string, string>;
export type DagStepsByRunId = Record<string, JobDagStep[]>;
