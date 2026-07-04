import { useState } from "react";
import type React from "react";
import {
  BarChart3,
  BookOpen,
  Bot,
  Calendar,
  Check,
  CircleUser,
  Clock3,
  Database,
  Download,
  ExternalLink,
  FileText,
  HardDrive,
  Info,
  LayoutGrid,
  Maximize2,
  Minus,
  PlayCircle,
  Plus,
  RefreshCw,
  Repeat2,
  Save,
  Star,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  Table2,
  TerminalSquare,
} from "lucide-react";
import { Field, InfoBox, PageTitle, RetryPolicy, StatusTile } from "../../components/common";
import { CreationFlowLayout, CreationPanelActions, CreationSummaryPanel, CreationValidationPanel } from "../../components/creation/CreationFlow";
import { toCreatePipelineRequest } from "../../services/draftPipelineContract";
import type { AuditResult, DraftPipeline, DraftPipelinePatch, FlowId, ScheduleFlowId, TargetLayer } from "../../types";

export function SchedulePage({
  mode,
  onDraftChange,
  onModeChange,
  onPrev,
  onNext,
  onSave,
}: {
  mode: ScheduleFlowId;
  onDraftChange: (patch: DraftPipelinePatch) => void;
  onModeChange: (flow: ScheduleFlowId) => void;
  onPrev: () => void;
  onNext: () => void;
  onSave: () => void;
}) {
  const [repeatDay, setRepeatDay] = useState("화");
  const [repeatTime, setRepeatTime] = useState("10:30");
  const [onceDateTime, setOnceDateTime] = useState("2026.07.02 10:30");
  const title = "스케줄링 설정";
  const selected = mode === "repeat" ? "반복 실행" : mode === "manual" ? "수동 실행" : "1회 실행";
  const scheduleLabel = mode === "repeat" ? `매주 ${repeatDay}요일 ${repeatTime}` : mode === "manual" ? "수동 실행" : `${onceDateTime} 1회 실행`;
  const applyScheduleDraft = () => {
    onDraftChange({ scheduleLabel });
  };
  const goNext = () => {
    applyScheduleDraft();
    onNext();
  };
  const saveSchedule = () => {
    applyScheduleDraft();
    onSave();
  };

  return (
    <CreationFlowLayout
      side={<CreationSummaryPanel flow={mode} title="설정 요약" selected={scheduleLabel || selected} onPrev={onPrev} onNext={goNext} onSave={saveSchedule} />}
    >
        <PageTitle title={title} description="파이프라인의 실행 주기 및 재시도 정책을 설정합니다." />
        <section className="panel">
          <div className="section-heading">
            <PlayCircle size={20} />
            <h2>실행 방식 설정</h2>
          </div>
          <div className="option-grid">
            <RunTypeCard active={mode === "manual"} icon={<PlayCircle size={24} />} title="수동 실행" desc="사용자가 직접 트리거할 때만 실행됩니다." onClick={() => onModeChange("manual")} />
            <RunTypeCard active={mode === "once"} icon={<Clock3 size={24} />} title="1회 실행" desc="지정된 시간에 단 한 번만 실행됩니다." onClick={() => onModeChange("once")} />
            <RunTypeCard active={mode === "repeat"} icon={<Repeat2 size={24} />} title="반복 실행" desc="주기적으로 반복하여 데이터를 처리합니다." onClick={() => onModeChange("repeat")} />
          </div>
        </section>
        {mode === "repeat" && <RepeatSettings selectedDay={repeatDay} time={repeatTime} onDayChange={(day) => {
          setRepeatDay(day);
          onDraftChange({ scheduleLabel: `매주 ${day}요일 ${repeatTime}` });
        }} onTimeChange={(time) => {
          setRepeatTime(time);
          onDraftChange({ scheduleLabel: `매주 ${repeatDay}요일 ${time}` });
        }} />}
        {mode === "manual" && <ManualSettings />}
        {mode === "once" && <OnceSettings dateTime={onceDateTime} onDateTimeChange={(dateTime) => {
          setOnceDateTime(dateTime);
          onDraftChange({ scheduleLabel: `${dateTime} 1회 실행` });
        }} />}
    </CreationFlowLayout>
  );
}

function RunTypeCard({ active, icon, title, desc, onClick }: { active: boolean; icon: React.ReactNode; title: string; desc: string; onClick: () => void }) {
  return (
    <button className={active ? "run-card active" : "run-card"} type="button" onClick={onClick}>
      {active && <span className="run-selected-dot" />}
      <span className="run-icon">{icon}</span>
      <strong>{title}</strong>
      <span>{desc}</span>
    </button>
  );
}

