import type { IdentityProfile } from "./identity";
import type { PermissionGrant, ResourcePermissions } from "./permissions";

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
  createdBy?: string;
  createdByProfile?: IdentityProfile;
  permissionGrants?: PermissionGrant[];
  permissions?: ResourcePermissions;
  tag: string;
  source: string;
  target: string;
  schedule: string;
  schedulePolicy?: SchedulePolicyDraft;
  scheduleSummary?: string;
  sourceConfig?: Array<[string, string]>;
  sourceLabel?: string;
  sourceType?: string;
  schemaColumns?: SchemaColumnDraft[];
  schemaFingerprint?: string;
  schemaSampleRows?: string[][];
  schemaSummary?: string;
  ruleSummary?: string;
  retryPolicy?: RetryPolicyDraft;
  retryPolicySummary?: string;
  runLimitSummary?: string;
  permissionRoles?: PermissionDraft["roles"];
  permissionSummary?: string;
  compression?: "Snappy" | "Gzip" | "None";
  partition?: string;
  partitionColumns?: string[];
  indexColumns?: string[];
  storagePath?: string;
  storageType?: "S3" | "Local" | "HDFS";
  targetDatabase?: string;
  targetDescription?: string;
  targetTags?: string[];
  targetFormat?: string;
  targetLayer?: TargetLayer;
  targetPath?: string;
  rag?: boolean;
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
  lastSyncedAt?: string;
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

export type TransformChainStepDraft = {
  display?: string;
  expression?: string;
  onError?: string;
  operation: string;
  params: string;
  type?: string;
};

export type SchemaColumnDraft = {
  confidence?: number;
  expandedFrom?: string;
  expandedIndex?: number;
  expandedTotal?: number;
  included?: boolean;
  nullable: boolean;
  reviewAnalysisInstruction?: string;
  reviewAnalysisMethod?: string;
  role?: string;
  sourceName: string;
  targetName: string;
  transformChain?: TransformChainStepDraft[];
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
  params?: string;
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
  databaseName?: string;
  datasetName: string;
  description?: string;
  format: string;
  indexColumns?: string[];
  layer: TargetLayer;
  lastTestRun?: {
    finishedAt?: string;
    logs: string[];
    message?: string;
    status: "idle" | "pending" | "success" | "failed";
  };
  manager?: string;
  owner?: string;
  partition?: string;
  partitionColumns?: string[];
  rag: boolean;
  schemaRules?: Array<{
    indexed: boolean;
    name: string;
    nullable: boolean;
    partitionable: boolean;
    raw?: boolean;
    recommendedIndex: boolean;
    recommendedPartition: boolean;
    sourceName: string;
    type: "string" | "number" | "boolean" | "datetime" | "json";
    use: boolean;
    validationStatus: "valid" | "warning" | "error";
  }>;
  storagePath?: string;
  storageType?: "S3" | "Local" | "HDFS";
  tableName?: string;
  targetTableName?: string;
  tags?: string[];
  testStatus?: "idle" | "success" | "failed";
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
  permissionGrants?: PermissionGrant[];
  createdBy?: string;
  createdByProfile?: IdentityProfile;
  storageType?: "S3" | "Local" | "HDFS";
  partition?: string;
  partitionColumns?: string[];
  indexColumns?: string[];
  compression?: "Snappy" | "Gzip" | "None";
  storagePath?: string;
  targetDataset: string;
  targetDatabase?: string;
  targetDescription?: string;
  targetTags?: string[];
  targetLayer: TargetLayer;
  targetFormat: string;
  owner: string;
  rag: boolean;
};

export type UpdatePipelineRequest = Omit<
  CreatePipelineRequest,
  "id" | "sourceConfig" | "sourceLabel" | "sourceType" | "createdBy" | "createdByProfile" | "permissionGrants"
>;

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
  airflowDagId?: string;
  airflowDagRunId?: string;
  airflowRunUrl?: string;
  airflowState?: string;
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
  syncError?: string;
  taskStates?: Record<string, unknown>;
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
