import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { canonicalSchemaType } from "./profile.mjs";
import { defaultRawBucket, objectStorageProvider, resolveObjectStorageConfig, s3ClientOptions } from "./objectStorageConfig.mjs";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.resolve(process.env.ASKLAKE_REVIEW_ANALYSIS_DIR || path.join(backendDir, "tmp", "review-row-analysis"));
const defaultLimit = boundedPositiveInt(process.env.ASKLAKE_REVIEW_ANALYSIS_DEFAULT_LIMIT, 25, 1, 500000);
const maxInteractiveLimit = boundedPositiveInt(process.env.ASKLAKE_REVIEW_ANALYSIS_MAX_LIMIT, 200000, 1000, 1000000);
const reviewAiMaxRows = boundedPositiveInt(process.env.ASKLAKE_REVIEW_AI_MAX_ROWS, 100, 1, 1000);
const reviewAiConcurrency = boundedPositiveInt(process.env.ASKLAKE_REVIEW_AI_CONCURRENCY, 4, 1, 8);
const aiGatewayBaseUrl = String(process.env.AI_GATEWAY_BASE_URL || "http://127.0.0.1:8090").replace(/\/$/, "");
const aiGatewayToken = String(process.env.AI_GATEWAY_SERVICE_TOKEN || "");
const aiGatewayTimeoutMs = boundedPositiveInt(
  process.env.AI_GATEWAY_TIMEOUT_MS,
  boundedPositiveInt(process.env.AI_GATEWAY_TIMEOUT_SECONDS, 120, 1, 600) * 1000,
  1000,
  600000,
);
const aiGatewayMaxResponseBytes = boundedPositiveInt(
  process.env.AI_GATEWAY_MAX_RESPONSE_BYTES,
  1024 * 1024,
  16 * 1024,
  8 * 1024 * 1024,
);
const reviewAiMaxInputChars = boundedPositiveInt(process.env.ASKLAKE_REVIEW_AI_MAX_INPUT_CHARS, 9000, 1000, 50000);
const defaultReviewSchemaTemplateId = "amazon-review-structured-v1";

const supportedReviewAnalysisMethods = [
  "copy",
  "one_of_values",
  "instruction",
];

const reviewAnalysisMethodAliases = {
  copy_or_extract_field: "copy",
  custom_instruction: "instruction",
  copy: "copy",
  instruction: "instruction",
  issue_taxonomy: "one_of_values",
  issue_category: "one_of_values",
  issue_subcategory: "one_of_values",
  severity_4level: "one_of_values",
  text_classification: "one_of_values",
  sentiment: "one_of_values",
  sentiment_3way: "one_of_values",
  issue_present: "one_of_values",
  issue_present_binary: "one_of_values",
  action_needed: "one_of_values",
  action_needed_binary: "one_of_values",
  boolean_y_n: "one_of_values",
  summary: "instruction",
  evidence: "instruction",
  extractive_summary: "instruction",
  evidence_span: "instruction",
};

export async function getCellphonesReviewAnalysisStatus() {
  return {
    status: "idle",
    message: "실행 상태는 FastAPI의 영속 실행 레코드에서 조회합니다.",
    source: sourceDescriptor(defaultReviewSource()),
  };
}

export async function suggestReviewAnalysisSchema(request = {}) {
  const sourceColumns = Array.isArray(request.sourceColumns) ? request.sourceColumns.slice(0, 40) : [];
  const sampleRows = Array.isArray(request.sampleRows) ? request.sampleRows.slice(0, 3) : [];
  const payload = await callAiGateway(
    "review_schema",
    "Suggest an editable structured review-analysis schema.",
    { sourceColumns, sampleRows },
  );
  const columns = normalizeSuggestedColumns(payload.output?.columns);
  if (columns.length === 0) {
    throw Object.assign(new Error("AI Gateway returned no usable schema columns."), {
      code: "REVIEW_SCHEMA_SUGGESTION_EMPTY",
      status: 502,
    });
  }
  return {
    columns,
    model: payload.model,
    source: "ai-gateway",
    status: "success",
  };
}

