import type { IdentityProfile } from "./identity";
import type { PermissionGrant, ResourcePermissions } from "./permissions";

export type JobStatus = "scheduled" | "failed" | "running" | "paused" | "canceled" | "stopped";
export type JobScheduleKind = "daily" | "weekly" | "monthly" | "realtime" | "none" | "other";
export type JobCommand = "edit" | "run" | "retry" | "pause" | "cancelRun" | "stopSchedule" | "resumeSchedule" | "startContinuous" | "pauseContinuous" | "resumeContinuous" | "stopContinuous" | "delete";
export type KafkaExecutionMode = "snapshot" | "continuous";
export type ContinuousRuntimeStatus = "starting" | "running" | "pausing" | "paused" | "stopping" | "stopped" | "failed";
export type ContinuousDesiredRuntimeState = "running" | "paused" | "stopped";
export type ContinuousObservedRuntimeState = "unknown" | "starting" | "running" | "stopping" | "stopped" | "failed";
export type ContinuousRuntimeErrorStage = "validation" | "runtime_storage" | "submission" | "execution" | "report" | "checkpoint" | "materialization" | "catalog" | "dashboard_publication" | "reconciliation";

export type ContinuousRuntimeErrorDetail = {
  stage: ContinuousRuntimeErrorStage;
  code: string;
  message: string;
  retryable: boolean;
  context?: Record<string, unknown> | null;
  diagnosticId?: string | null;
  operatorMessage?: string | null;
  userMessage?: string | null;
};

export type KafkaSchemaEvolutionPolicy = {
  additiveNullable: "allow" | "quarantine" | "pause";
  missingRequired: "quarantine" | "pause";
  incompatibleType: "quarantine" | "pause";
  unknownField: "preserve" | "ignore" | "quarantine" | "pause";
};

export type KafkaContinuousConfigDraft = {
  initialOffsetPolicy: "earliest" | "latest";
  triggerIntervalSeconds: number;
  maxOffsetsPerTrigger: number;
  schemaEvolutionPolicy?: KafkaSchemaEvolutionPolicy;
};

export type KafkaContinuousRuntime = {
  status: ContinuousRuntimeStatus;
  desiredState?: ContinuousDesiredRuntimeState;
  observedState?: ContinuousObservedRuntimeState;
  stateRevision?: number;
  fencingToken?: string | null;
  errorDetail?: ContinuousRuntimeErrorDetail | null;
  checkpointPath: string;
  heartbeatAt?: string | null;
  lastFlushAt?: string | null;
  lastBatchId?: string | null;
  lag?: number | null;
  maxPartitionLag?: number | null;
  laggingPartitionCount: number;
  lagAvailable: boolean;
  partitionProgress: Record<string, { processedOffset: number; latestOffset: number; lag: number }>;
  lastBatchDurationMs?: number | null;
  lastBatchInputRows: number;
  throughputRowsPerSecond?: number | null;
  schemaVersion: number;
  schemaFingerprint?: string | null;
  schemaStatus: string;
  schemaChanges: Array<Record<string, unknown>>;
  ruleContractVersion: string;
  ruleFingerprint?: string | null;
  runtimeFingerprint?: string | null;
  ruleMetrics: Record<string, number>;
  lastRuleResult: Record<string, unknown>;
  consumedCount: number;
  storedCount: number;
  quarantinedCount: number;
  replayedCount: number;
  failedCount: number;
  lastError?: string | null;
};

export type ContinuousWorkerLogsResponse = {
  jobId: string;
  containerState: string;
  lines: string[];
  truncated: boolean;
};

export type KafkaContinuousSessionStatus = "starting" | "running" | "stopping" | "stopped" | "failed";

export type KafkaContinuousSession = {
  sessionId: string;
  jobId: string;
  workerAttemptId?: string | null;
  status: KafkaContinuousSessionStatus;
  startedAt: string;
  endedAt?: string | null;
  endReason?: string | null;
  consumedCount: number;
  storedCount: number;
  quarantinedCount: number;
  failedCount: number;
  lastBatchId?: string | null;
  lastFlushAt?: string | null;
  lag?: number | null;
  checkpointPath: string;
  lastError?: string | null;
  dagSteps: JobDagStep[];
};

export type KafkaContinuousBatch = {
  batchId: number;
  sessionId: string;
  status: "running" | "success" | "failed";
  publishedAt?: string | null;
  consumedCount: number;
  storedCount: number;
  quarantinedCount: number;
  durationMs?: number | null;
  sourceRanges: Array<{
    topic?: string;
    partition?: number;
    startOffset?: number;
    endOffset?: number;
  }>;
  dataPath?: string | null;
  quarantinePath?: string | null;
  manifestPath?: string | null;
  lastError?: string | null;
  dagSteps: JobDagStep[];
};

export type ContinuousQuarantineRecord = {
  topic: string;
  partition: number;
  offset: number;
  rawPayload: string;
  reason: string;
  schemaFingerprint?: string | null;
  ruleFingerprint?: string | null;
  ruleId?: string | null;
  stage?: string | null;
  targetColumn?: string | null;
  quarantinedAt?: string | null;
  replayStatus: string;
};

