import { BarChart3, BookOpen, Bot, Database, Settings, TerminalSquare } from "lucide-react";
import type { CatalogDataset, FlowId, JobDagStep, JobRowData, JobRunSummary, JobStats, NavItem, PermissionDraft, RetryPolicyDraft, TransformStepDraft } from "../types";

export const steps = ["소스", "처리", "스케줄", "권한", "타겟", "검토"];

export const flowTabs: Array<{ id: FlowId; label: string; stepIndex: number }> = [
  { id: "jobs", label: "작업 목록", stepIndex: 0 },
  { id: "jobsTableDemo", label: "표형 데모", stepIndex: 0 },
  { id: "jobDetail", label: "작업 상세", stepIndex: 0 },
  { id: "jobRuns", label: "실행 이력", stepIndex: 0 },
  { id: "source", label: "소스 연결", stepIndex: 0 },
  { id: "schema", label: "스키마 추론", stepIndex: 1 },
  { id: "rules", label: "룰 적용", stepIndex: 1 },
  { id: "repeat", label: "반복 실행", stepIndex: 2 },
  { id: "manual", label: "스케줄링 건너뛰기", stepIndex: 2 },
  { id: "target", label: "타겟 설정", stepIndex: 4 },
  { id: "permission", label: "권한 설정", stepIndex: 3 },
  { id: "review", label: "검토 및 생성", stepIndex: 5 },
];

export const navItems = [
  { id: "ingest", label: "수집/처리", icon: Database, flow: "jobs" },
  { id: "catalog", label: "검색/카탈로그", icon: BookOpen, flow: "catalog" },
  { id: "sql", label: "SQL 분석", icon: TerminalSquare, flow: "sql" },
  { id: "dashboard", label: "대시보드", icon: BarChart3, flow: "dashboard" },
  { id: "ai", label: "AI 활용", icon: Bot, flow: "ai" },
  { id: "admin", label: "관리", icon: Settings, flow: "admin" },
] satisfies NavItem[];

export const ingestFlows: FlowId[] = ["jobs", "jobsTableDemo", "jobDetail", "jobRuns", "source", "schema", "rules", "repeat", "manual", "target", "permission", "review"];
export const jobManagerFlows: FlowId[] = ["jobs", "jobsTableDemo", "jobDetail", "jobRuns"];
export const wizardFlows: FlowId[] = ["source", "schema", "rules", "repeat", "manual", "permission", "target", "review"];

const qaRetryPolicy: RetryPolicyDraft = {
  backoffMultiplier: 2,
  backoffStrategy: "exponential",
  failureAction: "retry_then_fail",
  initialRetryDelayMinutes: 1,
  maxRetries: 3,
  maxRetryDelayMinutes: 30,
  retryIntervalMinutes: 10,
  timeoutMinutes: 60,
};

const qaPermissionRoles: PermissionDraft["roles"] = [
  { access: ["read", "run"], checked: true, name: "Data Platform" },
  { access: ["read"], checked: true, name: "Analytics" },
  { access: ["read"], checked: false, name: "External Partner" },
];

function qaRun({
  duration,
  endedAt,
  errorSummary = "-",
  failedStage = "-",
  inputRows,
  outputRows,
  runId,
  startedAt,
  status,
}: JobRunSummary): JobRunSummary {
  return {
    duration,
    endedAt,
    errorSummary,
    failedStage,
    inputRows,
    outputRows,
    runId,
    startedAt,
    status,
  };
}

function qaDagSteps(
  job: Pick<JobRowData, "source" | "target">,
  states: JobDagStep["status"][],
): JobDagStep[] {
  const labels = [
    ["source-connect", "1. Source 연결", job.source],
    ["source-read", "2. 샘플/파일 읽기", "bounded sample + profile"],
    ["schema-infer", "3. Schema 매핑", "schema fingerprint"],
    ["transform-rules", "4. Transform Rule", "rename/cast/quality"],
    ["validation", "5. Validation", "row count / invalid rows"],
    ["lake-write", "6. Lake 적재", job.target],
    ["quality-check", "7. 품질 체크", "schema + count check"],
    ["catalog-publish", "8. Catalog 반영", "SQL · Dashboard · Catalog"],
  ];

  return labels.map(([id, title, meta], index) => ({
    details: [
      ["Step", title],
      ["Metadata", meta],
      ["QA fixture", "frontend mock mode"],
    ],
    id,
    logs: [
      `[${id}] ${meta}`,
      `status=${states[index] ?? "pending"}`,
    ],
    meta,
    note: states[index] === "failed" ? "QA용 실패 케이스" : undefined,
    status: states[index] ?? "pending",
    title,
  }));
}

function qaStats({
  averageDuration,
  currentStage,
  inputRows,
  lastSuccess,
  outputRows,
  sampleScope,
  schemaColumns,
  sourceUnits,
  successRate,
  totalRuns,
  outputPath,
}: JobStats): JobStats {
  return {
    averageDuration,
    currentStage,
    inputRows,
    lastSuccess,
    outputRows,
    outputPath,
    sampleScope,
    schemaColumns,
    sourceUnits,
    successRate,
    totalRuns,
  };
}

const orderTransformSteps: TransformStepDraft[] = [
  { enabled: true, id: "order-rename", input: "commerce.orders", kind: "rename", label: "표준 컬럼명 적용", onError: "Fail Run", operation: "RENAME_COLUMNS", output: "orders_clean", params: "order_date,total_amount,status" },
  { enabled: true, id: "order-cast", input: "total_amount", kind: "cast", label: "금액 타입 변환", onError: "Fail Run", operation: "CAST_DECIMAL", output: "total_amount", params: "decimal(18,2)" },
];

const logTransformSteps: TransformStepDraft[] = [
  { enabled: true, id: "log-json", input: "raw_payload", kind: "jsonPath", label: "로그 JSON 파싱", onError: "Quarantine", operation: "JSON_PATH_EXTRACT", output: "event_name", params: "$.event.name" },
  { enabled: true, id: "log-age", input: "age", kind: "cast", label: "나이 타입 변환", onError: "Fail Run", operation: "CAST_INT", output: "age", params: "integer" },
];