export async function runReviewAnalysis(request = {}) {
  const { limit, outputSchema, runtime, usesDefaultSchemaTemplate } = reviewRunConfiguration(request);
  const startedAt = new Date();
  const sourceConfig = normalizeReviewSource(request.source);
  const requestedRunId = safeRunId(request.runId);
  const runId = requestedRunId || `review_${startedAt.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`;
  const { runDir, outputPath, csvOutputPath, summaryPath } = reviewRunPaths(runId);

  mkdirSync(runDir, { recursive: true });
  const result = initialSummary({
    limit,
    csvOutputPath,
    outputPath,
    outputSchema,
    schemaSource: usesDefaultSchemaTemplate ? "builtin_template" : "user_defined",
    runId,
    runtime,
    sourceConfig,
    startedAt,
    summaryPath,
  });
  const output = createWriteStream(outputPath, { encoding: "utf8" });
  const csvOutput = createWriteStream(csvOutputPath, { encoding: "utf8" });
  const trainingRows = [];
  const gatewayUsage = [];
  csvOutput.write(`${outputSchema.map((column) => csvEscape(column.targetName)).join(",")}\n`);
  const source = await openReviewSource(sourceConfig);
  let stderr = "";
  source.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 12000) stderr = stderr.slice(-12000);
  });

  const lineReader = readline.createInterface({
    crlfDelay: Infinity,
    input: source.input,
  });

  try {
    const sourceRows = await readReviewSourceRows(lineReader, source, result, limit);
    await analyzeAndWriteReviewRows({
      sourceRows,
      outputSchema,
      result,
      output,
      csvOutput,
      trainingRows,
      gatewayUsage,
    });
  } finally {
    await Promise.all([closeWritable(output), closeWritable(csvOutput)]);
  }

  const exit = await source.wait;
  if (exit !== 0 && result.processedRows === 0) {
    throw Object.assign(new Error(`Review source stream failed. ${stderr || `exit=${exit}`}`), {
      code: "REVIEW_ANALYSIS_STREAM_FAILED",
      status: 502,
    });
  }

  finalizeSummary(result, {
    finishedAt: new Date(),
    stderr,
  });
  writeFileSync(summaryPath, JSON.stringify(result, null, 2), "utf8");
  return {
    ...result,
    __gatewayUsage: gatewayUsage,
    __trainingColumns: outputSchema,
    __trainingRows: trainingRows,
  };
}

function reviewRunConfiguration(request) {
  const requestedLimit = Number(request.limit);
  const full = request.full === true || requestedLimit === 0;
  const limit = full
    ? 0
    : Math.min(maxInteractiveLimit, boundedPositiveInt(requestedLimit, defaultLimit, 1, maxInteractiveLimit));
  const requestedSchema = request.schemaColumns ?? request.columns;
  const usesDefaultSchemaTemplate = !Array.isArray(requestedSchema) || requestedSchema.length === 0;
  const outputSchema = normalizeOutputSchema(requestedSchema);
  const requiresAi = outputSchema.some(
    (column) => normalizeReviewAnalysisMethod(column?.method ?? column?.analysisMethod, "copy") !== "copy",
  );
  if (full || limit > reviewAiMaxRows) {
    throw Object.assign(
      new Error(`AI Gateway review analysis is limited to ${reviewAiMaxRows} rows per interactive run. Submit bounded batches.`),
      { code: "REVIEW_AI_ROW_LIMIT_EXCEEDED", status: 422 },
    );
  }
  return {
    limit,
    outputSchema,
    runtime: requiresAi ? "gateway" : "direct_copy",
    usesDefaultSchemaTemplate,
  };
}

function reviewRunPaths(runId) {
  const runDir = path.join(outputRoot, runId);
  return {
    runDir,
    outputPath: path.join(runDir, "review_issue_rows.jsonl"),
    csvOutputPath: path.join(runDir, "review_issue_rows.csv"),
    summaryPath: path.join(runDir, "summary.json"),
  };
}

async function readReviewSourceRows(lineReader, source, result, limit) {
  const sourceRows = [];
  for await (const line of lineReader) {
    if (!line.trim()) continue;
    const row = parseJsonLine(line, result);
    if (!row) continue;
    sourceRows.push(row);
    if (limit > 0 && sourceRows.length >= limit) {
      source.stop();
      break;
    }
  }
  return sourceRows;
}