export type ContinuousQuarantineResponse = {
  jobId: string;
  records: ContinuousQuarantineRecord[];
  total: number;
};

export type ContinuousMaintenanceRun = {
  runId: string;
  jobId: string;
  kind: "quarantine_replay" | "compaction";
  status: "queued" | "running" | "success" | "failed";
  requestedBy: string;
  config: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  startedAt?: string | null;
  endedAt?: string | null;
  lastError?: string | null;
};
export type TargetLayer = "RAW" | "BRONZE" | "SILVER" | "GOLD";
export type JobRunStatus = "queued" | "running" | "success" | "failed" | "canceled";
export type JobRunOutcome = "success" | "failed" | "canceled";
export type JobDagStepStatus = "pending" | "running" | "success" | "failed" | "blocked";
export type RealtimeOperationalHealth = "healthy" | "degraded" | "unhealthy" | "unknown";

export type BatchOperationalMetrics = {
  metricType: "batch";
  windowFrom: string;
  windowTo: string;
  totalRuns: number;
  successfulRuns: number;
  successRate: number | null;
  averageDurationMs: number | null;
};

export type RealtimeOperationalMetrics = {
  metricType: "realtime";
  windowFrom: string;
  windowTo: string;
  healthStatus: RealtimeOperationalHealth;
  availabilityRate: number | null;
  consumerLag: number | null;
  processingDelayMs: number | null;
  lastHeartbeatAt: string | null;
  lastCheckpointAt: string | null;
  restartCount: number;
  errorRate: number | null;
};

export type JobOperationalMetrics = BatchOperationalMetrics | RealtimeOperationalMetrics;

export type JobRowData = {
  createdAt?: string;
  status: JobStatus;
  name: string;
  id: string;
  owner: string;
  ownerAvatarUrl?: string;
  createdBy?: string;
  createdByProfile?: IdentityProfile;
  permissionGrants?: PermissionGrant[];
  permissions?: ResourcePermissions;
  tag: string;
  source: string;
  target: string;
  updatedAt?: string | null;
  schedule: string;
  schedulePolicy?: SchedulePolicyDraft;
  scheduleSummary?: string;
  sourceConfig?: Array<[string, string]>;
  sourceLabel?: string;
  sourceType?: string;
  executionMode?: KafkaExecutionMode;
  continuousConfig?: KafkaContinuousConfigDraft & { checkpointPath?: string };
  continuousRuntime?: KafkaContinuousRuntime | null;
  recordParsing?: RecordParsingDraft;
  schemaColumns?: SchemaColumnDraft[];
  schemaFingerprint?: string;
  schemaSampleRows?: string[][];
  schemaSummary?: string;
  ruleSummary?: string;
  ruleContractVersion?: "1.0";
  rules?: CanonicalRuleDraft[];
  ruleCompilation?: RuleCompilationResult;
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
  schemaSampleValues?: Record<string, string>;
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
  operationalMetrics?: JobOperationalMetrics;
  progress?: {
    label: string;
    value: number;
  };
  stats?: JobStats;
  runHistory?: JobRunSummary[];
  dagSteps?: JobDagStep[];
  dagStepsByRunId?: Record<string, JobDagStep[]>;
};

export type JobListQuery = {
  lastRunOutcome?: JobRunOutcome;
  owner?: string;
  scheduleKind?: JobScheduleKind;
  statuses?: JobStatus[];
};

export type JobListFacets = {
  latestRunOutcomeCounts: Record<JobRunOutcome, number>;
  owners: string[];
  statusCounts: Record<JobStatus, number>;
  total: number;
};

export type JobListResult = {
  facets: JobListFacets;
  jobs: JobRowData[];
};

export type JobStatusSnapshot = {
  id: string;
  status: JobStatus;
  progress?: {
    label: string;
    value: number;
  } | null;
  lastRun: string;
  lastState: string;
  nextRun: string;
  updatedAt?: string | null;
  latestRun?: JobRunSummary | null;
  dagSteps: JobDagStep[];
};

export type JobStatusListResult = {
  jobs: JobStatusSnapshot[];
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
  executionMode?: KafkaExecutionMode;
  continuousConfig?: KafkaContinuousConfigDraft;
  detectedFormat?: string;
  rawPreviewLines?: string[];
  requiresRecordParsing?: boolean;
};

export type RecordParsingColumnDraft = {
  position: number;
  name: string;
  inferredType: "String" | "Integer" | "Float" | "Boolean" | "Timestamp";
};

export type RecordParsingDraft = {
  enabled: boolean;
  delimiterKind: "whitespace";
  delimiterPattern: "\\s+";
  header: boolean;
  expectedFieldCount: number;
  columns: RecordParsingColumnDraft[];
};

export type RecordParsingInvalidRow = {
  lineNumber: number;
  expectedFieldCount: number;
  actualFieldCount: number;
  rawPreview: string;
};