export const etlJobs: JobRowData[] = [
  {
    status: "scheduled",
    name: "daily_order_ingestion",
    id: "JOB-001",
    owner: "admin",
    tag: "[주문]",
    source: "PostgreSQL / commerce.orders",
    target: "orders_clean",
    schedule: "매일 00:00",
    lastRun: "2026-07-01 00:03",
    lastState: "성공",
    nextRun: "2026-07-02 00:00",
    compression: "Snappy",
    dagSteps: qaDagSteps({ source: "PostgreSQL / commerce.orders", target: "orders_clean" }, ["success", "success", "success", "success", "success", "success", "success", "success"]),
    dagStepsByRunId: {
      run_20260701_0003: qaDagSteps({ source: "PostgreSQL / commerce.orders", target: "orders_clean" }, ["success", "success", "success", "success", "success", "success", "success", "success"]),
    },
    partition: "order_date",
    permissionRoles: qaPermissionRoles,
    qualityRules: [
      { enabled: true, failureAction: "Fail Run", id: "order-id-not-null", kind: "notNull", severity: "Error", targetColumn: "order_id", validationType: "Not Null" },
      { enabled: true, failureAction: "Warn", id: "amount-range", kind: "range", severity: "Warning", targetColumn: "total_amount", validationType: "Range Check" },
    ],
    qualityScore: 98.2,
    qualityStatus: "pass",
    retryPolicy: qaRetryPolicy,
    retryPolicySummary: "실패 시 3회 재시도 · 1분부터 지수 백오프",
    runHistory: [
      qaRun({ duration: "12m 24s", endedAt: "2026-07-01 00:15", errorSummary: "-", failedStage: "-", inputRows: "12,420,000", outputRows: "12,398,410", runId: "run_20260701_0003", startedAt: "2026-07-01 00:03", status: "success" }),
      qaRun({ duration: "12m 51s", endedAt: "2026-06-30 00:16", errorSummary: "-", failedStage: "-", inputRows: "12,280,400", outputRows: "12,260,100", runId: "run_20260630_0003", startedAt: "2026-06-30 00:03", status: "success" }),
    ],
    runLimitSummary: "최근 30일 실행 이력 보관",
    scheduleSummary: "매일 00:00 · Asia/Seoul · 이전 Run 실행 중이면 건너뜀",
    sourceConfig: [["Host", "commerce-db.internal"], ["Database", "commerce"], ["Table", "orders"], ["Incremental Key", "updated_at"]],
    sourceLabel: "commerce.orders",
    sourceType: "PostgreSQL",
    stats: qaStats({
      averageDuration: "12m 38s",
      currentStage: "스케줄 대기",
      inputRows: "12.4M",
      lastSuccess: "2026-07-01 00:15",
      outputPath: "s3a://asklake-output/orders_clean/silver/",
      outputRows: "12.3M",
      sampleScope: "최근 24시간 변경분",
      schemaColumns: "18 columns",
      sourceUnits: "1 table",
      successRate: "100%",
      totalRuns: "32",
    }),
    storagePath: "s3a://asklake-output/orders_clean/silver/",
    storageType: "S3",
    targetFormat: "Parquet",
    targetLayer: "SILVER",
    targetPath: "s3a://asklake-output/orders_clean/silver/",
    transformOutputColumns: [["order_id", "string"], ["customer_id", "string"], ["order_date", "timestamp"], ["total_amount", "decimal"], ["status", "string"]],
    transformSteps: orderTransformSteps,
  },
  {
    status: "failed",
    name: "s3_user_log_parse",
    id: "JOB-002",
    owner: "data-team",
    tag: "[로그]",
    source: "S3 / raw/user-log/*.csv",
    target: "user_activity",
    schedule: "매시간 10분",
    lastRun: "2026-07-02 10:10",
    lastState: "Spark 실행 실패: NumberFormatException: For input string \"unknown\" at Transform Rule age TYPE_CAST. Quarantine threshold exceeded.",
    nextRun: "2026-07-02 11:10",
    compression: "Snappy",
    dagSteps: qaDagSteps({ source: "S3 / raw/user-log/*.csv", target: "user_activity" }, ["success", "success", "success", "failed", "blocked", "blocked", "blocked", "blocked"]),
    dagStepsByRunId: {
      run_20260702_1010: qaDagSteps({ source: "S3 / raw/user-log/*.csv", target: "user_activity" }, ["success", "success", "success", "failed", "blocked", "blocked", "blocked", "blocked"]),
    },
    partition: "event_date",
    permissionRoles: qaPermissionRoles,
    qualityInvalidRows: [["row-8812", "age", "unknown", "TYPE_CAST"], ["row-8940", "age", "n/a", "TYPE_CAST"]],
    qualityRules: [
      { enabled: true, failureAction: "Fail Run", id: "age-cast", kind: "regex", severity: "Error", targetColumn: "age", validationType: "Regex Match" },
    ],
    qualityScore: 74,
    qualityStatus: "fail",
    retryPolicy: qaRetryPolicy,
    retryPolicySummary: "실패 시 3회 재시도 · 변환 실패는 승인 후 재실행",
    runHistory: [
      qaRun({
        duration: "4m 12s",
        endedAt: "2026-07-02 10:14",
        errorSummary: "Spark 실행 실패: NumberFormatException: For input string \"unknown\" at Transform Rule age TYPE_CAST. Quarantine threshold exceeded.",
        failedStage: "Transform Rule",
        inputRows: "84,212",
        outputRows: "0",
        runId: "run_20260702_1010",
        startedAt: "2026-07-02 10:10",
        status: "failed",
      }),
      qaRun({ duration: "5m 02s", endedAt: "2026-07-02 09:15", errorSummary: "-", failedStage: "-", inputRows: "82,110", outputRows: "81,904", runId: "run_20260702_0910", startedAt: "2026-07-02 09:10", status: "success" }),
    ],
    runLimitSummary: "최근 7일 실패 이력 우선 노출",
    scheduleSummary: "매시간 10분 · 실패 시 다음 예약 전 승인 필요",
    sourceConfig: [["Bucket", "raw"], ["Prefix", "user-log/"], ["Format", "CSV"], ["Header", "true"]],
    sourceLabel: "raw/user-log/*.csv",
    sourceType: "S3",
    stats: qaStats({
      averageDuration: "4m 49s",
      currentStage: "Transform Rule 실패",
      inputRows: "84,212",
      lastSuccess: "2026-07-02 09:15",
      outputPath: "s3a://asklake-output/user_activity/silver/",
      outputRows: "0",
      sampleScope: "최근 1시간 파일",
      schemaColumns: "11 columns",
      sourceUnits: "18 files",
      successRate: "83%",
      totalRuns: "47",
    }),
    storagePath: "s3a://asklake-output/user_activity/silver/",
    storageType: "S3",
    targetFormat: "Parquet",
    targetLayer: "SILVER",
    targetPath: "s3a://asklake-output/user_activity/silver/",
    transformOutputColumns: [["user_id", "string"], ["age", "integer"], ["event_name", "string"], ["event_time", "timestamp"], ["raw_value", "string"]],
    transformSteps: logTransformSteps,
  },
  {
    status: "running",
    name: "realtime_clickstream_ingestion",
    id: "JOB-003",
    owner: "platform",
    tag: "[스트림]",
    source: "Kafka / clickstream.events",
    target: "clickstream_events",
    schedule: "실시간 수집",
    lastRun: "현재 실행 중",
    lastState: "5/8 단계 · Load to Lake",
    nextRun: "-",
    progress: {
      label: "5/8 단계 · Load to Lake",
      value: 62,
    },
    compression: "Snappy",
    dagSteps: qaDagSteps({ source: "Kafka / clickstream.events", target: "clickstream_events" }, ["success", "success", "success", "success", "running", "pending", "pending", "pending"]),
    dagStepsByRunId: {
      run_20260703_1021: qaDagSteps({ source: "Kafka / clickstream.events", target: "clickstream_events" }, ["success", "success", "success", "success", "running", "pending", "pending", "pending"]),
    },
    partition: "event_date",
    permissionRoles: qaPermissionRoles,
    qualityScore: 91,
    qualityStatus: "pass",
    retryPolicy: qaRetryPolicy,
    retryPolicySummary: "Streaming checkpoint 기준 재시도",
    runHistory: [
      qaRun({ duration: "진행 중", endedAt: "-", errorSummary: "-", failedStage: "Validation", inputRows: "142,030", outputRows: "138,420", runId: "run_20260703_1021", startedAt: "2026-07-03 10:21", status: "running" }),
      qaRun({ duration: "59m 52s", endedAt: "2026-07-03 10:00", errorSummary: "-", failedStage: "-", inputRows: "820,440", outputRows: "818,002", runId: "run_20260703_0900", startedAt: "2026-07-03 09:00", status: "success" }),
    ],
    runLimitSummary: "Streaming checkpoint별 최신 24개 Run 표시",
    scheduleSummary: "Kafka consumer group 기반 실시간 수집",
    sourceConfig: [["Bootstrap Server", "kafka.internal:9092"], ["Topic", "clickstream.events"], ["Consumer Group", "asklake-clickstream"], ["Offset", "latest"]],
    sourceLabel: "clickstream.events",
    sourceType: "Kafka",
    stats: qaStats({
      averageDuration: "continuous",
      currentStage: "5/8 단계 · Load to Lake",
      inputRows: "142,030",
      lastSuccess: "2026-07-03 10:00",
      outputPath: "s3a://asklake-output/clickstream_events/silver/",
      outputRows: "138,420",
      sampleScope: "최근 5분 이벤트",
      schemaColumns: "22 columns",
      sourceUnits: "1 topic",
      successRate: "96%",
      totalRuns: "24",
    }),
    storagePath: "s3a://asklake-output/clickstream_events/silver/",
    storageType: "S3",
    targetFormat: "Parquet",
    targetLayer: "SILVER",
    targetPath: "s3a://asklake-output/clickstream_events/silver/",
    transformOutputColumns: [["event_id", "string"], ["user_id", "string"], ["event_time", "timestamp"], ["page_url", "string"], ["raw_payload", "json"]],
    transformSteps: [
      { enabled: true, id: "click-json", input: "raw_payload", kind: "jsonPath", label: "이벤트 속성 추출", onError: "Quarantine", operation: "JSON_PATH_EXTRACT", output: "page_url", params: "$.page.url" },
    ],
  },
  {
    status: "scheduled",
    name: "daily_sales_aggregation",
    id: "JOB-004",
    owner: "analytics",
    tag: "[집계]",
    source: "Lake / orders_clean",
    target: "sales_daily_summary",
    schedule: "매일 01:00",
    lastRun: "2026-07-02 01:05",
    lastState: "성공",
    nextRun: "2026-07-03 01:00",
    compression: "Snappy",
    dagSteps: qaDagSteps({ source: "Lake / orders_clean", target: "sales_daily_summary" }, ["success", "success", "success", "success", "success", "success", "success", "success"]),
    dagStepsByRunId: {
      run_20260702_0105: qaDagSteps({ source: "Lake / orders_clean", target: "sales_daily_summary" }, ["success", "success", "success", "success", "success", "success", "success", "success"]),
    },
    partition: "sales_date",
    permissionRoles: qaPermissionRoles,
    qualityScore: 96,
    qualityStatus: "pass",
    retryPolicy: qaRetryPolicy,
    retryPolicySummary: "집계 실패 시 3회 재시도",
    runHistory: [
      qaRun({ duration: "18m 04s", endedAt: "2026-07-02 01:23", errorSummary: "-", failedStage: "-", inputRows: "12,398,410", outputRows: "1,802,440", runId: "run_20260702_0105", startedAt: "2026-07-02 01:05", status: "success" }),
      qaRun({ duration: "17m 42s", endedAt: "2026-07-01 01:22", errorSummary: "-", failedStage: "-", inputRows: "12,260,100", outputRows: "1,784,120", runId: "run_20260701_0105", startedAt: "2026-07-01 01:05", status: "success" }),
    ],
    runLimitSummary: "일별 집계 Run 90일 보관",
    scheduleSummary: "매일 01:00 · orders_clean 적재 이후 실행",
    sourceConfig: [["Dataset", "orders_clean"], ["Layer", "SILVER"], ["Window", "D-1"], ["Aggregation", "daily"]],
    sourceLabel: "orders_clean",
    sourceType: "Lake Dataset",
    stats: qaStats({
      averageDuration: "17m 53s",
      currentStage: "스케줄 대기",
      inputRows: "12.3M",
      lastSuccess: "2026-07-02 01:23",
      outputPath: "s3a://asklake-output/sales_daily_summary/gold/",
      outputRows: "1.8M",
      sampleScope: "D-1 partition",
      schemaColumns: "9 columns",
      sourceUnits: "1 dataset",
      successRate: "100%",
      totalRuns: "28",
    }),
    storagePath: "s3a://asklake-output/sales_daily_summary/gold/",
    storageType: "S3",
    targetFormat: "Parquet",
    targetLayer: "GOLD",
    targetPath: "s3a://asklake-output/sales_daily_summary/gold/",
    transformOutputColumns: [["sales_date", "date"], ["region", "string"], ["gross_sales", "decimal"], ["order_count", "integer"], ["status", "string"]],
    transformSteps: [
      { enabled: true, id: "sales-group", input: "orders_clean", kind: "derive", label: "일별/지역별 집계", onError: "Fail Run", operation: "GROUP_BY_SUM", output: "sales_daily_summary", params: "sales_date, region" },
    ],
  },
];