async function analyzeAndWriteReviewRows({
  sourceRows,
  outputSchema,
  result,
  output,
  csvOutput,
  trainingRows,
  gatewayUsage,
}) {
  const analyzedRows = await mapWithConcurrency(
    sourceRows,
    reviewAiConcurrency,
    (row, index) => analyzeReviewRowWithGateway(row, outputSchema, index + 1),
  );
  for (let index = 0; index < analyzedRows.length; index += 1) {
    const row = sourceRows[index];
    const analyzed = analyzedRows[index];
    const projected = analyzed.projected;
    if (analyzed.model && !result.analysis.models.includes(analyzed.model)) result.analysis.models.push(analyzed.model);
    if (analyzed.provider && !result.analysis.providers.includes(analyzed.provider)) result.analysis.providers.push(analyzed.provider);
    if (analyzed.usageRecord) gatewayUsage.push(analyzed.usageRecord);
    trainingRows.push(buildTrainingRow(row, projected, outputSchema));
    recordClassifiedRow(result, analyzed.metricsRow, projected);
    output.write(`${JSON.stringify(projected)}\n`);
    csvOutput.write(`${outputSchema.map((column) => csvEscape(projected[column.targetName])).join(",")}\n`);
  }
}

export async function runCellphonesReviewAnalysis(request = {}) {
  return runReviewAnalysis({ ...request, source: request.source ?? defaultReviewSource() });
}

function initialSummary({ csvOutputPath, limit, outputPath, outputSchema, runId, runtime, schemaSource, sourceConfig, startedAt, summaryPath }) {
  const storageLabel = objectStorageProvider() === "aws" ? "AWS S3" : "MinIO";
  return {
    analysis: {
      engine: "text-row-to-structured-csv",
      fallbackUsed: false,
      mode: runtime === "gateway" ? "ai_gateway" : "direct_copy",
      models: [],
      providers: [],
      schemaSource,
      schemaTemplateId: schemaSource === "builtin_template" ? defaultReviewSchemaTemplateId : null,
      rowRuntime: runtime === "gateway"
        ? {
          endpoint: redactEndpoint(aiGatewayBaseUrl),
          maxResponseBytes: aiGatewayMaxResponseBytes,
          timeoutMs: aiGatewayTimeoutMs,
        }
        : null,
      holdoutEvaluation: {
        metrics: [],
        reason: "Final quality is measured against labeled holdout data outside the transform definition.",
        status: "not_evaluated",
      },
      supportedMethods: supportedReviewAnalysisMethods,
    },
    categoryBreakdown: [],
    invalidRows: 0,
    limit,
    metrics: {
      actionNeededRows: 0,
      averageRating: 0,
      highSeverityRows: 0,
      issueRows: 0,
      negativeRows: 0,
      positiveRows: 0,
      totalHelpfulVotes: 0,
    },
    method: {
      name: "text-row-structuring",
      note: runtime === "gateway"
        ? `Streams the real ${storageLabel} JSONL source through the AskLake AI Gateway and writes the user-defined final CSV schema.`
        : `Copies the requested fields from the real ${storageLabel} JSONL source without invoking an AI model.`,
      schema: outputSchema.map((column) => column.targetName),
    },
    output: {
      csvPath: csvOutputPath,
      jsonlPath: outputPath,
      summaryPath,
    },
    processedRows: 0,
    rows: [],
    runId,
    sentimentBreakdown: [],
    severityBreakdown: [],
    source: sourceDescriptor(sourceConfig),
    startedAt: startedAt.toISOString(),
    status: "running",
    stoppedAtLimit: limit > 0,
  };
}

function defaultReviewSource() {
  return {
    bucket: process.env.ASKLAKE_CELLPHONES_REVIEW_BUCKET || defaultRawBucket(),
    key: process.env.ASKLAKE_CELLPHONES_REVIEW_KEY || "amazon_reviews/cell_phones_and_accessories/reviews/Cell_Phones_and_Accessories.jsonl",
  };
}

