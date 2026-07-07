export type JobStatus = "scheduled" | "failed" | "running" | "paused" | "canceled" | "stopped";
export type JobCommand = "edit" | "run" | "retry" | "pause" | "cancelRun" | "stopSchedule" | "delete";
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
  schedulePolicy?: SchedulePolicyDraft;
  scheduleSummary?: string;
  sourceConfig?: Array<[string, string]>;
  sourceLabel?: string;
  sourceType?: string;
  retryPolicy?: RetryPolicyDraft;
  retryPolicySummary?: string;
  runLimitSummary?: string;
  permissionRoles?: PermissionDraft["roles"];
  compression?: "Snappy" | "Gzip" | "None";
  partition?: string;
  storagePath?: string;
  storageType?: "S3" | "Local" | "HDFS";
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
  dagStepsByRunId?: Record<string, JobDagStep[]>;
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
  included?: boolean;
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
  endDate?: string;
  label: string;
  mode: "manual" | "repeat";
  nextRun?: string;
  nextRunUtc?: string;
  overlapPolicy?: ScheduleOverlapPolicy;
  retryPolicy: RetryPolicyDraft;
  startDate?: string;
  summary?: string;
  timezone?: string;
  watermarkPolicy?: WatermarkPolicyDraft;
};

export type SchedulePolicyDraft = {
  endDate?: string;
  nextRunUtc?: string;
  overlapPolicy?: ScheduleOverlapPolicy;
  startDate?: string;
  timezone?: string;
  watermarkPolicy?: WatermarkPolicyDraft;
};

export type RetryFailureAction = "retry_then_fail" | "retry_then_quarantine" | "notify_only";
export type RetryBackoffStrategy = "fixed" | "exponential";
export type ScheduleOverlapPolicy = "skip_if_running" | "queue_after_current" | "allow_parallel";
export type WatermarkWindowMode = "last_success_to_scheduled_at" | "last_success_to_run_started_at" | "full_refresh";

export type RetryPolicyDraft = {
  backoffMultiplier: number;
  backoffStrategy: RetryBackoffStrategy;
  failureAction: RetryFailureAction;
  initialRetryDelayMinutes: number;
  maxRetries: number;
  maxRetryDelayMinutes: number;
  retryIntervalMinutes: number;
  timeoutMinutes: number;
};

export type WatermarkPolicyDraft = {
  column: string;
  enabled: boolean;
  lookbackMinutes: number;
  mode: WatermarkWindowMode;
};

export type PermissionDraft = {
  owner: string;
  roles?: Array<{
    access: string[];
    checked: boolean;
    name: string;
  }>;
  summary: string;
};

export type TargetDraft = {
  compression?: "Snappy" | "Gzip" | "None";
  datasetName: string;
  format: string;
  layer: TargetLayer;
  partition?: string;
  rag: boolean;
  storagePath?: string;
  storageType?: "S3" | "Local" | "HDFS";
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
  runLimitSummary: string;
  scheduleSummary?: string;
  startDate?: string;
  endDate?: string;
  nextRunUtc?: string;
  overlapPolicy?: ScheduleOverlapPolicy;
  timezone?: string;
  watermarkPolicy?: WatermarkPolicyDraft;
  permissionSummary: string;
  permissionRoles?: PermissionDraft["roles"];
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