const commerceOrdersDatasetId = "ds_commerce_orders_daily";
const commerceMarketingDatasetId = "ds_commerce_marketing_spend_daily";
const commerceChannelRoiDatasetId = "ds_gold_commerce_channel_roi";

const commerceOrdersSchema: Array<[string, string]> = [
  ["order_date", "date"],
  ["channel", "string"],
  ["category", "string"],
  ["orders", "integer"],
  ["gross_revenue", "decimal"],
  ["refund_amount", "decimal"],
  ["net_revenue", "decimal"],
  ["conversion_rate", "decimal"],
];

const commerceMarketingSchema: Array<[string, string]> = [
  ["spend_date", "date"],
  ["channel", "string"],
  ["campaign", "string"],
  ["impressions", "integer"],
  ["clicks", "integer"],
  ["ad_spend", "decimal"],
  ["cpc", "decimal"],
];

const commerceChannelRoiSchema: Array<[string, string]> = [
  ["order_date", "date"],
  ["channel", "string"],
  ["category", "string"],
  ["net_revenue", "decimal"],
  ["ad_spend", "decimal"],
  ["roas", "decimal"],
  ["orders", "integer"],
  ["cost_per_order", "decimal"],
];

const commerceChannelConfig = [
  {
    adSpend: 1460000,
    aov: 76000,
    campaign: "brand_search_efficiency",
    category: "electronics",
    channel: "paid_search",
    conversion: 4.7,
    orders: 118,
    refund: 0.032,
    traffic: 18400,
  },
  {
    adSpend: 980000,
    aov: 52000,
    campaign: "social_new_arrivals",
    category: "beauty",
    channel: "social",
    conversion: 3.1,
    orders: 96,
    refund: 0.041,
    traffic: 31600,
  },
  {
    adSpend: 640000,
    aov: 68000,
    campaign: "crm_weekly_offer",
    category: "home",
    channel: "email",
    conversion: 6.3,
    orders: 84,
    refund: 0.025,
    traffic: 8200,
  },
  {
    adSpend: 1180000,
    aov: 41000,
    campaign: "affiliate_summer_pick",
    category: "sports",
    channel: "affiliate",
    conversion: 2.8,
    orders: 142,
    refund: 0.037,
    traffic: 22400,
  },
];