function normalizeReviewSource(source) {
  const fallback = defaultReviewSource();
  const bucket = String(source?.bucket || fallback.bucket).trim();
  const key = String(source?.key || fallback.key).trim();
  if (!bucket || !key || /[\r\n\0]/.test(`${bucket}${key}`)) {
    throw Object.assign(new Error("Review source bucket and key are required."), {
      code: "REVIEW_SOURCE_INVALID",
      status: 422,
    });
  }
  return { bucket, key };
}

function sourceDescriptor(source) {
  const provider = objectStorageProvider();
  return {
    bucket: source.bucket,
    key: source.key,
    object: `s3://${source.bucket}/${source.key}`,
    provider,
    runtime: provider === "minio" ? "S3-compatible streaming client" : "AWS SDK default credential chain",
  };
}

function safeRunId(value) {
  const normalized = String(value ?? "").trim();
  return /^[a-zA-Z0-9_-]{1,120}$/.test(normalized) ? normalized : "";
}

function redactEndpoint(value) {
  try {
    const url = new URL(String(value || ""));
    return url.origin;
  } catch {
    return "internal-ai-gateway";
  }
}

async function analyzeReviewRowWithGateway(rawRow, outputSchema, ordinal) {
  const requestedColumns = outputSchema
    .map((column) => ({
      allowedValues: allowedValuesForMethod(column),
      instruction: String(column?.instruction || "").trim(),
      method: normalizeReviewAnalysisMethod(column?.method ?? column?.analysisMethod, "copy"),
      targetName: column.targetName,
      type: normalizeSchemaType(column.type),
    }))
    .filter((column) => column.method !== "copy");
  if (requestedColumns.length === 0) {
    const projected = coerceLlmProjectedRow({}, outputSchema, rawRow, ordinal);
    return {
      metricsRow: metricsRowFromProjected(projected, outputSchema, rawRow, ordinal),
      model: "",
      projected,
      provider: "",
      usageRecord: null,
    };
  }
  const payload = await callAiGateway(
    "review_row",
    `Analyze source review row ${ordinal}.`,
    {
      requestedColumns,
      rowOrdinal: ordinal,
      sourceRow: boundedSourceRow(rawRow, reviewAiMaxInputChars),
    },
  );
  const values = Array.isArray(payload.output?.values) ? payload.output.values : [];
  if (values.length !== requestedColumns.length) {
    throw invalidGatewayRow("AI Gateway omitted or added review-analysis columns.");
  }
  const seenTargets = new Set();
  for (let index = 0; index < requestedColumns.length; index += 1) {
    const expected = requestedColumns[index];
    const actual = values[index];
    if (!actual || actual.targetName !== expected.targetName || seenTargets.has(actual.targetName)) {
      throw invalidGatewayRow("AI Gateway review-analysis targets were duplicated or returned out of order.");
    }
    seenTargets.add(actual.targetName);
    if (expected.method === "one_of_values" && !canonicalAllowedValue(actual.value, expected.allowedValues)) {
      throw invalidGatewayRow(`AI Gateway returned a value outside allowedValues for '${expected.targetName}'.`);
    }
  }
  const parsed = Object.fromEntries(values.map((item) => [item?.targetName, item?.value]));
  const projected = coerceLlmProjectedRow(parsed, outputSchema, rawRow, ordinal);
  return {
    metricsRow: metricsRowFromProjected(projected, outputSchema, rawRow, ordinal),
    model: String(payload.model || ""),
    projected,
    provider: String(payload.provider || ""),
    usageRecord: {
      model: payload.model,
      provider: payload.provider,
      requestId: payload.request_id,
      usage: payload.usage,
    },
  };
}

function invalidGatewayRow(message) {
  return Object.assign(new Error(message), {
    code: "REVIEW_AI_GATEWAY_INVALID_RESPONSE",
    status: 502,
  });
}