export type RecordParsingPreviewResponse = {
  canApply: boolean;
  columns: SchemaColumnDraft[];
  sampleRows: string[][];
  recordParsing: RecordParsingDraft;
  totalRows: number;
  validRows: number;
  invalidRows: RecordParsingInvalidRow[];
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
  reviewAnalysisAllowedValues?: string[];
  reviewAnalysisFallbackAllowed?: boolean;
  reviewAnalysisInstruction?: string;
  reviewAnalysisMethod?: string;
  reviewAnalysisModelArtifact?: string;
  reviewAnalysisModelId?: string;
  reviewAnalysisModelSelectionPolicy?: string;
  reviewAnalysisRequireModel?: boolean;
  role?: string;
  sourceName: string;
  sourceType?: string;
  targetName: string;
  targetOrder?: number;
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
  canonicalParameters?: Record<string, unknown>;
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
  canonicalParameters?: Record<string, unknown>;
  enabled: boolean;
  failureAction: "Warn" | "Quarantine" | "Fail Run" | "Drop Row" | "Set Null";
  id: string;
  kind: "notNull" | "range" | "acceptedValues" | "regex" | "unique";
  params?: string;
  severity: "Warning" | "Error";
  targetColumn: string;
  validationType: "Not Null" | "Range Check" | "Regex Match" | "Accepted Values";
};

export type CanonicalRuleOperation =
  | "accepted_values"
  | "cast"
  | "copy"
  | "custom_csv_classifier"
  | "default_value"
  | "json_extract"
  | "lowercase_trim"
  | "mask"
  | "not_null"
  | "null_guard"
  | "parse_timestamp"
  | "range"
  | "regex"
  | "rename"
  | "sql_expression"
  | "sql_result_materialize"
  | "text_row_analysis"
  | "unique";

export type CanonicalRuleDraft = {
  contractVersion: "1.0";
  enabled: boolean;
  failureDisposition: "keep" | "drop_row" | "set_null";
  id: string;
  inputColumns: string[];
  kind: "transform" | "quality";
  label?: string;
  onError: "fail_batch" | "quarantine" | "warn";
  operation: CanonicalRuleOperation | string;
  outputColumns: string[];
  outputType?: string;
  parameters: Record<string, unknown>;
  severity?: "warning" | "error";
};

export type RuleCompilationIssue = {
  code: string;
  field?: string;
  message: string;
  ruleId?: string;
};

export type RuleCompilationResult = {
  contractVersion: "1.0";
  issues: RuleCompilationIssue[];
  outputSchema: Array<[string, string]>;
  rules: CanonicalRuleDraft[];
  status: "pass" | "fail";
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
  grants?: PermissionGrant[];
  owner: string;
  roles?: Array<{
    access: string[];
    checked: boolean;
    name: string;
    principalId?: string;
    principalType?: "group" | "public" | "role" | "user";
  }>;
  summary: string;
  template?: string;
  visibility?: "조직 내부" | "프로젝트 멤버" | "외부 공유";
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
  recordParsing: RecordParsingDraft;
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
  ruleContractVersion: "1.0";
  rules: CanonicalRuleDraft[];
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
  executionMode?: KafkaExecutionMode;
  continuousConfig?: KafkaContinuousConfigDraft;
  recordParsing?: RecordParsingDraft;
};

export type UpdatePipelineRequest = Omit<
  CreatePipelineRequest,
  | "id"
  | "sourceConfig"
  | "sourceLabel"
  | "sourceType"
  | "executionMode"
  | "continuousConfig"
  | "recordParsing"
  | "createdBy"
  | "createdByProfile"
>;

export type DraftPipelineSlicePatch = {
  id?: string;
  permission?: Partial<PermissionDraft>;
  quality?: Partial<QualityDraft>;
  recordParsing?: Partial<RecordParsingDraft>;
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
  inputBytes?: number;
  inputFileCount?: number;
  inputRows: string;
  outputFileCount?: number;
  outputRows: string;
  outputPath?: string;
  runId: string;
  startedAt: string;
  status: JobRunStatus;
  syncError?: string;
  taskStates?: Record<string, unknown>;
  textStructuring?: TextStructuringColumnExecution[];
  textStructuringExecution?: TextStructuringExecutionSummary;
};

export type TextStructuringColumnExecution = {
  allowedValues?: string[];
  distinctOutputValues?: number;
  distributionWarning?: string;
  executionMode?: string;
  fallbackAllowed?: boolean;
  fallbackUsed?: boolean;
  invalidRows?: number;
  method?: string;
  metrics?: {
    accuracy?: number;
    macroF1?: number;
    validationRows?: number;
    [key: string]: unknown;
  };
  modelArtifact?: string;
  modelRequired?: boolean;
  modelSelectionPolicy?: string;
  outputDistribution?: Array<{ count: number; value: string }>;
  runtimeStatus?: string;
  selectedModelArtifact?: string;
  target?: string;
  targetColumn?: string;
  validationStatus?: string;
  validationRows?: number;
};

export type TextStructuringExecutionSummary = {
  columns: TextStructuringColumnExecution[];
  fallbackColumns: string[];
  modelColumns: string[];
  missingModelColumns: string[];
  oneOfValueColumns: number;
  totalColumns: number;
};

export type JobDagStep = {
  completedAt?: string;
  details?: Array<[string, string]>;
  duration?: string;
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