function buildCommerceOrdersRows() {
  return Array.from({ length: 15 }, (_, dayIndex) => (
    commerceChannelConfig.map((config, channelIndex) => {
      const orders = config.orders + dayIndex * (5 + channelIndex) + channelIndex * 7;
      const grossRevenue = orders * config.aov;
      const refundAmount = Math.round(grossRevenue * config.refund);
      const netRevenue = grossRevenue - refundAmount;
      const conversionRate = config.conversion + dayIndex * 0.03 - channelIndex * 0.04;
      return [
        `2026-06-${String(dayIndex + 16).padStart(2, "0")}`,
        config.channel,
        config.category,
        String(orders),
        String(grossRevenue),
        String(refundAmount),
        String(netRevenue),
        conversionRate.toFixed(2),
      ];
    })
  )).flat();
}

function buildCommerceMarketingRows() {
  return Array.from({ length: 15 }, (_, dayIndex) => (
    commerceChannelConfig.map((config, channelIndex) => {
      const impressions = config.traffic + dayIndex * (480 + channelIndex * 70);
      const clicks = Math.round(impressions * (0.045 + channelIndex * 0.006));
      const adSpend = config.adSpend + dayIndex * (42000 + channelIndex * 8500);
      const cpc = adSpend / Math.max(clicks, 1);
      return [
        `2026-06-${String(dayIndex + 16).padStart(2, "0")}`,
        config.channel,
        config.campaign,
        String(impressions),
        String(clicks),
        String(adSpend),
        cpc.toFixed(2),
      ];
    })
  )).flat();
}

function buildCommerceChannelRoiRows() {
  const orderRows = buildCommerceOrdersRows();
  const marketingRows = buildCommerceMarketingRows();
  return orderRows.map((orderRow, index) => {
    const marketingRow = marketingRows[index];
    const netRevenue = Number(orderRow[6]);
    const orders = Number(orderRow[3]);
    const adSpend = Number(marketingRow[5]);
    return [
      orderRow[0],
      orderRow[1],
      orderRow[2],
      String(netRevenue),
      String(adSpend),
      (netRevenue / adSpend).toFixed(2),
      String(orders),
      (adSpend / Math.max(orders, 1)).toFixed(2),
    ];
  });
}

function lineageColumns(datasetId: string, schema: Array<[string, string]>) {
  return schema.map(([name, type]) => ({
    id: `${datasetId}-${name}`.replaceAll("_", "-"),
    name,
    type,
  }));
}

function simpleLineageGraph({
  datasetId,
  schema,
  sourceName,
  sourceNodeId,
  targetName,
}: {
  datasetId: string;
  schema: Array<[string, string]>;
  sourceName: string;
  sourceNodeId: string;
  targetName: string;
}) {
  const sourceColumns = lineageColumns(sourceNodeId, schema);
  const targetColumns = lineageColumns(datasetId, schema);
  return {
    datasetId,
    datasets: [
      {
        columns: sourceColumns,
        engine: "POSTGRESQL",
        id: sourceNodeId,
        layer: "SOURCE" as const,
        name: sourceName,
      },
      {
        columns: targetColumns,
        engine: "ICEBERG",
        id: datasetId,
        layer: "GOLD" as const,
        name: targetName,
      },
    ],
    edges: targetColumns.map((targetColumn, index) => ({
      fromColumnId: sourceColumns[index].id,
      fromDatasetId: sourceNodeId,
      toColumnId: targetColumn.id,
      toDatasetId: datasetId,
    })),
  };
}