function buildTrainingRow(rawRow, projected, outputSchema) {
  const labels = {};
  for (const column of outputSchema) {
    if (normalizeReviewAnalysisMethod(column?.method ?? column?.analysisMethod, "copy") !== "one_of_values") continue;
    labels[column.targetName] = projected[column.targetName];
  }
  return {
    labels,
    rating: rawValueForColumn(rawRow, "rating") ?? rawValueForColumn(rawRow, "overall") ?? null,
    text: truncate(String(rawValueForColumn(rawRow, "text") ?? rawValueForColumn(rawRow, "review_text") ?? rawValueForColumn(rawRow, "reviewText") ?? ""), reviewAiMaxInputChars),
    title: truncate(String(rawValueForColumn(rawRow, "title") ?? rawValueForColumn(rawRow, "summary") ?? ""), 2_000),
  };
}

async function callAiGateway(mode, prompt, context) {
  if (!aiGatewayToken) {
    throw Object.assign(new Error("AI Gateway service token is not configured."), {
      code: "AI_GATEWAY_UNCONFIGURED",
      status: 503,
    });
  }
  const requestId = randomUUID();
  const response = await fetch(`${aiGatewayBaseUrl}/v1/generate`, {
    body: JSON.stringify({ context, mode, prompt, request_id: requestId, selected_dataset_ids: [] }),
    headers: {
      Authorization: `Bearer ${aiGatewayToken}`,
      "Content-Type": "application/json",
      "X-Request-ID": requestId,
    },
    method: "POST",
    signal: AbortSignal.timeout(aiGatewayTimeoutMs),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`AI Gateway review analysis failed: HTTP ${response.status}`), {
      code: "REVIEW_AI_GATEWAY_FAILED",
      status: response.status >= 500 ? 502 : response.status,
    });
  }
  const payload = await readBoundedJson(response, aiGatewayMaxResponseBytes);
  if (
    payload?.request_id !== requestId
    || payload?.mode !== mode
    || !payload?.output
    || typeof payload.output !== "object"
    || Array.isArray(payload.output)
    || !validGatewayIdentity(payload.provider, 100)
    || !validGatewayIdentity(payload.model, 255)
    || !validGatewayUsage(payload.usage)
  ) {
    throw Object.assign(new Error("AI Gateway returned an invalid review-analysis response."), {
      code: "REVIEW_AI_GATEWAY_INVALID_RESPONSE",
      status: 502,
    });
  }
  return payload;
}

async function readBoundedJson(response, maxBytes) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw invalidGatewayRow("AI Gateway review-analysis response exceeded the configured size limit.");
  }
  if (!response.body) {
    throw invalidGatewayRow("AI Gateway returned an empty review-analysis response.");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw invalidGatewayRow("AI Gateway review-analysis response exceeded the configured size limit.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalidGatewayRow("AI Gateway returned invalid review-analysis JSON.");
  }
}

function validGatewayIdentity(value, maxLength) {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= maxLength
    && !/[\r\n\0]/.test(value);
}

function validGatewayUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const integerKeys = ["inputTokens", "outputTokens", "totalTokens"];
  if (!integerKeys.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)) return false;
  if (!Number.isFinite(value.estimatedCostUsd) || value.estimatedCostUsd < 0) return false;
  return value.totalTokens >= value.inputTokens + value.outputTokens;
}

function allowedValuesForMethod(column) {
  const method = normalizeReviewAnalysisMethod(column?.method ?? column?.analysisMethod, "copy");
  const explicit = normalizeAllowedValues(column?.allowedValues);
  if (explicit.length > 0) return explicit;
  return [];
}

function coerceLlmProjectedRow(llmRow, outputSchema, rawRow, ordinal) {
  const projected = {};
  for (const column of outputSchema) {
    const targetName = column.targetName;
    const method = normalizeReviewAnalysisMethod(column?.method ?? column?.analysisMethod, "copy");
    const allowedValues = allowedValuesForMethod(column);
    let value = llmRow?.[targetName];
    if ((value === undefined || value === null || value === "") && method === "copy") {
      value = copyOrExtractFieldValue({ review_id: reviewId(rawRow, ordinal) }, column, rawRow);
    }
    if (allowedValues.length > 0) {
      value = canonicalAllowedValue(value, allowedValues) ?? "";
    }
    projected[targetName] = coerceOutputValue(value, column.type);
  }
  return projected;
}