export function SourceConnectionPage({
  onAction,
  onDraftChange,
  onNotify,
  onPrev,
  onNext,
  onSave,
}: {
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onDraftChange: (patch: DraftPipelinePatch) => void;
  onNotify: (message: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onSave: () => void;
}) {
  const [sourceType, setSourceType] = useState("File / S3");
  const [sourceFields, setSourceFields] = useState<Record<string, Array<[string, string]>>>({});
  const connectorMeta: Record<string, { desc: string; status: string }> = {
    Database: { desc: "Postgres, MySQL, Oracle", status: "ready" },
    "File / S3": { desc: "S3, GCS, Azure Blob", status: "valid" },
    "Data Lake": { desc: "Delta Lake, Iceberg, Hudi", status: "metadata" },
    "REST API": { desc: "REST, GraphQL, Webhooks", status: "parsed" },
    "Stream / Kafka": { desc: "Real-time message brokers", status: "active" },
  };
  const sourceConfigs: Record<string, {
    title: string;
    description: string;
    fields: Array<[string, string]>;
    testItems: Array<[string, string]>;
    logs: string[];
    assetsTitle: string;
    assets: Array<[string, string, string]>;
    previewTitle: string;
    previewNote: string;
    previewColumns: string[];
    previewRows: string[][];
    actions?: string[];
    info?: string;
  }> = {
    Database: {
      title: "PostgreSQL Connection",
      description: "JDBC 연결로 테이블과 뷰를 탐색하고 샘플 행을 가져옵니다.",
      fields: [
        ["Endpoint / Host", "production-pg-cluster.internal"],
        ["Port", "5432"],
        ["Database Name", "sales_warehouse"],
        ["Schema", "public"],
        ["Username", "asklake_service_account"],
        ["Password / Auth Token", "secret_token_123"],
      ],
      testItems: [["Endpoint", "Reachable"], ["Auth", "Ready"], ["Tables", "1 detected"]],
      logs: ["[INFO] DNS resolved production-pg-cluster.internal", "[INFO] Read-only credential accepted", "[SCAN] public.users detected"],
      assetsTitle: "Detected Tables",
      assets: [["public.users", "Table", "ready"], ["public.orders", "Table", "locked"], ["public.events", "View", "ready"]],
      previewTitle: "Raw Source Preview",
      previewNote: "No preview data available · Run a connection test to fetch sample rows from the source.",
      previewColumns: ["Table", "Rows", "Status"],
      previewRows: [["public.users", "0", "Test required"], ["public.orders", "0", "Locked"]],
      info: "We recommend using a read-only user account for ETL processes to ensure data security.",
    },
    "File / S3": {
      title: "File / S3 Source Configuration",
      description: "Configure your cloud storage bucket connection details.",
      fields: [
        ["Storage Provider", "Amazon S3"],
        ["Bucket / Stage Name", "asklake-raw-ingest-us-east"],
        ["Path / Prefix", "data/inventory/daily/"],
        ["Auth Method", "IAM Role (Recommended)"],
        ["Role ARN", "arn:aws:iam::982347102:role/DataIngestRole"],
        ["File Type", "CSV (Comma Separated)"],
        ["Delimiter", ","],
        ["Encoding", "UTF-8"],
        ["Header", "Treat first row as header"],
      ],
      testItems: [["Storage", "Connected"], ["Auth", "AccessGranted"], ["Path", "Scanned"]],
      logs: ["[INFO] Connection established to us-east-1", "[INFO] Validating IAM policy: AccessGranted", "[SCAN] Scanning prefix: data/inventory/..."],
      assetsTitle: "Detected Files",
      assets: [["orders_2024.csv", "2.4 MB", "10m ago"], ["users.parquet", "15.8 MB", "1h ago"], ["events.json", "442 KB", "2d ago"]],
      previewTitle: "Raw File Preview",
      previewNote: 'Showing first 5 rows of "orders_2024.csv"',
      previewColumns: ["#", "Raw Content (UTF-8)", "Byte Size", "Status"],
      previewRows: [
        ["1", "order_id,customer_id,order_date,amount,status,region", "64 B", "Header"],
        ["2", "ORD-99201,CUST-002,2024-03-15,124.50,PENDING,US-EAST-1", "62 B", "Valid"],
        ["3", "ORD-99202,CUST-045,2024-03-15,88.00,COMPLETED,US-WEST-2", "60 B", "Valid"],
        ["4", "ORD-99203,CUST-012,2024-03-16,420.75,CANCELLED,US-EAST-1", "63 B", "Valid"],
        ["5", "ORD-99204,CUST-111,2024-03-16,210.00,PENDING,EU-CENTRAL-1", "62 B", "Valid"],
      ],
      actions: ["Refresh Preview"],
    },
    "Data Lake": {
      title: "Data Lake Source",
      description: "Configure the connection details for your cloud-based data lakehouse.",
      fields: [
        ["Lake Type", "Delta Lake (Databricks)"],
        ["CATALOG / NAMESPACE", "prod_datalake_v2"],
        ["DATABASE / SCHEMA", "analytics_raw"],
        ["Path", "s3://asklake-prod-bucket/logs/user_events/"],
        ["Read Mode", "Latest Version (Snapshot Isolation)"],
        ["DATASET OR TABLE SELECTOR", "user_interactions_log"],
      ],
      testItems: [["Lake Access", "Passed"], ["Metadata", "Fetched"], ["Permission", "Granted"]],
      logs: ["[14:02:11] Init: AWS SDK V2 Client", "[14:02:12] Auth: IAM Role detected", "[14:02:14] Success: Bucket accessible", "[14:02:15] Success: Delta manifest found", "[14:02:15] Info: Scanning partitions..."],
      assetsTitle: "Detected Lake Objects",
      assets: [["user_interactions_log", "Table", "1.2 TB"], ["session_archive_2023", "Folder", "4.8 TB"], ["identity_map_v2", "Iceberg Table", "240 GB"], ["snapshot_v1_backup", "Snapshot", "12 GB"]],
      previewTitle: "Lake Table Preview",
      previewNote: "Showing first 5 of 12,402,192 rows · Version 42 (Iceberg)",
      previewColumns: ["Event Timestamp", "User ID", "Transaction ID", "Region", "Action Type", "Latency"],
      previewRows: [["2024-03-20 10:15:02", "USR_882", "TRX-90122", "APAC", "PAGE_VIEW", "42ms"], ["2024-03-20 10:15:15", "USR_121", "TRX-90123", "EMEA", "ADD_TO_CART", "38ms"], ["2024-03-20 10:16:01", "USR_882", "TRX-90124", "APAC", "CHECKOUT", "55ms"]],
      actions: ["Fetch Metadata", "Download CSV", "Full Screen"],
    },
    "REST API": {
      title: "REST API Source",
      description: "Configure your REST endpoint to ingest remote data.",
      fields: [
        ["Method", "GET"],
        ["Endpoint URL", "https://api.asklake-demo.io/v1/analytics/orders"],
        ["Authentication Type", "Bearer Token"],
        ["Token / Secret", "••••••••••••••••••••••"],
        ["Accept", "application/json"],
        ["X-Request-ID", "etl-9928-ax"],
        ["limit", "50"],
        ["status", "active"],
        ["Pagination Strategy", "Page Number"],
        ["Root Path", "$.data.items"],
      ],
      testItems: [["Endpoint", "Reachable"], ["Auth", "Valid"], ["Response", "Parsed (200 OK)"]],
      logs: ["[09:21:02] Connected to asklake-demo.io", "[09:21:03] Sending Auth headers...", "[09:21:03] Response 200 Received (82kb)", "[09:21:04] Applying Root Path $.data.items"],
      assetsTitle: "Detected Fields",
      assets: [["user_id", "Integer", "5 Found"], ["email", "String", "parsed"], ["created_at", "DateTime", "parsed"], ["amount", "Decimal", "parsed"], ["status", "String", "parsed"]],
      previewTitle: "API Response Preview",
      previewNote: "Parsed Rows · Total Rows: 50 · Fetch Time: 214ms",
      previewColumns: ["User ID", "Email", "Date", "Status", "Amount"],
      previewRows: [["10283", "dev.ops@example.com", "2024-03-12", "COMPLETED", "$499.99"], ["10284", "data.wiz@asklake.ai", "2024-03-12", "PENDING", "$120.50"], ["10285", "jane.smith@corp.com", "2024-03-12", "COMPLETED", "$88.00"]],
      actions: ["Refresh Preview"],
    },
    "Stream / Kafka": {
      title: "Stream Source Configuration",
      description: "Configure your real-time data stream endpoint.",
      fields: [
        ["Stream Type", "Apache Kafka"],
        ["Broker / Endpoint", "pkc-4vjqw.us-east-1.confluent.cloud:9092"],
        ["TOPIC / QUEUE NAME", "asklake.ingest.production.telemetry"],
        ["CONSUMER GROUP ID", "asklake-etl-consumer-01"],
        ["Offset Policy", "Earliest (Start from beginning)"],
        ["Message Format", "JSON (Auto-infer Schema)"],
        ["Authentication", "SASL / SCRAM"],
      ],
      testItems: [["Broker Reachable", "Pending"], ["Topic Access", "Pending"], ["Message Parse", "Pending"]],
      logs: ["[INFO] Initiating handshake with broker...", "[INFO] SASL_SSL authentication successful.", "[INFO] Metadata fetched for 12 partitions.", "[INFO] Established consumer session ID: k-8821x-af", "[WARN] Partition 4 reporting slight latency."],
      assetsTitle: "Detected Metadata",
      assets: [["Partitions", "12", "ready"], ["Replication Factor", "3", "ready"], ["Latest Offset", "1,442,901", "ready"], ["Lag Status", "0ms", "healthy"], ["Compression", "Snappy", "ready"]],
      previewTitle: "Sample Messages Preview",
      previewNote: "Real-time stream head · Polling at 100ms · Auto-parsing active",
      previewColumns: ["Payload (Raw JSON)", "Part.", "Offset", "Timestamp"],
      previewRows: [["{\"event\":\"purchase\",\"user_id\":8821,\"amount\":42.50}", "2", "450122", "2024-05-20 14:02:11.452"], ["{\"event\":\"click\",\"user_id\":4120,\"page\":\"/checkout\"}", "0", "991201", "2024-05-20 14:02:11.488"], ["{\"event\":\"view\",\"user_id\":9931,\"product_id\":\"P-442\"}", "1", "221094", "2024-05-20 14:02:11.501"]],
      actions: ["Show Advanced Configuration"],
    },
  };
  const current = sourceConfigs[sourceType];
  const editableFields = sourceFields[sourceType] ?? current.fields;
  const sourceLabel = editableFields.find(([label]) => ["Bucket / Stage Name", "Endpoint / Host", "Path", "Endpoint URL", "Broker / Endpoint", "DATASET OR TABLE SELECTOR"].includes(label))?.[1] ?? sourceType;

  const applySourceDraft = (nextType = sourceType, nextFields = editableFields) => {
    const label = nextFields.find(([fieldLabel]) => ["Bucket / Stage Name", "Endpoint / Host", "Path", "Endpoint URL", "Broker / Endpoint", "DATASET OR TABLE SELECTOR"].includes(fieldLabel))?.[1] ?? nextType;
    onDraftChange({
      sourceConfig: nextFields,
      sourceLabel: label,
      sourceType: nextType,
    });
  };

  const selectSource = (value: string) => {
    setSourceType(value);
    applySourceDraft(value, sourceFields[value] ?? sourceConfigs[value].fields);
    onAction("etl.source.connector_selected", "/api/etl/sources/connectors", value);
  };

  const updateSourceField = (label: string, value: string) => {
    const nextFields = editableFields.map(([fieldLabel, fieldValue]) => [fieldLabel, fieldLabel === label ? value : fieldValue] as [string, string]);
    setSourceFields((fields) => ({ ...fields, [sourceType]: nextFields }));
    applySourceDraft(sourceType, nextFields);
  };

  const testConnection = () => {
    onAction("etl.source.connection_tested", "/api/etl/sources/test", sourceType);
    onNotify(`${sourceType} 연결 테스트가 통과되었습니다.`);
  };

  const fetchMetadata = () => {
    onAction("etl.source.metadata_fetched", "/api/etl/sources/metadata", sourceType);
  };

  const refreshPreview = () => {
    onAction("etl.source.preview_refreshed", "/api/etl/sources/preview", sourceType);
  };

  return (
    <CreationFlowLayout
      side={<CreationSummaryPanel flow="source" title="소스 요약" selected={`${sourceType} · ${sourceLabel}`} onPrev={onPrev} onNext={() => {
        applySourceDraft();
        onNext();
      }} onSave={() => {
        applySourceDraft();
        onSave();
      }} />}
    >
        <PageTitle title="Source Connection" description="Define your data source and test connectivity to proceed." />
        <section className="panel hegun-console-panel">
          <div className="panel-header">
            <Database size={18} />
            <h2>Source Type</h2>
            <span className="panel-note">Pipeline Draft saved 2 mins ago</span>
          </div>
          <div className="hegun-connector-grid">
            {Object.entries(connectorMeta).map(([connector, meta]) => (
              <button className={sourceType === connector ? "hegun-connector active" : "hegun-connector"} key={connector} type="button" onClick={() => selectSource(connector)}>
                <strong>{connector}</strong>
                <span>{meta.desc}</span>
                <em>{meta.status}</em>
              </button>
            ))}
          </div>
        </section>
        <section className="panel hegun-console-panel">
          <div className="panel-header">
            <Settings size={18} />
            <h2>{current.title}</h2>
            <span className="panel-note">{current.description}</span>
          </div>
          <div className="hegun-field-grid">
            {editableFields.map(([label, value]) => (
              <label className={value.length > 38 ? "field wide" : "field"} key={`${sourceType}-${label}`}>
                <span>{label}</span>
                <input className="input control-input" value={value} onChange={(event) => updateSourceField(label, event.target.value)} />
              </label>
            ))}
          </div>
          {current.info && <InfoBox title="Secure Connection" body={current.info} />}
          <div className="form-actions inline">
            {current.actions?.includes("Show Advanced Configuration") && <button className="secondary-button" type="button" onClick={() => onAction("etl.source.advanced_opened", "/api/etl/sources/advanced", sourceType)}>Show Advanced Configuration</button>}
            {current.actions?.includes("Fetch Metadata") && <button className="secondary-button" type="button" onClick={fetchMetadata}>Fetch Metadata</button>}
            <button className="secondary-button" type="button" onClick={testConnection}>Test Connection</button>
          </div>
        </section>
        <div className="hegun-source-grid">
          <section className="panel hegun-console-panel">
            <div className="panel-header">
              <Check size={18} />
              <h2>Connectivity Test</h2>
              <span className="panel-note">{current.testItems.map(([label]) => label).join(" · ")}</span>
            </div>
            <div className="hegun-test-summary">
              <div>
                <strong>Connection verified</strong>
                <span>{current.testItems.length} checks completed for {sourceType}</span>
              </div>
              <em>Ready for preview</em>
            </div>
            <div className="hegun-test-strip">
              {current.testItems.map(([label, value], index) => (
                <span key={`${sourceType}-${label}-${index}`}>
                  <i><Check size={13} /></i>
                  <strong>{label}</strong>
                  <em>{value}</em>
                </span>
              ))}
            </div>
            <div className="hegun-log-panel" aria-label="Connection test log">
              <div className="hegun-log-header">
                <strong>Execution log</strong>
                <span>live</span>
              </div>
              <div className="hegun-log-lines">
                {current.logs.map((log, index) => <span key={`${sourceType}-log-${index}`}>{log}</span>)}
              </div>
            </div>
          </section>
          <section className="panel hegun-console-panel">
            <div className="panel-header">
              <LayoutGrid size={18} />
              <h2>{current.assetsTitle}</h2>
              <span className="panel-note">{current.assets.length} Total</span>
            </div>
            <div className="hegun-asset-list">
              {current.assets.map(([name, meta, status], index) => (
                <article key={`${sourceType}-${name}-${index}`}>
                  <strong>{name}</strong>
                  <span>{meta}</span>
                  <em>{status}</em>
                </article>
              ))}
            </div>
          </section>
        </div>
        <section className="panel hegun-console-panel">
          <div className="panel-header">
            <FileText size={18} />
            <h2>{current.previewTitle}</h2>
            <span className="panel-note">{current.previewNote}</span>
          </div>
          <div className="hegun-preview-actions">
            {current.actions?.includes("Refresh Preview") && <button className="secondary-button" type="button" onClick={refreshPreview}>Refresh Preview</button>}
            {current.actions?.includes("Download CSV") && <button className="secondary-button" type="button" onClick={() => onAction("etl.source.preview_downloaded", "/api/etl/sources/preview/download", sourceType)}>Download CSV</button>}
            {current.actions?.includes("Full Screen") && <button className="secondary-button" type="button" onClick={() => onAction("etl.source.preview_fullscreen_opened", "/api/etl/sources/preview/fullscreen", sourceType)}>Full Screen</button>}
          </div>
          <div className="hegun-table-scroll">
            <table className="schema-table">
              <thead><tr>{current.previewColumns.map((column, index) => <th key={`${column}-${index}`}>{column}</th>)}</tr></thead>
              <tbody>{current.previewRows.map((row, rowIndex) => <tr key={`${sourceType}-preview-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{cell}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </section>
        <div className="form-actions inline">
          <button className="secondary-button" type="button" onClick={testConnection}>연결 테스트</button>
        </div>
    </CreationFlowLayout>
  );
}

export function SchemaInferencePage({
  onDraftChange,
  onAction,
  onNotify,
  onNext,
  onPrev,
  onSave,
}: {
  onDraftChange: (patch: DraftPipelinePatch) => void;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onNotify: (message: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onSave: () => void;
}) {
  const schemaRows = [
    ["#1", "user_id", "user_id", "Integer", "NO", "Primary", "100%", "102, 103, 104"],
    ["#2", "first_name", "first_name", "String", "NO", "-", "98%", "John, Jane, Mike"],
    ["#3", "last_name", "last_name", "String", "YES", "-", "95%", "Doe, Smith, Brown"],
    ["#4", "signup_ts", "created_at", "Timestamp", "NO", "-", "72%", "2023-01-01 10:00..."],
    ["#5", "sub_plan_code", "plan_id", "Integer", "YES", "Foreign", "85%", "1, 2, NULL, 3"],
    ["#6", "meta_json", "metadata", "JSON", "YES", "Obj", "60%", "{\"ref\":\"ads_01\"}"],
    ["#7", "geo_lat", "latitude", "Float", "YES", "-", "99%", "37.7749, 34.0522"],
  ];
  const metadata = [
    ["Data Source", "orders_main_prod.csv"],
    ["Rows Sampled", "10,000"],
    ["Status", "Inference Needs Review"],
    ["Parser", "CSV · UTF-8 · Header"],
  ];

  const runInference = () => {
    onAction("etl.schema.inferred", "/api/etl/schema-inference", "customer_review_raw");
    onDraftChange({ schemaSummary: "24 fields inferred · 3 need review" });
    onNotify("샘플 데이터 기준 스키마 추론이 완료되었습니다.");
  };

  const schemaAction = (action: string, path: string, schemaSummary?: string) => {
    onAction(action, path, "orders_main_prod.csv");
    if (schemaSummary) {
      onDraftChange({ schemaSummary });
    }
  };

  const approveSchema = () => {
    schemaAction("etl.schema.confirmed", "/api/etl/schema-inference/confirm", "24 fields approved · 0 blocking issues");
  };

  const saveSchemaDraft = () => {
    onDraftChange({ schemaSummary: "24 fields approved · 0 blocking issues" });
    onSave();
  };

  return (
    <CreationFlowLayout
      side={<CreationSummaryPanel flow="schema" title="스키마 요약" onPrev={onPrev} onNext={() => {
        approveSchema();
        onNext();
      }} onSave={saveSchemaDraft} />}
    >
        <PageTitle title="Schema Inference" description="샘플 데이터를 분석해 컬럼, 타입, Null 여부와 추천 메타데이터를 확인합니다." />
        <div className="review-card-grid compact-cards">
          {metadata.map(([label, value], index) => (
            <article className="review-mini-card" key={`${label}-${index}`}>
              <strong>{label}</strong>
              <span>{value}</span>
            </article>
          ))}
        </div>
        <section className="panel hegun-console-panel">
          <div className="panel-header">
            <LayoutGrid size={18} />
            <h2>Showing 24 Fields</h2>
            <span className="panel-note">Filter, bulk edit, and approve inferred fields</span>
          </div>
          <div className="hegun-toolbar">
            <button className="secondary-button" type="button" onClick={() => schemaAction("etl.schema.rescanned", "/api/etl/schema-inference/rescan", "24 fields re-scanned · 3 need review")}>Re-scan Source</button>
            <button className="secondary-button" type="button" onClick={() => schemaAction("etl.schema.approved_all", "/api/etl/schema-inference/approve-all", "24 fields approved · 0 blocking issues")}>Approve All</button>
            <button className="secondary-button" type="button" onClick={() => schemaAction("etl.schema.bulk_edit_opened", "/api/etl/schema-inference/bulk-edit")}>Bulk Edit Type</button>
            <button className="secondary-button" type="button" onClick={() => schemaAction("etl.schema.mappings_reset", "/api/etl/schema-inference/reset-mappings", "24 fields inferred · mappings reset")}>Reset Mappings</button>
            <span>Filter fields...</span>
          </div>
          <div className="hegun-table-scroll">
            <table className="schema-table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Source Field</th>
                  <th>Target Field</th>
                  <th>Type</th>
                  <th>Nullable</th>
                  <th>Key</th>
                  <th>Confidence</th>
                  <th>Sample Data</th>
                </tr>
              </thead>
              <tbody>
                {schemaRows.map((row, rowIndex) => (
                  <tr className={Number.parseInt(row[6]) < 80 ? "hegun-low-confidence" : ""} key={`${row[0]}-${rowIndex}`}>
                    {row.map((cell, cellIndex) => <td key={`${row[0]}-${cellIndex}`}>{cell}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <div className="hegun-schema-grid">
          <section className="panel hegun-console-panel">
            <div className="panel-header">
              <Check size={18} />
              <h2>Field Review</h2>
              <span className="panel-note">signup_ts · 72% Confidence · Field ID: 4</span>
            </div>
            <div className="form-grid">
              <Field label="Target Field Name" value="created_at" />
              <Field label="Override Type" value="Timestamp" />
              <Field label="Null Ratio" value="12.4%" />
              <Field label="Value Distribution" value="Premium / Basic / Enterprise / Trial" wide />
            </div>
            <div className="hegun-distribution">
              {[45, 30, 15, 10].map((value, index) => <span key={value + index} style={{ width: `${value}%` }} />)}
            </div>
          </section>
          <section className="panel hegun-console-panel">
            <div className="panel-header">
              <Settings size={18} />
              <h2>Parsing & Flattening</h2>
              <span className="panel-note">MongoDB / JSON compatible</span>
            </div>
            <div className="form-grid compact">
              <Field label="Root Path" value="$" />
              <Field label="Flatten Nested Objects" value="Enabled" />
              <Field label="Flatten Depth" value="1 / 2 / 3" />
              <Field label="Array Handling" value="Keep as JSON" />
              <Field label="Mixed Type Policy" value="Most Common Type" wide />
            </div>
          </section>
        </div>
        <div className="form-actions inline">
          <button className="secondary-button" type="button" onClick={runInference}>다시 추론</button>
          <button className="secondary-button" type="button" onClick={() => schemaAction("etl.schema.exported", "/api/etl/schema-inference/export")}>Export Schema (JSON)</button>
        </div>
    </CreationFlowLayout>
  );
}

export function RuleApplicationPage({
  onDraftChange,
  onAction,
  onNotify,
  onNext,
  onPrev,
  onSave,
}: {
  onDraftChange: (patch: DraftPipelinePatch) => void;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onNotify: (message: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onSave: () => void;
}) {
  const rules = [
    ["1", "meta_json", "Extract JSONPath", "user_email", "$.user.contact.email", "Set Null"],
    ["2", "user_email", "Lowercase + Trim", "user_email", "lower(), trim()", "Warn"],
    ["3", "price_usd", "Cast Decimal", "price_usd", "decimal(10,2)", "Drop Row"],
    ["4", "created_at", "Parse Timestamp", "created_at_utc", "string to UTC", "Set Null"],
    ["5", "phone_number", "Mask", "phone_masked", "keep first 3 digits", "Quarantine"],
  ];
  const qualityRules = [
    ["user_id", "Must not be null", "Error", "Fail Run"],
    ["price_usd", "Must be greater than 0", "Error", "Drop Row"],
    ["country", "Must be one of USA, KOR, JPN", "Warning", "Warn"],
    ["user_email", "Must match email regex pattern", "Warning", "Quarantine"],
    ["order_id", "Must be unique across set", "Error", "Fail Run"],
  ];
  const validationRows = [
    ["Row #1024", "Pass", "All checks passed"],
    ["Row #1025", "Fail", "price_usd (-15.0) < 0"],
    ["Row #1026", "Pass", "All checks passed"],
    ["Row #1027", "Fail", "user_id is NULL"],
    ["Row #1028", "Pass", "All checks passed"],
  ];

  const testRules = () => {
    onAction("etl.transform.tested", "/api/etl/transform-rules/test", "customer_review_raw");
    onDraftChange({ ruleSummary: "5 rules tested · 94.2% pass · 3 invalid rows" });
    onNotify("샘플 Transform 테스트가 통과되었습니다.");
  };

  const ruleAction = (action: string, path: string, ruleSummary?: string) => {
    onAction(action, path, "customer_review_raw");
    if (ruleSummary) {
      onDraftChange({ ruleSummary });
    }
  };

  const saveRuleDraft = () => {
    onDraftChange({ ruleSummary: "5 quality rules · quarantine invalid rows" });
    onSave();
  };

  const goNext = () => {
    onDraftChange({ ruleSummary: "5 quality rules · quarantine invalid rows" });
    onNext();
  };

  return (
    <CreationFlowLayout
      side={<CreationSummaryPanel flow="rules" title="처리 요약" onPrev={onPrev} onNext={goNext} onSave={saveRuleDraft} />}
    >
        <PageTitle title="Rule Application" description="필드 매핑, 타입 변환, Null 처리, 검증 규칙을 적용해 Lake 저장 전 데이터를 정리합니다." />
        <div className="review-card-grid compact-cards">
          {[
            ["Active Rules", "5"],
            ["Affected Cols", "12/48"],
            ["Health", "94.2% Passed"],
            ["Invalid Rows", "3 Invalid Rows Detected"],
          ].map(([label, value]) => (
            <article className="review-mini-card" key={label}>
              <strong>{label}</strong>
              <span>{value}</span>
            </article>
          ))}
        </div>
        <div className="hegun-rule-layout">
          <section className="panel hegun-console-panel">
            <div className="panel-header">
              <BookOpen size={18} />
              <h2>Rule Library</h2>
              <span className="panel-note">Transformation · Quality & Validation</span>
            </div>
            <div className="hegun-rule-library">
              <article><strong>Transformation</strong><span>Type Cast, Map</span></article>
              <article><strong>Quality & Validation</strong><span>Check Integrity</span></article>
              <article className="wide"><strong>Auto-Validation</strong><span>Real-time quality checks are enabled. Every rule change triggers a preview update on the sampled 1k rows.</span></article>
            </div>
          </section>
          <section className="panel hegun-console-panel">
            <div className="panel-header">
              <Settings size={18} />
              <h2>Configure New Quality Rule</h2>
              <span className="panel-note">Define validation logic for a specific data field.</span>
            </div>
            <div className="hegun-rule-builder">
              <label className="hegun-rule-field wide">
                <span>Validation Type</span>
                <div className="hegun-rule-options">
                  {["Not Null", "Range Check", "Accepted Values", "Unique", "Regex"].map((option) => (
                    <button className={option === "Range Check" ? "active" : ""} key={option} type="button" onClick={() => ruleAction("etl.rules.validation_type_selected", `/api/etl/rules/types/${option}`, `${option} rule selected`) }>{option}</button>
                  ))}
                </div>
              </label>
              <label className="hegun-rule-field">
                <span>Target Column</span>
                <div className="hegun-rule-select">
                  <strong>price_usd</strong>
                  <em>Decimal · 98.4% valid</em>
                </div>
              </label>
              <label className="hegun-rule-field">
                <span>Severity Level</span>
                <div className="hegun-rule-toggle">
                  <button type="button" onClick={() => ruleAction("etl.rules.severity_selected", "/api/etl/rules/severity/warning", "5 quality rules · warning severity selected")}>Warning</button>
                  <button className="active" type="button" onClick={() => ruleAction("etl.rules.severity_selected", "/api/etl/rules/severity/error", "5 quality rules · error severity selected")}>Error</button>
                </div>
              </label>
              <label className="hegun-rule-field wide">
                <span>Failure Action</span>
                <div className="hegun-rule-options compact">
                  {["Warn", "Drop Row", "Quarantine", "Fail Run"].map((option) => (
                    <button className={option === "Quarantine" ? "active" : ""} key={option} type="button" onClick={() => ruleAction("etl.rules.failure_action_selected", `/api/etl/rules/failure-actions/${option}`, `${option} failure action selected`)}>{option}</button>
                  ))}
                </div>
              </label>
              <label className="hegun-rule-field wide">
                <span>Condition / Value Expression</span>
                <div className="hegun-rule-expression">
                  <code>value &gt;= 0 AND value &lt;= 10000</code>
                  <em>sample pass rate 97.8%</em>
                </div>
              </label>
            </div>
            <div className="hegun-rule-footer">
              <div>
                <strong>Preview changes in real-time</strong>
                <span>1,000 sampled rows · 22 rows will be quarantined</span>
              </div>
              <button className="primary-button" type="button" onClick={() => ruleAction("etl.rules.added", "/api/etl/rules", "6 quality rules · price_usd range check added")}>Add Rule</button>
            </div>
          </section>
        </div>
        <section className="panel hegun-console-panel">
          <div className="panel-header">
            <Settings size={18} />
            <h2>Transformation Recipe Steps</h2>
            <span className="panel-note">sample first, full dataset during execution</span>
          </div>
          <div className="hegun-table-scroll">
            <table className="schema-table">
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Input</th>
                  <th>Operation</th>
                  <th>Output</th>
                  <th>Params</th>
                  <th>On Error</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((row) => (
                  <tr key={`${row[0]}-${row[1]}`}>
                    {row.map((cell, cellIndex) => <td key={`${row[0]}-${cellIndex}`}>{cell}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="panel hegun-console-panel">
          <div className="panel-header">
            <ShieldCheck size={18} />
            <h2>Applied Quality Rules</h2>
            <span className="panel-note">Real-time validation enabled</span>
          </div>
          <div className="hegun-toolbar">
            <button className="secondary-button" type="button" onClick={() => ruleAction("etl.rules.revalidated", "/api/etl/rules/revalidate", "5 rules revalidated · 94.2% pass · 3 invalid rows")}>Re-validate</button>
            <button className="secondary-button" type="button" onClick={() => ruleAction("etl.rules.cleared", "/api/etl/rules/clear", "0 active rules · validation disabled")}>Clear All</button>
          </div>
          <div className="hegun-table-scroll">
            <table className="schema-table">
              <thead>
                <tr>
                  <th>Column</th>
                  <th>Rule</th>
                  <th>Severity</th>
                  <th>Failure Action</th>
                </tr>
              </thead>
              <tbody>
                {qualityRules.map((row) => (
                  <tr key={`${row[0]}-${row[1]}`}>
                    {row.map((cell, index) => <td key={`${row[0]}-${index}`}>{index === 3 ? `Action: ${cell}` : cell}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="panel hegun-console-panel">
          <div className="panel-header">
            <FileText size={18} />
            <h2>Before / After Preview</h2>
          </div>
          <div className="form-grid">
            <Field label="Input Value" value={'{ "user": { "contact": { "email": "Jane.Doe@Acme.com" } } }'} wide />
            <Field label="Output Value" value="Jane.Doe@Acme.com" />
            <Field label="Sample Rows" value="1,000" />
            <Field label="Matched Rows" value="997" />
            <Field label="Generated Spec" value="json_path($.user.contact.email) → lower() → trim()" wide />
          </div>
          <InfoBox title="테스트 결과" body="샘플 1,000건 기준 변환 성공 998건, 검토 필요 2건입니다." />
        </section>
        <section className="panel hegun-console-panel">
          <div className="panel-header">
            <Check size={18} />
            <h2>Validation Results</h2>
            <span className="panel-note">SAMPLE N=1000</span>
          </div>
          <div className="hegun-validation-summary">
            <strong>3 Rows Failed Validation</strong>
            <span>Missing user_id (2 rows)</span>
            <span>Non-positive price_usd (1 row)</span>
          </div>
          <div className="hegun-table-scroll">
            <table className="schema-table">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Status</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {validationRows.map((row) => (
                  <tr key={row[0]}>
                    {row.map((cell, cellIndex) => <td key={`${row[0]}-${cellIndex}`}>{cell}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <div className="form-actions inline">
          <button className="secondary-button" type="button" onClick={testRules}>룰 테스트</button>
        </div>
    </CreationFlowLayout>
  );
}

function RepeatSettings({
  onDayChange,
  onTimeChange,
  selectedDay,
  time,
}: {
  onDayChange: (day: string) => void;
  onTimeChange: (time: string) => void;
  selectedDay: string;
  time: string;
}) {
  return (
    <section className="panel">
      <div className="panel-header">
        <Repeat2 size={18} />
        <h2>반복 실행 상세 설정</h2>
      </div>
      <div className="form-grid">
        <Field label="반복 주기" value="매주" />
        <div className="field wide">
          <span>실행 요일</span>
          <div className="weekday-group">
            {["월", "화", "수", "목", "금", "토", "일"].map((day) => (
              <button className={day === selectedDay ? "weekday active" : "weekday"} key={day} type="button" onClick={() => onDayChange(day)}>
                {day}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span>실행 시간</span>
          <input className="input control-input" value={time} onChange={(event) => onTimeChange(event.target.value)} />
        </label>
        <Field label="시간대" value="(GMT+09:00) Seoul, Tokyo" />
        <Field label="시작 날짜" value="07/02/2026" icon={<Calendar size={16} />} />
        <Field label="종료 날짜" value="mm/dd/yyyy" icon={<Calendar size={16} />} muted />
      </div>
      <InfoBox title="실행 미리보기" body={`매주 ${selectedDay}요일 ${time}에 실행됩니다. 다음 실행 예정: 2026.07.09 ${time}`} />
      <label className="policy-check-row">
        <input type="checkbox" defaultChecked />
        <span>
          <strong>과거 데이터 소급 (Backfill)</strong>
          <small>파이프라인 생성 시점 이전의 누락된 구간 데이터를 자동으로 처리합니다.</small>
        </span>
      </label>
      <RetryPolicy />
    </section>
  );
}

function ManualSettings() {
  return (
    <section className="panel">
      <div className="panel-header">
        <PlayCircle size={18} />
        <h2>수동 실행 상세 설정</h2>
      </div>
      <InfoBox title="자동 스케줄 없음" body="이 파이프라인은 저장 후 사용자가 직접 실행할 때만 동작합니다. 테스트 실행이나 필요할 때만 데이터를 적재하는 작업에 적합합니다." />
      <div className="policy-section">
        <h3>실행 정책</h3>
        <label className="policy-check-row compact">
          <input type="checkbox" defaultChecked />
          <span>
            <strong>실패 시 재시도 활성화</strong>
            <small>수동 실행 중 오류가 발생하면 지정한 정책에 따라 자동 재시도합니다.</small>
          </span>
        </label>
      </div>
      <RetryPolicy />
      <InfoBox title="자동 실행 예정 없음" body="저장 후 필요할 때 직접 실행할 수 있으며, 다음 실행 일시는 생성되지 않습니다." />
    </section>
  );
}

function OnceSettings({ dateTime, onDateTimeChange }: { dateTime: string; onDateTimeChange: (dateTime: string) => void }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <Clock3 size={18} />
        <h2>1회 실행 상세 설정</h2>
      </div>
      <div className="form-grid">
        <label className="field">
          <span>실행 예정 일시</span>
          <input className="input control-input" value={dateTime} onChange={(event) => onDateTimeChange(event.target.value)} />
        </label>
        <Field label="시간대" value="Asia/Seoul (GMT+09:00)" icon={<Clock3 size={16} />} />
      </div>
      <InfoBox title="실행 미리보기" body={`${dateTime}에 한 번 실행됩니다. 실행 완료 후 반복되지 않습니다.`} />
      <div className="policy-section">
        <h3>실행 정책</h3>
        <label className="policy-check-row compact">
          <input type="checkbox" defaultChecked />
          <span>
            <strong>실패 시 재시도</strong>
            <small>예약 실행 실패 시 재시도 정책을 적용합니다.</small>
          </span>
        </label>
      </div>
      <RetryPolicy />
    </section>
  );
}

export function TargetPage({
  draft,
  onDraftChange,
  onPrev,
  onNext,
  onSave,
}: {
  draft: DraftPipeline;
  onDraftChange: (patch: DraftPipelinePatch) => void;
  onPrev: () => void;
  onNext: () => void;
  onSave: () => void;
}) {
  const [selectedLayer, setSelectedLayer] = useState<TargetLayer>(draft.target.layer);
  const [targetDataset, setTargetDataset] = useState(draft.target.datasetName);
  const [targetOwner, setTargetOwner] = useState(draft.permission.owner);
  const [targetDescription, setTargetDescription] = useState("고객 리뷰 분석용 정제 데이터셋");
  const [targetFormat, setTargetFormat] = useState(draft.target.format);
  const [ragEnabled, setRagEnabled] = useState(draft.target.rag);
  const applyTargetDraft = () => {
    onDraftChange({
      jobName: `${targetDataset}_pipeline`,
      owner: targetOwner,
      targetDataset,
      targetFormat,
      targetLayer: selectedLayer,
      rag: ragEnabled,
    });
  };
  const selectLayer = (format: string) => {
    const layer = format.toUpperCase() as TargetLayer;
    setSelectedLayer(layer);
    onDraftChange({ targetLayer: layer });
  };
  const toggleRag = () => {
    const next = !ragEnabled;
    setRagEnabled(next);
    onDraftChange({ rag: next });
  };
  const goNext = () => {
    applyTargetDraft();
    onNext();
  };

  return (
    <CreationFlowLayout
      side={<CreationSummaryPanel flow="target" title="생성 요약" onPrev={onPrev} onNext={goNext} onSave={() => {
        applyTargetDraft();
        onSave();
      }} />}
    >
        <PageTitle title="타겟 설정" description="가공된 데이터가 저장될 위치와 포맷, RAG 인덱싱 여부를 설정합니다." />
        <section className="panel">
          <div className="panel-header">
            <HardDrive size={18} />
            <h2>기본 저장소 설정</h2>
          </div>
          <div className="form-grid">
            <label className="field">
              <span>타겟 데이터셋 이름</span>
              <input className="input control-input" value={targetDataset} onChange={(event) => {
                setTargetDataset(event.target.value);
                onDraftChange({ jobName: `${event.target.value}_pipeline`, targetDataset: event.target.value });
              }} />
            </label>
            <label className="field">
              <span>소유자</span>
              <input className="input control-input" value={targetOwner} onChange={(event) => {
                setTargetOwner(event.target.value);
                onDraftChange({ owner: event.target.value });
              }} />
            </label>
            <label className="field wide">
              <span>설명</span>
              <input className="input control-input" value={targetDescription} onChange={(event) => setTargetDescription(event.target.value)} />
            </label>
          </div>
          <div className="tag-row">
            {[targetDataset.replace(/_gold$/, ""), "sentiment_analysis", ragEnabled ? "rag_ready" : "rag_disabled"].map((tag) => (
              <span className="tag" key={tag}>{tag}</span>
            ))}
            <button className="ghost-link" type="button" onClick={() => onDraftChange({ rag: ragEnabled })}>+ 추가</button>
          </div>
        </section>
        <section className="panel">
          <div className="panel-header">
            <Database size={18} />
            <h2>저장소 및 포맷 설정</h2>
          </div>
          <div className="format-grid">
            {["RAW", "Bronze", "Silver", "Gold"].map((format) => (
              <button className={format.toUpperCase() === selectedLayer ? "format-card active" : "format-card"} key={format} type="button" onClick={() => selectLayer(format)}>
                {format}
              </button>
            ))}
          </div>
          <div className="form-grid">
            <Field label="저장소 유형" value="S3" />
            <label className="field">
              <span>파일 포맷</span>
              <select className="input control-input" value={targetFormat} onChange={(event) => {
                setTargetFormat(event.target.value);
                onDraftChange({ targetFormat: event.target.value });
              }}>
                <option>Parquet</option>
                <option>Delta</option>
                <option>Iceberg</option>
                <option>CSV</option>
              </select>
            </label>
            <Field label="파티션" value="year/month/region" />
            <Field label="압축" value="Snappy" />
            <Field label="저장 경로" value={`s3a://asklake-output/${targetDataset}/${selectedLayer.toLowerCase()}/`} wide />
          </div>
          <div className="target-status-grid">
            <StatusTile label="카탈로그 등록" value="생성 후 자동 등록" status="Ready" />
            <StatusTile label="경로 검증" value="쓰기 권한 확인 완료" status="Valid" />
          </div>
        </section>
        <section className="panel">
          <div className="panel-header">
            <Search size={18} />
            <h2>RAG 설정</h2>
          </div>
          <div className="form-grid">
            <label className="field">
              <span>RAG 인덱싱</span>
              <button className={ragEnabled ? "input control-toggle active" : "input control-toggle"} type="button" onClick={toggleRag}>
                {ragEnabled ? "활성화" : "비활성화"}
              </button>
            </label>
            <Field label="임베딩 모델" value="text-embedding-3-small" />
            <Field label="청킹 전략" value="Recursive Character" />
            <Field label="청크 크기" value="1,000 Tokens" />
            <Field label="오버랩" value="200 Tokens" />
            <Field label="인덱스 생성 예정" value="파이프라인 생성 후 자동 큐잉" />
          </div>
        </section>
    </CreationFlowLayout>
  );
}

export function PermissionPage({
  draft,
  onDraftChange,
  onNext,
  onPrev,
  onSave,
}: {
  draft: DraftPipeline;
  onDraftChange: (patch: DraftPipelinePatch) => void;
  onNext: () => void;
  onPrev: () => void;
  onSave: () => void;
}) {
  const roles = [
    { name: "Data Engineer Group", access: ["조회", "쿼리 실행", "메타데이터", "관리"], checked: true, note: "파이프라인 운영 및 장애 대응 권한" },
    { name: "Data Analyst Group", access: ["조회", "쿼리 실행", "메타데이터"], checked: true, note: "분석 업무용 표준 접근 권한" },
    { name: "ML Team", access: ["조회", "메타데이터"], checked: false, note: "RAG 인덱스 검증 후 확장 예정" },
  ];
  const [permissionTemplate, setPermissionTemplate] = useState("Data Engineer Group");
  const [visibility, setVisibility] = useState("조직 내부");
  const [dataOwner, setDataOwner] = useState(draft.permission.owner || "data-team-01");
  const [approvalStatus, setApprovalStatus] = useState("승인 검토");
  const [roleChecks, setRoleChecks] = useState<Record<string, boolean>>(() => Object.fromEntries(roles.map((role) => [role.name, role.checked])));
  const permissionSummary = `${permissionTemplate} · ${visibility} · ${approvalStatus}`;

  const applyPermissionDraft = () => {
    onDraftChange({
      owner: dataOwner,
      permissionSummary,
    });
  };
  const goNext = () => {
    applyPermissionDraft();
    onNext();
  };

  return (
    <CreationFlowLayout
      variant="permission"
      side={(
        <CreationValidationPanel
          className="permission-aside"
          title="거버넌스 체크"
          actions={<CreationPanelActions withDivider onPrev={onPrev} onSave={() => {
            applyPermissionDraft();
            onSave();
          }} onNext={goNext} />}
        >
          <StatusTile label="공유 범위" value={visibility} status={visibility === "외부 공유" ? "Review" : "Safe"} />
          <StatusTile label="민감 데이터" value="review_text 포함" status="Review" />
          <StatusTile label="승인자" value={dataOwner} status={approvalStatus === "승인 완료" ? "Ready" : "Pending"} />
        </CreationValidationPanel>
      )}
    >
        <PageTitle title="권한 설정" description="생성할 데이터셋에 접근할 수 있는 역할과 사용자를 선택하세요." icon={<ShieldCheck size={24} />} />
        <section className="panel permission-share-panel">
          <div className="panel-header">
            <ShieldCheck size={18} />
            <h2>공유 대상</h2>
          </div>
          <InfoBox title="추천 권한 템플릿" body="유사 데이터셋의 접근 권한과 조직 정책을 기반으로 추천되었습니다." />
          <div className="form-grid">
            <label className="field">
              <span>권한 템플릿</span>
              <select className="input control-input" value={permissionTemplate} onChange={(event) => {
                setPermissionTemplate(event.target.value);
                onDraftChange({ permissionSummary: `${event.target.value} · ${visibility} · ${approvalStatus}` });
              }}>
                <option>Data Engineer Group</option>
                <option>Data Analyst Group</option>
                <option>ML Team</option>
              </select>
            </label>
            <label className="field">
              <span>공개 범위</span>
              <select className="input control-input" value={visibility} onChange={(event) => {
                setVisibility(event.target.value);
                onDraftChange({ permissionSummary: `${permissionTemplate} · ${event.target.value} · ${approvalStatus}` });
              }}>
                <option>조직 내부</option>
                <option>프로젝트 멤버</option>
                <option>외부 공유</option>
              </select>
            </label>
            <label className="field">
              <span>데이터 오너</span>
              <input className="input control-input" value={dataOwner} onChange={(event) => {
                setDataOwner(event.target.value);
                onDraftChange({ owner: event.target.value });
              }} />
            </label>
            <label className="field">
              <span>승인 상태</span>
              <select className="input control-input" value={approvalStatus} onChange={(event) => {
                setApprovalStatus(event.target.value);
                onDraftChange({ permissionSummary: `${permissionTemplate} · ${visibility} · ${event.target.value}` });
              }}>
                <option>승인 검토</option>
                <option>승인 완료</option>
                <option>오너 승인 필요</option>
              </select>
            </label>
          </div>
        </section>
        <section className="panel">
          <h2 className="panel-title">세부 권한</h2>
          <div className="permission-list">
            {roles.map((role) => (
              <label className="permission-row detailed" key={role.name}>
                <input type="checkbox" checked={roleChecks[role.name]} onChange={(event) => setRoleChecks((checks) => ({ ...checks, [role.name]: event.target.checked }))} />
                <span>
                  <strong>{role.name}</strong>
                  <small>{role.note}</small>
                </span>
                <div className="permission-chip-row">
                  {["조회", "쿼리 실행", "메타데이터", "관리"].map((item) => (
                    <em className={role.access.includes(item) ? "allowed" : ""} key={item}>{item}</em>
                  ))}
                </div>
              </label>
            ))}
          </div>
          <InfoBox title="권한 검토 필요" body="외부 공유 또는 민감 데이터 접근 권한은 데이터 오너 승인 후 적용됩니다." />
        </section>
    </CreationFlowLayout>
  );
}

export function ReviewPage({ draft, onCreate, onEdit, onSave }: { draft: DraftPipeline; onCreate: () => void; onEdit: (flow: FlowId) => void; onSave: () => void }) {
  const request = toCreatePipelineRequest(draft);
  const schemaRows = [
    ["review_id", "BIGINT", "NO", "SOURCE.id"],
    ["product_id", "STRING", "NO", "SOURCE.p_code"],
    ["rating", "INT", "YES", "CAST(SOURCE.score AS INT)"],
    ["review_title", "STRING", "YES", "TRIM(SOURCE.title)"],
    ["review_text", "STRING", "YES", "REGEXP_REPLACE(SOURCE.content, \"[\\n\\r]\", \" \")"],
    ["created_at", "TIMESTAMP", "NO", "CURRENT_TIMESTAMP()"],
  ];
  const sourceSummary = request.sourceConfig.slice(0, 3).map(([label, value]) => `${label}: ${value}`).join(" · ");

  return (
    <CreationFlowLayout
      variant="review"
      side={(
        <CreationValidationPanel
          title="최종 유효성 검사"
          actions={<CreationPanelActions withDivider nextLabel="파이프라인 생성" onPrev={() => onEdit("target")} onSave={onSave} onNext={onCreate} />}
        >
          {["소스 연결 완료", "처리 테스트 통과", "스케줄 유효함", "권한 선택됨", "타겟 설정 유효함"].map((item) => (
            <div className="validation-row" key={item}>
              <Check size={16} />
              <span>{item}</span>
              <strong>유효함</strong>
            </div>
          ))}
          <InfoBox title="안내사항" body="파이프라인 생성 후 데이터 카탈로그에서 즉시 조회 및 SQL 쿼리를 수행할 수 있습니다." />
        </CreationValidationPanel>
      )}
    >
        <PageTitle title="검토 및 생성" description="설정된 모든 구성을 확인하고 데이터 파이프라인 생성을 완료하세요." />
        <div className="review-card-grid">
          {[
            ["기본 정보", request.targetDataset, "target"],
            ["소스", `${request.sourceType} · ${sourceSummary || request.sourceLabel}`, "source"],
            ["스키마", request.schemaSummary, "schema"],
            ["처리 규칙", request.ruleSummary, "rules"],
            ["스케줄", request.scheduleLabel, "repeat"],
            ["권한", request.permissionSummary, "permission"],
            ["타겟 저장소", `${request.targetLayer} / ${request.targetFormat}`, "target"],
          ].map(([label, value, flow]) => (
            <article className="review-mini-card" key={label}>
              <span className="review-card-icon">{flow === "permission" ? <ShieldCheck size={14} /> : flow === "repeat" ? <Calendar size={14} /> : flow === "rules" || flow === "schema" ? <SlidersHorizontal size={14} /> : <Database size={14} />}</span>
              <strong>{label}</strong>
              <span>{value}</span>
              <button type="button" onClick={() => onEdit(flow as FlowId)}>수정</button>
            </article>
          ))}
        </div>
        <section className="panel">
          <div className="panel-header">
            <Database size={18} />
            <h2>출력 스키마 미리보기</h2>
            <span className="panel-note">{request.schemaSummary}</span>
          </div>
          <table className="schema-table">
            <thead>
              <tr>
                <th>컬럼명</th>
                <th>타입</th>
                <th>Null 허용</th>
                <th>변환식</th>
              </tr>
            </thead>
            <tbody>
              {schemaRows.map((row, rowIndex) => (
                <tr key={`${row[0]}-${rowIndex}`}>
                  {row.map((cell, cellIndex) => <td key={`${row[0]}-${cellIndex}`}>{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
    </CreationFlowLayout>
  );
}