function commerceChannelRoiLineageGraph() {
  const orderColumns = lineageColumns(commerceOrdersDatasetId, commerceOrdersSchema);
  const marketingColumns = lineageColumns(commerceMarketingDatasetId, commerceMarketingSchema);
  const targetColumns = lineageColumns(commerceChannelRoiDatasetId, commerceChannelRoiSchema);
  const ordersByName = new Map(orderColumns.map((column) => [column.name, column]));
  const marketingByName = new Map(marketingColumns.map((column) => [column.name, column]));
  const targetByName = new Map(targetColumns.map((column) => [column.name, column]));
  const edge = (sourceColumn: { id: string }, targetName: string, sourceDatasetId: string) => ({
    fromColumnId: sourceColumn.id,
    fromDatasetId: sourceDatasetId,
    toColumnId: targetByName.get(targetName)?.id ?? targetName,
    toDatasetId: commerceChannelRoiDatasetId,
  });

  return {
    datasetId: commerceChannelRoiDatasetId,
    datasets: [
      {
        columns: orderColumns,
        engine: "ICEBERG",
        id: commerceOrdersDatasetId,
        layer: "SILVER" as const,
        name: "commerce_orders_daily",
      },
      {
        columns: marketingColumns,
        engine: "ICEBERG",
        id: commerceMarketingDatasetId,
        layer: "SILVER" as const,
        name: "commerce_marketing_spend_daily",
      },
      {
        columns: targetColumns,
        engine: "ICEBERG",
        id: commerceChannelRoiDatasetId,
        layer: "GOLD" as const,
        name: "gold_commerce_channel_roi",
      },
    ],
    edges: [
      edge(ordersByName.get("order_date")!, "order_date", commerceOrdersDatasetId),
      edge(marketingByName.get("spend_date")!, "order_date", commerceMarketingDatasetId),
      edge(ordersByName.get("channel")!, "channel", commerceOrdersDatasetId),
      edge(marketingByName.get("channel")!, "channel", commerceMarketingDatasetId),
      edge(ordersByName.get("category")!, "category", commerceOrdersDatasetId),
      edge(ordersByName.get("net_revenue")!, "net_revenue", commerceOrdersDatasetId),
      edge(marketingByName.get("ad_spend")!, "ad_spend", commerceMarketingDatasetId),
      edge(ordersByName.get("net_revenue")!, "roas", commerceOrdersDatasetId),
      edge(marketingByName.get("ad_spend")!, "roas", commerceMarketingDatasetId),
      edge(ordersByName.get("orders")!, "orders", commerceOrdersDatasetId),
      edge(marketingByName.get("ad_spend")!, "cost_per_order", commerceMarketingDatasetId),
      edge(ordersByName.get("orders")!, "cost_per_order", commerceOrdersDatasetId),
    ],
  };
}

const commerceDemoDatasets: CatalogDataset[] = [
  {
    description: "채널/카테고리/일자 기준 주문 수, 순매출, 환불 금액을 담은 커머스 주문 분석 원본 데이터셋",
    downstream: ["SQL 분석", "gold_commerce_channel_roi"],
    freshness: "latest",
    id: commerceOrdersDatasetId,
    layer: "SILVER",
    lastUpdated: "2026-06-30T23:40:00.000Z",
    lineageGraph: simpleLineageGraph({
      datasetId: commerceOrdersDatasetId,
      schema: commerceOrdersSchema,
      sourceName: "PostgreSQL commerce.orders_daily",
      sourceNodeId: "source-commerce-orders-daily",
      targetName: "commerce_orders_daily",
    }),
    name: "commerce_orders_daily",
    nextRefresh: "매일 00:10",
    owner: "growth-analytics",
    quality: "98% (Demo verified)",
    rag: false,
    rows: "32,400 rows",
    sampleRows: buildCommerceOrdersRows(),
    schema: commerceOrdersSchema,
    size: "1.4MB",
    source: "commerce_orders_daily_ingest",
    status: "available",
    tags: ["#commerce", "#orders", "#silver", "#demo"],
    upstream: ["PostgreSQL commerce.orders_daily", "commerce_orders_daily_ingest"],
  },
  {
    description: "채널/캠페인/일자 기준 노출, 클릭, 광고비를 담은 커머스 마케팅 비용 원본 데이터셋",
    downstream: ["SQL 분석", "gold_commerce_channel_roi"],
    freshness: "latest",
    id: commerceMarketingDatasetId,
    layer: "SILVER",
    lastUpdated: "2026-06-30T23:45:00.000Z",
    lineageGraph: simpleLineageGraph({
      datasetId: commerceMarketingDatasetId,
      schema: commerceMarketingSchema,
      sourceName: "PostgreSQL marketing.channel_spend_daily",
      sourceNodeId: "source-marketing-channel-spend-daily",
      targetName: "commerce_marketing_spend_daily",
    }),
    name: "commerce_marketing_spend_daily",
    nextRefresh: "매일 00:20",
    owner: "growth-analytics",
    quality: "97% (Demo verified)",
    rag: false,
    rows: "2,160 rows",
    sampleRows: buildCommerceMarketingRows(),
    schema: commerceMarketingSchema,
    size: "720KB",
    source: "commerce_marketing_spend_ingest",
    status: "available",
    tags: ["#commerce", "#marketing", "#silver", "#demo"],
    upstream: ["PostgreSQL marketing.channel_spend_daily", "commerce_marketing_spend_ingest"],
  },
  {
    description: "주문 데이터와 마케팅 비용 데이터를 일자+채널 기준으로 조인해 만든 채널별 ROAS/주문당 비용 분석 골드 데이터셋",
    downstream: ["SQL 분석", "대시보드", "Growth weekly business review"],
    freshness: "latest",
    id: commerceChannelRoiDatasetId,
    layer: "GOLD",
    lastUpdated: "2026-06-30T23:55:00.000Z",
    lineageGraph: commerceChannelRoiLineageGraph(),
    name: "gold_commerce_channel_roi",
    nextRefresh: "수동 갱신",
    owner: "growth-analytics",
    quality: "SQL Preview verified",
    rag: false,
    rows: "1,080 rows",
    sampleRows: buildCommerceChannelRoiRows(),
    schema: commerceChannelRoiSchema,
    size: "1.1MB",
    source: "commerce_channel_roi_gold_pipeline",
    sourceRunId: "sql_demo_commerce_channel_roi",
    status: "available",
    storageFormat: "parquet",
    storageLocation: "s3a://asklake-demo/gold/commerce_channel_roi/",
    storageSizeBytes: 1146880,
    tags: ["#commerce", "#marketing", "#roi", "#gold", "#demo"],
    upstream: [
      "commerce_orders_daily",
      "commerce_marketing_spend_daily",
      "SQL: orders.order_date = spend.spend_date AND orders.channel = spend.channel",
    ],
  },
];