function coerceOutputValue(value, type) {
  if (value === undefined || value === null) return "";
  const normalizedType = String(type ?? "").toLowerCase();
  if (normalizedType.includes("bool")) {
    if (typeof value === "boolean") return value;
    const normalized = normalizedScalar(value);
    if (["true", "1", "y", "yes"].includes(normalized)) return true;
    if (["false", "0", "n", "no"].includes(normalized)) return false;
    return value;
  }
  if (normalizedType.includes("int") || normalizedType.includes("float") || normalizedType.includes("double")) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : value;
  }
  return String(value);
}

function metricsRowFromProjected(projected, outputSchema, rawRow, ordinal) {
  const rating = Number(projected.rating ?? rawRow.rating ?? rawRow.overall ?? 0) || 0;
  return {
    action_needed_status: stringValue(projected.action_needed ?? projected.action_needed_status),
    action_reason_signal: stringValue(projected.action_reason_signal),
    asin: stringValue(projected.asin ?? rawRow.asin),
    evidence: stringValue(projected.evidence ?? projected.supporting_evidence ?? projected.reason),
    helpful_vote: Number(projected.helpful_vote ?? rawRow.helpful_vote ?? rawRow.helpfulVote ?? 0) || 0,
    issue_category: stringValue(projected.issue_category),
    issue_label: stringValue(projected.issue_category),
    issue_subcategory: stringValue(projected.issue_subcategory),
    parent_asin: stringValue(projected.parent_asin ?? rawRow.parent_asin),
    rating,
    review_id: stringValue(projected.review_id ?? reviewId(rawRow, ordinal)),
    sentiment: stringValue(projected.sentiment),
    severity: stringValue(projected.severity),
    summary: stringValue(projected.summary),
    timestamp: Number(projected.timestamp ?? rawRow.timestamp ?? 0) || null,
    title: stringValue(projected.title ?? rawRow.title),
    user_id: stringValue(projected.user_id ?? rawRow.user_id),
    verified_purchase: Boolean(projected.verified_purchase ?? rawRow.verified_purchase),
  };
}

function normalizeSuggestedColumns(columns) {
  if (!Array.isArray(columns)) return [];
  return columns
    .map((column) => ({
      instruction: String(column?.instruction ?? column?.description ?? column?.label ?? column?.targetName ?? "").trim(),
      label: String(column?.label ?? column?.targetName ?? "").trim(),
      method: normalizeReviewAnalysisMethod(column?.method ?? column?.analysisMethod, "copy"),
      nullable: column?.nullable !== false,
      sourceField: safeColumnName(column?.sourceField ?? ""),
      targetName: safeColumnName(column?.targetName ?? column?.name ?? ""),
      type: normalizeSchemaType(column?.type),
      allowedValues: normalizeAllowedValues(column?.allowedValues),
    }))
    .filter((column) => column.targetName)
    .slice(0, 20);
}

function normalizeSchemaType(value) {
  return canonicalSchemaType(value);
}