export const catalogDatasets: CatalogDataset[] = [
  ...commerceDemoDatasets,
  {
    description: "전체 채널 통합 고객 주문 정제 데이터",
    downstream: ["SQL 분석", "주문 대시보드", "customer_ltv_mart"],
    freshness: "latest",
    id: "ds_customer_orders_gold",
    layer: "GOLD",
    lastUpdated: "2026-07-03 00:03",
    lineageGraph: {
      datasetId: "ds_customer_orders_gold",
      datasets: [
        {
          columns: [
            { id: "customer_id", name: "customer_id", type: "string" },
            { id: "customer_name", name: "customer_name", type: "string" },
            { id: "email", name: "email", type: "string" },
            { id: "plan", name: "plan", type: "string" },
            { id: "customer_status", name: "customer_status", type: "string" },
          ],
          engine: "POSTGRESQL",
          id: "source-commerce-customers",
          layer: "SOURCE",
          name: "commerce.customers",
        },
        {
          columns: [
            { id: "order_id", name: "order_id", type: "string" },
            { id: "customer_id", name: "customer_id", type: "string" },
            { id: "order_date", name: "order_date", type: "timestamp" },
            { id: "total_amount", name: "total_amount", type: "decimal" },
            { id: "status", name: "status", type: "string" },
          ],
          engine: "POSTGRESQL",
          id: "source-commerce-orders",
          layer: "SOURCE",
          name: "commerce.orders",
        },
        {
          columns: [
            { id: "customer_id", name: "customer_id", type: "string" },
            { id: "customer_name", name: "customer_name", type: "string" },
            { id: "email", name: "email", type: "string" },
            { id: "plan", name: "plan", type: "string" },
            { id: "customer_status", name: "customer_status", type: "string" },
          ],
          engine: "ICEBERG",
          id: "silver-customer-profile",
          layer: "SILVER",
          name: "customer_profile",
        },
        {
          columns: [
            { id: "order_id", name: "order_id", type: "string" },
            { id: "customer_id", name: "customer_id", type: "string" },
            { id: "order_date", name: "order_date", type: "timestamp" },
            { id: "total_amount", name: "total_amount", type: "decimal" },
            { id: "status", name: "status", type: "string" },
          ],
          engine: "ICEBERG",
          id: "silver-daily-order-ingestion",
          layer: "SILVER",
          name: "daily_order_ingestion",
        },
        {
          columns: [
            { id: "order_id", name: "order_id", type: "string" },
            { id: "customer_id", name: "customer_id", type: "string" },
            { id: "order_date", name: "order_date", type: "timestamp" },
            { id: "total_amount", name: "total_amount", type: "decimal" },
            { id: "status", name: "status", type: "string" },
          ],
          engine: "ICEBERG",
          id: "ds_customer_orders_gold",
          layer: "GOLD",
          name: "orders_clean",
        },
      ],
      edges: [
        { fromColumnId: "customer_id", fromDatasetId: "source-commerce-customers", toColumnId: "customer_id", toDatasetId: "silver-customer-profile" },
        { fromColumnId: "customer_name", fromDatasetId: "source-commerce-customers", toColumnId: "customer_name", toDatasetId: "silver-customer-profile" },
        { fromColumnId: "email", fromDatasetId: "source-commerce-customers", toColumnId: "email", toDatasetId: "silver-customer-profile" },
        { fromColumnId: "plan", fromDatasetId: "source-commerce-customers", toColumnId: "plan", toDatasetId: "silver-customer-profile" },
        { fromColumnId: "customer_status", fromDatasetId: "source-commerce-customers", toColumnId: "customer_status", toDatasetId: "silver-customer-profile" },
        { fromColumnId: "order_id", fromDatasetId: "source-commerce-orders", toColumnId: "order_id", toDatasetId: "silver-daily-order-ingestion" },
        { fromColumnId: "customer_id", fromDatasetId: "source-commerce-orders", toColumnId: "customer_id", toDatasetId: "silver-daily-order-ingestion" },
        { fromColumnId: "order_date", fromDatasetId: "source-commerce-orders", toColumnId: "order_date", toDatasetId: "silver-daily-order-ingestion" },
        { fromColumnId: "total_amount", fromDatasetId: "source-commerce-orders", toColumnId: "total_amount", toDatasetId: "silver-daily-order-ingestion" },
        { fromColumnId: "status", fromDatasetId: "source-commerce-orders", toColumnId: "status", toDatasetId: "silver-daily-order-ingestion" },
        { fromColumnId: "customer_id", fromDatasetId: "silver-customer-profile", toColumnId: "customer_id", toDatasetId: "ds_customer_orders_gold" },
        { fromColumnId: "customer_status", fromDatasetId: "silver-customer-profile", toColumnId: "status", toDatasetId: "ds_customer_orders_gold" },
        { fromColumnId: "order_id", fromDatasetId: "silver-daily-order-ingestion", toColumnId: "order_id", toDatasetId: "ds_customer_orders_gold" },
        { fromColumnId: "customer_id", fromDatasetId: "silver-daily-order-ingestion", toColumnId: "customer_id", toDatasetId: "ds_customer_orders_gold" },
        { fromColumnId: "order_date", fromDatasetId: "silver-daily-order-ingestion", toColumnId: "order_date", toDatasetId: "ds_customer_orders_gold" },
        { fromColumnId: "total_amount", fromDatasetId: "silver-daily-order-ingestion", toColumnId: "total_amount", toDatasetId: "ds_customer_orders_gold" },
        { fromColumnId: "status", fromDatasetId: "silver-daily-order-ingestion", toColumnId: "status", toDatasetId: "ds_customer_orders_gold" },
      ],
    },
    name: "orders_clean",
    nextRefresh: "2026-07-04 00:00",
    owner: "Data Platform Team",
    quality: "98% (Excellent)",
    rag: true,
    rows: "12.4M rows",
    sampleRows: [["ORD-1001", "CUS-204", "2026-07-02", "128000", "paid"], ["ORD-1002", "CUS-118", "2026-07-02", "56000", "shipped"]],
    schema: [["order_id", "string"], ["customer_id", "string"], ["order_date", "timestamp"], ["total_amount", "decimal"], ["status", "string"]],
    size: "18.2GB",
    source: "daily_order_ingestion",
    status: "available",
    tags: ["#customer", "#sales", "#고객 주문"],
    upstream: ["PostgreSQL commerce.orders", "daily_order_ingestion"],
  },
  {
    description: "S3 user log CSV를 정형화한 사용자 행동 데이터셋",
    downstream: ["SQL 분석", "사용자 행동 리포트"],
    freshness: "approval",
    id: "ds_user_activity",
    layer: "SILVER",
    lastUpdated: "2026-07-02 10:10",
    name: "user_activity",
    nextRefresh: "재실행 승인 필요",
    owner: "data-team",
    quality: "74% (Needs review)",
    rag: false,
    rows: "0 rows",
    sampleRows: [["-", "-", "-", "-", "Transform failed"], ["-", "-", "-", "-", "age TYPE_CAST"]],
    schema: [["user_id", "string"], ["age", "integer"], ["event_name", "string"], ["event_time", "timestamp"], ["raw_value", "string"]],
    size: "0B",
    source: "s3_user_log_parse",
    status: "approval_required",
    tags: ["#log", "#behavior", "#사용자 지표"],
    upstream: ["S3 raw/user-log/*.csv", "s3_user_log_parse"],
  },
  {
    description: "웹/모바일 앱 실시간 클릭 스트림 이벤트",
    downstream: ["Realtime SQL", "Growth dashboard"],
    freshness: "latest",
    id: "ds_clickstream_events",
    layer: "SILVER",
    lastUpdated: "현재 실행 중",
    name: "clickstream_events",
    nextRefresh: "Streaming",
    owner: "platform",
    quality: "91% (Good)",
    rag: false,
    rows: "142,030 rows",
    sampleRows: [["EVT-881", "CUS-204", "2026-07-03 10:21", "/pricing", "click"], ["EVT-882", "CUS-118", "2026-07-03 10:22", "/checkout", "view"]],
    schema: [["event_id", "string"], ["user_id", "string"], ["event_time", "timestamp"], ["page_url", "string"], ["raw_payload", "json"]],
    size: "820MB",
    source: "realtime_clickstream_ingestion",
    status: "available",
    tags: ["#behavior", "#스트림", "#클릭", "#실시간"],
    upstream: ["Kafka clickstream.events", "realtime_clickstream_ingestion"],
  },
  {
    description: "일별 매출 집계 마트",
    downstream: ["매출 대시보드", "SQL 분석"],
    freshness: "latest",
    id: "ds_sales_daily_summary",
    layer: "GOLD",
    lastUpdated: "2026-07-02 01:05",
    name: "sales_daily_summary",
    nextRefresh: "2026-07-03 01:00",
    owner: "analytics",
    quality: "96% (Excellent)",
    rag: true,
    rows: "1.8M rows",
    sampleRows: [["2026-07-01", "KR", "31800000", "12800", "paid"], ["2026-07-02", "JP", "11200000", "4210", "paid"]],
    schema: [["sales_date", "date"], ["region", "string"], ["gross_sales", "decimal"], ["order_count", "integer"], ["status", "string"]],
    size: "2.4GB",
    source: "daily_sales_aggregation",
    status: "available",
    tags: ["#sales", "#dw", "#daily"],
    upstream: ["Lake orders_clean", "daily_sales_aggregation"],
  },
  {
    description: "고객 리뷰 감성 분석 결과가 포함된 골드 레이어 데이터셋",
    downstream: ["AI 활용", "리뷰 분석 대시보드", "SQL 분석"],
    freshness: "stale",
    id: "ds_customer_review_gold",
    layer: "GOLD",
    lastUpdated: "2026-07-02 18:30",
    name: "customer_review_gold",
    nextRefresh: "스케줄 없음",
    owner: "analytics",
    quality: "95% (Good)",
    rag: true,
    rows: "4.2M rows",
    sampleRows: [["RV-991", "SKU-200", "5", "배송이 빨라요", "positive"], ["RV-992", "SKU-118", "2", "포장이 아쉬움", "negative"]],
    schema: [["review_id", "bigint"], ["product_id", "string"], ["rating", "int"], ["review_text", "string"], ["sentiment", "string"]],
    size: "1.8GB",
    source: "customer_review_gold_pipeline",
    status: "available",
    tags: ["#customer", "#RAG", "#리뷰"],
    upstream: ["S3 Raw reviews", "customer_review_gold_pipeline"],
  },
  {
    description: "상품별 재고, 반품, 품질 신호를 통합한 헬스 스코어 데이터셋",
    downstream: ["상품 리스크 대시보드", "SQL 분석", "AI 활용"],
    freshness: "latest",
    id: "ds_product_health_gold",
    layer: "GOLD",
    lastUpdated: "2026-07-03 09:20",
    name: "product_health_gold",
    nextRefresh: "2026-07-04 09:00",
    owner: "commerce-analytics",
    quality: "94% (Good)",
    rag: true,
    rows: "860K rows",
    sampleRows: [["SKU-8842", "appliance", "82", "low_stock", "review_drop"], ["SKU-1120", "beauty", "91", "normal", "stable"]],
    schema: [["product_id", "string"], ["category", "string"], ["health_score", "integer"], ["inventory_signal", "string"], ["review_signal", "string"]],
    size: "940MB",
    source: "product_health_pipeline",
    status: "available",
    tags: ["#product", "#RAG", "#quality"],
    upstream: ["Lake inventory_snapshot", "customer_review_gold"],
  },
  {
    description: "물류 센터별 상품 재고 스냅샷",
    downstream: ["재고 운영 리포트", "product_health_gold"],
    freshness: "latest",
    id: "ds_inventory_snapshot",
    layer: "SILVER",
    lastUpdated: "2026-07-03 08:45",
    name: "inventory_snapshot",
    nextRefresh: "2026-07-03 12:00",
    owner: "ops-data",
    quality: "89% (Good)",
    rag: false,
    rows: "2.1M rows",
    sampleRows: [["SKU-8842", "ICN-01", "38", "12", "2026-07-03"], ["SKU-1120", "PUS-02", "184", "40", "2026-07-03"]],
    schema: [["product_id", "string"], ["warehouse_id", "string"], ["on_hand_qty", "integer"], ["reserved_qty", "integer"], ["snapshot_date", "date"]],
    size: "1.1GB",
    source: "warehouse_inventory_sync",
    status: "available",
    tags: ["#product", "#ops", "#실시간"],
    upstream: ["WMS inventory", "warehouse_inventory_sync"],
  },
  {
    description: "캠페인별 유입, 구매, 매출 기여도를 집계한 마케팅 마트",
    downstream: ["마케팅 ROI 대시보드", "SQL 분석"],
    freshness: "stale",
    id: "ds_marketing_attribution_mart",
    layer: "GOLD",
    lastUpdated: "2026-07-01 23:10",
    name: "marketing_attribution_mart",
    nextRefresh: "2026-07-04 02:00",
    owner: "growth-team",
    quality: "92% (Good)",
    rag: true,
    rows: "640K rows",
    sampleRows: [["CMP-2026-07-A", "paid_search", "12800", "430", "9820000"], ["CMP-2026-07-B", "social", "8420", "290", "6110000"]],
    schema: [["campaign_id", "string"], ["channel", "string"], ["sessions", "integer"], ["orders", "integer"], ["attributed_revenue", "decimal"]],
    size: "720MB",
    source: "marketing_attribution_job",
    status: "available",
    tags: ["#marketing", "#growth", "#RAG"],
    upstream: ["GA4 events", "orders_clean"],
  },
  {
    description: "고객 문의 티켓을 정제하고 카테고리화한 운영 데이터셋",
    downstream: ["고객 지원 리포트", "VOC 분석"],
    freshness: "approval",
    id: "ds_support_ticket_clean",
    layer: "SILVER",
    lastUpdated: "2026-07-02 15:40",
    name: "support_ticket_clean",
    nextRefresh: "승인 후 재실행",
    owner: "support-ops",
    quality: "78% (Needs review)",
    rag: false,
    rows: "318K rows",
    sampleRows: [["TCK-9122", "CUS-204", "delivery", "open", "2026-07-02"], ["TCK-9123", "CUS-118", "refund", "closed", "2026-07-02"]],
    schema: [["ticket_id", "string"], ["customer_id", "string"], ["category", "string"], ["status", "string"], ["created_at", "timestamp"]],
    size: "380MB",
    source: "zendesk_ticket_parse",
    status: "approval_required",
    tags: ["#customer", "#ops", "#VOC"],
    upstream: ["Zendesk tickets", "zendesk_ticket_parse"],
  },
  {
    description: "월별 매출 예측과 실제 매출 차이를 비교하는 재무 데이터셋",
    downstream: ["경영 대시보드", "SQL 분석"],
    freshness: "latest",
    id: "ds_revenue_forecast_gold",
    layer: "GOLD",
    lastUpdated: "2026-07-03 06:30",
    name: "revenue_forecast_gold",
    nextRefresh: "2026-07-04 06:00",
    owner: "finance-data",
    quality: "97% (Excellent)",
    rag: true,
    rows: "120K rows",
    sampleRows: [["2026-07", "KR", "420000000", "405000000", "-3.6"], ["2026-07", "JP", "178000000", "181000000", "1.7"]],
    schema: [["month", "string"], ["region", "string"], ["forecast_revenue", "decimal"], ["actual_revenue", "decimal"], ["variance_pct", "double"]],
    size: "260MB",
    source: "finance_forecast_pipeline",
    status: "available",
    tags: ["#finance", "#growth", "#dw"],
    upstream: ["sales_daily_summary", "finance_plan_sheet"],
  },
];