function normalizeOutputSchema(columns) {
  const defaultTemplate = [
    { instruction: "원본 row에서 리뷰 고유 ID를 생성", method: "copy", targetName: "review_id", type: "String" },
    { instruction: "상품 ASIN", method: "copy", targetName: "asin", type: "String" },
    { instruction: "상위 상품 ASIN", method: "copy", targetName: "parent_asin", type: "String" },
    { instruction: "원본 평점", method: "copy", targetName: "rating", type: "Double" },
    { allowedValues: ["positive", "mixed", "negative"], instruction: "후보값 중 하나로 감정을 선택", method: "one_of_values", targetName: "sentiment", type: "String" },
    { allowedValues: ["charging_power", "screen_display", "shipping_delivery", "listing_accuracy", "durability_quality", "no_issue", "other_issue"], instruction: "후보값 중 하나로 이슈 대분류를 선택", method: "one_of_values", targetName: "issue_category", type: "String" },
    { allowedValues: ["charging_or_power", "screen_or_display", "shipping_or_package", "listing_mismatch", "durability_or_quality", "positive_feedback", "other"], instruction: "후보값 중 하나로 이슈 세부 분류를 선택", method: "one_of_values", targetName: "issue_subcategory", type: "String" },
    { allowedValues: ["critical", "high", "medium", "low"], instruction: "후보값 중 하나로 심각도를 선택", method: "one_of_values", targetName: "severity", type: "String" },
    { instruction: "Summarize the review in one short factual sentence.", method: "instruction", targetName: "summary", type: "String" },
    { instruction: "Extract the source sentence that best supports the output.", method: "instruction", targetName: "evidence", type: "String" },
  ];
  const source = Array.isArray(columns) && columns.length > 0 ? columns : defaultTemplate;
  const seen = new Set();
  const normalized = [];
  for (const column of source) {
    const targetName = safeColumnName(column?.targetName ?? column?.name ?? column);
    if (!targetName || seen.has(targetName)) continue;
    seen.add(targetName);
    normalized.push({
      instruction: String(column?.instruction ?? column?.description ?? column?.label ?? targetName),
      label: String(column?.label ?? targetName),
      method: normalizeReviewAnalysisMethod(column?.method ?? column?.analysisMethod, "copy"),
      nullable: column?.nullable !== false,
      sourceField: safeColumnName(column?.sourceField ?? ""),
      targetName,
      type: normalizeSchemaType(column?.type),
      allowedValues: normalizeAllowedValues(column?.allowedValues),
    });
  }
  return normalized.length > 0 ? normalized.slice(0, 80) : defaultTemplate;
}

function normalizeReviewAnalysisMethod(value, fallback = "copy") {
  const raw = String(value ?? "").split(":")[0].trim().toLowerCase();
  const normalized = reviewAnalysisMethodAliases[raw] || raw;
  return supportedReviewAnalysisMethods.includes(normalized) ? normalized : fallback;
}