export const summaryByFlow: Record<FlowId, Array<[string, string]>> = {
  jobs: [
    ["전체 작업", "24"],
    ["실행 중", "3"],
    ["스케줄됨", "12"],
    ["실패", "2"],
    ["최신 아님", "4"],
  ],
  jobsTableDemo: [
    ["표시 방식", "Table"],
    ["핵심 컬럼", "7개"],
    ["실패 로그", "요약 표시"],
    ["원문", "모달"],
    ["상태", "검토용"],
  ],
  jobDetail: [
    ["작업명", "s3_user_log_parse"],
    ["상태", "FAILED"],
    ["Owner", "해건"],
    ["타깃", "user_activity"],
    ["실패 규칙", "age TYPE_CAST"],
  ],
  jobRuns: [
    ["총 실행", "47회"],
    ["7일 성공률", "94.2%"],
    ["평균 소요", "14.1m"],
    ["최근 실패", "run_002"],
    ["실패 단계", "Transform Rule"],
  ],
  catalogDetail: [
    ["데이터셋", "orders_clean"],
    ["Owner", "Data Platform"],
    ["Layer", "GOLD"],
    ["품질", "98%"],
    ["리니지", "Upstream 2"],
  ],
  source: [
    ["선택 커넥터", "File / S3"],
    ["연결 상태", "AccessGranted"],
    ["감지 파일", "3개"],
    ["인증 방식", "IAM Role"],
    ["다음 단계", "스키마 추론"],
  ],
  schema: [
    ["샘플 Row", "10,000"],
    ["추론 필드", "24개"],
    ["평균 Confidence", "87%"],
    ["검토 필요", "3개 필드"],
    ["다음 단계", "룰 적용"],
  ],
  rules: [
    ["활성 규칙", "5개"],
    ["영향 컬럼", "12/48"],
    ["품질 통과율", "94.2%"],
    ["Invalid Rows", "3건"],
    ["다음 단계", "스케줄"],
  ],
  repeat: [
    ["실행 일정", "매주 목요일 10:30 · Asia/Seoul"],
    ["다음 실행", "저장 시점 기준 계산"],
    ["겹침 처리", "이전 Run 실행 중이면 다음 예약 건너뜀"],
    ["실패 재시도", "3회 재시도 · 1분부터 2배 지수 백오프 · 최대 30분 · 재시도 후 실패 처리"],
    ["상태", "생성 대기"],
  ],
  manual: [
    ["시작 조건", "필요할 때 즉시 실행"],
    ["다음 실행", "없음"],
    ["실패 재시도", "3회 재시도 · 1분부터 2배 지수 백오프 · 최대 30분 · 재시도 후 실패 처리"],
    ["상태", "저장 대기"],
  ],
  once: [
    ["실행 방식", "1회 실행"],
    ["실행 시각", "설정 전"],
    ["실패 재시도", "기본 정책"],
    ["상태", "예약 전"],
  ],
  target: [
    ["저장소", "S3 Gold"],
    ["포맷", "Parquet"],
    ["파티션", "year/month/region"],
    ["진행률", "85%"],
  ],
  permission: [
    ["선택된 권한", "3개 그룹"],
    ["검토 필요", "1건"],
    ["공개 범위", "조직 내부"],
    ["승인자", "Data Owner"],
    ["상태", "권한 확인 중"],
  ],
  review: [
    ["파이프라인", "customer_review_gold"],
    ["소스", "S3 Raw"],
    ["스케줄", "매주 목요일 10:30"],
    ["권한", "분석가 외 2건"],
    ["타겟", "S3 Gold / Parquet"],
  ],
  catalog: [
    ["담당 파트", "중일"],
    ["핵심 화면", "검색 / 상세 / 리니지"],
    ["상태", "통합 예정"],
    ["연결", "생성된 데이터셋"],
    ["다음 단계", "SQL 분석"],
  ],
  sql: [
    ["담당 파트", "원재"],
    ["핵심 화면", "SQL Editor"],
    ["상태", "통합 예정"],
    ["입력", "Catalog 데이터셋"],
    ["출력", "결과 / Export"],
  ],
  dashboard: [
    ["담당 파트", "선호"],
    ["핵심 화면", "Dashboard Builder"],
    ["상태", "통합 예정"],
    ["입력", "SQL 결과"],
    ["출력", "Published Dashboard"],
  ],
  ai: [
    ["담당 영역", "AI 활용"],
    ["핵심 기능", "RAG / AI 질의"],
    ["상태", "아직 연결 없음"],
    ["입력", "Lake 데이터셋"],
    ["권한", "사용자별 접근 제어"],
  ],
  admin: [
    ["담당 영역", "관리"],
    ["핵심 기능", "권한 / 감사 로그"],
    ["상태", "아직 연결 없음"],
    ["대상", "사용자 / 그룹 / API"],
    ["로그", "Audit Log"],
  ],
};