function rawValueForColumn(row, key) {
  if (!row || typeof row !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  const normalizedKey = normalizedFieldKey(key);
  for (const [rawKey, value] of Object.entries(row)) {
    if (normalizedFieldKey(rawKey) === normalizedKey) return value;
  }
  return undefined;
}

function copyOrExtractFieldValue(row, column, rawRow) {
  const targetName = safeColumnName(column?.targetName ?? column?.name ?? "");
  const sourceField = safeColumnName(column?.sourceField ?? "");
  const rawTargetValue = rawValueForColumn(rawRow, targetName);
  if (rawTargetValue !== undefined && rawTargetValue !== null && rawTargetValue !== "") return rawTargetValue;
  if (Object.prototype.hasOwnProperty.call(row, targetName)) return row[targetName];
  const rawSourceValue = sourceField ? rawValueForColumn(rawRow, sourceField) : undefined;
  if (rawSourceValue !== undefined && rawSourceValue !== null && rawSourceValue !== "") return rawSourceValue;
  return "";
}

function canonicalAllowedValue(value, allowedValues) {
  const normalizedValue = normalizedScalar(value);
  if (!normalizedValue) return undefined;
  return allowedValues.find((allowedValue) => normalizedScalar(allowedValue) === normalizedValue);
}

function normalizeAllowedValues(values) {
  if (Array.isArray(values)) {
    return values.map((value) => String(value ?? "").trim()).filter(Boolean);
  }
  return String(values ?? "")
    .split(/\r?\n|,/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizedFieldKey(value) {
  return String(value ?? "").replace(/[^a-zA-Z0-9]+/g, "").toLowerCase();
}

function normalizedScalar(value) {
  return String(value ?? "").trim().toLowerCase();
}

function safeColumnName(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

async function openReviewSource(source) {
  const config = resolveObjectStorageConfig();
  const client = new S3Client(s3ClientOptions(config));
  const response = await client.send(new GetObjectCommand({
    Bucket: source.bucket,
    Key: source.key,
  }));
  if (!response.Body || typeof response.Body[Symbol.asyncIterator] !== "function") {
    throw Object.assign(new Error("AWS S3 review object did not return a readable body."), {
      code: "REVIEW_ANALYSIS_STREAM_FAILED",
      status: 502,
    });
  }
  return {
    input: response.Body,
    stderr: null,
    stop: () => response.Body.destroy?.(),
    wait: Promise.resolve(0),
  };
}

function parseJsonLine(line, result) {
  try {
    return JSON.parse(line);
  } catch {
    result.invalidRows += 1;
    return null;
  }
}

function recordClassifiedRow(result, row, projectedRow = row) {
  result.processedRows += 1;
  result.metrics.totalHelpfulVotes += row.helpful_vote;
  result.metrics.averageRating += row.rating;
  if (row.action_needed_status === "action_needed") result.metrics.actionNeededRows += 1;
  if (row.sentiment === "negative") result.metrics.negativeRows += 1;
  if (row.sentiment === "positive") result.metrics.positiveRows += 1;
  const hasIssue = Boolean(row.issue_category)
    && !["no_issue", "positive_value", "none"].includes(row.issue_category);
  if (hasIssue) result.metrics.issueRows += 1;
  if (row.severity === "critical" || row.severity === "high") result.metrics.highSeverityRows += 1;

  if (row.issue_category) incrementBreakdown(result, "categoryBreakdown", row.issue_category, row.issue_label);
  if (row.sentiment) incrementBreakdown(result, "sentimentBreakdown", row.sentiment, row.sentiment);
  if (row.severity) incrementBreakdown(result, "severityBreakdown", row.severity, row.severity);

  if (result.rows.length < 40 && (hasIssue || result.rows.length < 8)) {
    result.rows.push(projectedRow);
  }
}

function incrementBreakdown(result, key, id, label) {
  let item = result[key].find((entry) => entry.id === id);
  if (!item) {
    item = { count: 0, id, label, share: 0 };
    result[key].push(item);
  }
  item.count += 1;
}

function finalizeSummary(result, { finishedAt, stderr }) {
  result.finishedAt = finishedAt.toISOString();
  result.status = "success";
  result.metrics.averageRating = result.processedRows > 0
    ? Number((result.metrics.averageRating / result.processedRows).toFixed(2))
    : 0;
  for (const key of ["categoryBreakdown", "sentimentBreakdown", "severityBreakdown"]) {
    result[key] = result[key]
      .map((item) => ({
        ...item,
        share: result.processedRows > 0 ? Number((item.count / result.processedRows).toFixed(4)) : 0,
      }))
      .sort((left, right) => right.count - left.count);
  }
  result.warning = stderr && /error|fail/i.test(stderr) ? truncate(stderr, 500) : "";
}

function reviewId(row, ordinal) {
  const seed = [
    row.asin ?? "",
    row.parent_asin ?? "",
    row.user_id ?? "",
    row.timestamp ?? "",
    row.title ?? "",
    ordinal,
  ].join("|");
  return createHash("sha1").update(seed).digest("hex").slice(0, 16);
}

function stringValue(value) {
  return String(value ?? "").trim();
}

function boundedSourceRow(rawRow, maxChars) {
  if (!rawRow || typeof rawRow !== "object" || Array.isArray(rawRow)) return {};
  const priority = [
    "title",
    "text",
    "reviewText",
    "review_text",
    "rating",
    "overall",
    "asin",
    "parent_asin",
    "verified_purchase",
    "helpful_vote",
    "timestamp",
  ];
  const fields = [...new Set([...priority, ...Object.keys(rawRow).sort()])].slice(0, 64);
  const output = {};
  let remaining = maxChars;
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(rawRow, field) || remaining <= 0) continue;
    let value = rawRow[field];
    if (value && typeof value === "object") value = JSON.stringify(value);
    if (typeof value === "string") value = value.slice(0, Math.min(2_000, remaining));
    const size = String(value ?? "").length + field.length;
    if (size > remaining && Object.keys(output).length > 0) continue;
    output[field] = value;
    remaining -= Math.min(size, remaining);
  }
  return output;
}

function truncate(value, length) {
  const text = String(value ?? "");
  return text.length > length ? `${text.slice(0, length - 1)}...` : text;
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function boundedPositiveInt(value, fallback, min, max) {
  const numeric = Math.trunc(Number(value));
  if (!Number.isFinite(numeric) || numeric < min) return fallback;
  return Math.min(max, numeric);
}

function closeWritable(stream) {
  return new Promise((resolve, reject) => {
    stream.end(resolve);
    stream.on("error", reject);
  });
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  const failed = settled.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  return results;
}
