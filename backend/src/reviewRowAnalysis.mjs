import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.resolve(process.env.ASKLAKE_REVIEW_ANALYSIS_DIR || path.join(backendDir, "tmp", "review-row-analysis"));
const latestSummaryPath = path.join(outputRoot, "cellphones-latest-summary.json");

const sourceBucket = process.env.ASKLAKE_CELLPHONES_REVIEW_BUCKET || "m3-raw";
const sourceKey = process.env.ASKLAKE_CELLPHONES_REVIEW_KEY || "amazon_reviews/cell_phones_and_accessories/reviews/Cell_Phones_and_Accessories.jsonl";
const defaultLimit = boundedPositiveInt(process.env.ASKLAKE_REVIEW_ANALYSIS_DEFAULT_LIMIT, 50000, 1, 500000);
const maxInteractiveLimit = boundedPositiveInt(process.env.ASKLAKE_REVIEW_ANALYSIS_MAX_LIMIT, 200000, 1000, 1000000);
const localLlmEndpoint = process.env.ASKLAKE_LOCAL_LLM_ENDPOINT || "http://127.0.0.1:1234/v1/chat/completions";
const localLlmModel = process.env.ASKLAKE_LOCAL_LLM_MODEL || "local-review-analyzer";
const localLlmTimeoutMs = boundedPositiveInt(process.env.ASKLAKE_LOCAL_LLM_TIMEOUT_MS, 120000, 1000, 600000);
const localLlmMaxInputChars = boundedPositiveInt(process.env.ASKLAKE_LOCAL_LLM_MAX_INPUT_CHARS, 9000, 1000, 50000);

const categoryRules = [
  {
    id: "safety_battery",
    label: "Safety / battery risk",
    subcategory: "overheat_fire_swelling",
    keywords: ["fire", "burn", "burned", "burning", "smoke", "smoking", "explode", "exploded", "explosion", "overheat", "overheated", "hot", "swollen", "swelling", "shock"],
  },
  {
    id: "charging_power",
    label: "Charging / power",
    subcategory: "charge_cable_battery",
    keywords: ["charge", "charging", "charger", "cable", "cord", "battery", "power", "plug", "usb", "lightning", "watt"],
  },
  {
    id: "screen_display",
    label: "Screen / display",
    subcategory: "screen_glass_touch",
    keywords: ["screen", "display", "protector", "glass", "touch", "digitizer", "cracked", "scratch", "bubble"],
  },
  {
    id: "compatibility_fit",
    label: "Compatibility / fit",
    subcategory: "fit_size_model",
    keywords: ["doesn't fit", "does not fit", "didn't fit", "not fit", "fit my", "compatible", "compatibility", "wrong size", "too small", "too big", "model"],
  },
  {
    id: "audio_bluetooth",
    label: "Audio / Bluetooth",
    subcategory: "sound_pairing_connection",
    keywords: ["bluetooth", "speaker", "headset", "earbud", "earbuds", "sound", "audio", "pair", "paired", "pairing", "volume", "mic", "microphone"],
  },
  {
    id: "durability_quality",
    label: "Durability / quality",
    subcategory: "broken_defective_stopped",
    keywords: ["broke", "broken", "defective", "defect", "cheap", "flimsy", "stopped working", "doesn't work", "does not work", "dead", "failed", "poor quality", "junk"],
  },
  {
    id: "delivery_packaging",
    label: "Delivery / packaging",
    subcategory: "arrived_missing_return",
    keywords: ["arrived", "missing", "package", "packaging", "box", "return", "returned", "refund", "replacement", "damaged"],
  },
  {
    id: "listing_accuracy",
    label: "Listing accuracy",
    subcategory: "color_image_description",
    keywords: ["not as described", "description", "picture", "photo", "image", "color", "clear", "white background", "wrong item", "different"],
  },
];

const positiveKeywords = ["works well", "worked great", "great price", "perfect", "love", "excellent", "recommend", "happy", "good quality", "easy to install"];

const supportedReviewAnalysisMethods = [
  "copy_or_extract_field",
  "one_of_values",
  "sentiment_3way",
  "issue_category",
  "issue_subcategory",
  "severity_4level",
  "boolean_y_n",
  "extractive_summary",
  "evidence_span",
];

const reviewAnalysisMethodAliases = {
  custom_instruction: "one_of_values",
  issue_taxonomy: "issue_category",
};

export async function getCellphonesReviewAnalysisStatus() {
  if (!existsSync(latestSummaryPath)) {
    return {
      status: "idle",
      message: "Cell_Phones_and_Accessories.jsonl 실행 결과가 아직 없습니다.",
      source: sourceDescriptor(),
    };
  }

  return JSON.parse(readFileSync(latestSummaryPath, "utf8"));
}

export async function suggestReviewAnalysisSchema(request = {}) {
  const endpoint = process.env.ASKLAKE_LOCAL_LLM_ENDPOINT || "http://127.0.0.1:1234/v1/chat/completions";
  const model = process.env.ASKLAKE_LOCAL_LLM_MODEL || "local-issue-labeler";
  const sourceColumns = Array.isArray(request.sourceColumns) ? request.sourceColumns.slice(0, 40) : [];
  const sampleRows = Array.isArray(request.sampleRows) ? request.sampleRows.slice(0, 3) : [];
  const prompt = [
    "You design a structured output schema for ecommerce product review rows.",
    "Return one minified valid JSON object only. No markdown. No comments. No prose.",
    "The user wants a draft schema only; humans will edit it later.",
    "Recommend columns that can be produced per review row for classification/extraction.",
    "Prefer concise snake_case targetName values.",
    "Each column must have: targetName, label, type, nullable.",
    `Each column must include method. Supported methods: ${supportedReviewAnalysisMethods.join(", ")}.`,
    "Use allowedValues only for method one_of_values.",
    "Allowed types: String, Float, Integer, Boolean, Timestamp.",
    "Use English label values to avoid escaping problems.",
    "Do not put quotes inside string values.",
    "Include columns for copied fields, sentiment, issue/category, issue subcategory, severity/risk, short summary, and evidence/reason.",
    "Do not include UI confidence columns; quality thresholds are backend metadata only.",
    "",
    `Source columns: ${JSON.stringify(sourceColumns)}`,
    `Sample rows: ${JSON.stringify(sampleRows).slice(0, 6000)}`,
    "",
    "JSON shape: {\"columns\":[{\"targetName\":\"sentiment\",\"label\":\"sentiment\",\"type\":\"String\",\"nullable\":false,\"method\":\"sentiment_3way\"}]}",
  ].join("\n");

  const response = await fetch(endpoint, {
    body: JSON.stringify({
      messages: [
        { role: "system", content: "You return strict JSON for data engineering schema suggestions." },
        { role: "user", content: prompt },
      ],
      model,
      temperature: 0.1,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`Local LLM schema suggestion failed: HTTP ${response.status}`), {
      code: "REVIEW_SCHEMA_SUGGESTION_FAILED",
      status: 502,
    });
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content ?? "";
  const parsed = parseLlmJson(content);
  const columns = normalizeSuggestedColumns(parsed?.columns);
  if (columns.length === 0) {
    throw Object.assign(new Error("Local LLM returned no usable schema columns."), {
      code: "REVIEW_SCHEMA_SUGGESTION_EMPTY",
      status: 502,
    });
  }
  return {
    columns,
    model,
    source: "local-llm",
    status: "success",
  };
}

export async function runCellphonesReviewAnalysis(request = {}) {
  const requestedLimit = Number(request.limit);
  const full = request.full === true || requestedLimit === 0;
  const limit = full ? 0 : Math.min(maxInteractiveLimit, boundedPositiveInt(requestedLimit, defaultLimit, 1, maxInteractiveLimit));
  const outputSchema = normalizeOutputSchema(request.schemaColumns ?? request.columns);
  const startedAt = new Date();
  const runId = `cellphones_${startedAt.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
  const runDir = path.join(outputRoot, runId);
  const outputPath = path.join(runDir, "review_issue_rows.jsonl");
  const csvOutputPath = path.join(runDir, "review_issue_rows.csv");
  const summaryPath = path.join(runDir, "summary.json");

  mkdirSync(runDir, { recursive: true });

  const result = initialSummary({
    limit,
    csvOutputPath,
    outputPath,
    outputSchema,
    runId,
    startedAt,
    summaryPath,
  });
  const output = createWriteStream(outputPath, { encoding: "utf8" });
  const csvOutput = createWriteStream(csvOutputPath, { encoding: "utf8" });
  csvOutput.write(`${outputSchema.map((column) => csvEscape(column.targetName)).join(",")}\n`);
  const child = spawnMinioCat(limit);
  const childExit = waitForProcess(child);
  let stderr = "";

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 12000) stderr = stderr.slice(-12000);
  });

  const lineReader = readline.createInterface({
    crlfDelay: Infinity,
    input: child.stdout,
  });

  try {
    for await (const line of lineReader) {
      if (!line.trim()) continue;
      const row = parseJsonLine(line, result);
      if (!row) continue;
      const analyzed = await analyzeReviewRowWithLocalLlm(row, outputSchema, result.processedRows + 1);
      const projected = analyzed.projected;
      recordClassifiedRow(result, analyzed.metricsRow, projected);
      output.write(`${JSON.stringify(projected)}\n`);
      csvOutput.write(`${outputSchema.map((column) => csvEscape(projected[column.targetName])).join(",")}\n`);
    }
  } finally {
    await Promise.all([closeWritable(output), closeWritable(csvOutput)]);
  }

  const exit = await childExit;
  if (exit !== 0 && result.processedRows === 0) {
    throw Object.assign(new Error(`Cell phones review stream failed. ${stderr || `exit=${exit}`}`), {
      code: "REVIEW_ANALYSIS_STREAM_FAILED",
      status: 502,
    });
  }

  finalizeSummary(result, {
    finishedAt: new Date(),
    stderr,
  });
  writeFileSync(summaryPath, JSON.stringify(result, null, 2), "utf8");
  writeFileSync(latestSummaryPath, JSON.stringify(result, null, 2), "utf8");
  return result;
}

function initialSummary({ csvOutputPath, limit, outputPath, outputSchema, runId, startedAt, summaryPath }) {
  return {
    analysis: {
      engine: "review-row-to-csv",
      fallbackUsed: false,
      mode: "local_llm_row_by_row_temporary",
      modelArtifact: localLlmModel,
      rowRuntime: {
        endpoint: redactEndpoint(localLlmEndpoint),
        timeoutMs: localLlmTimeoutMs,
      },
      qualityGate: {
        metrics: [],
        reason: "Row analysis used the configured local LLM per input row. F1/accuracy still requires a separate labeled evaluation set and is not shown as UI confidence.",
        status: "not_evaluated",
        thresholds: {
          issue_category_f1: 0.75,
          sentiment_f1: 0.75,
          severity_f1: 0.75,
        },
      },
      supportedMethods: supportedReviewAnalysisMethods,
    },
    categoryBreakdown: [],
    invalidRows: 0,
    limit,
    metrics: {
      averageRating: 0,
      highSeverityRows: 0,
      issueRows: 0,
      negativeRows: 0,
      positiveRows: 0,
      totalHelpfulVotes: 0,
    },
    method: {
      name: "electronics-review-row-structuring",
      note: "Streams the real MinIO JSONL source and writes the user-defined final CSV schema. Temporary runtime calls the configured local LLM once per source row.",
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
    source: sourceDescriptor(),
    startedAt: startedAt.toISOString(),
    status: "running",
    stoppedAtLimit: limit > 0,
  };
}

function sourceDescriptor() {
  return {
    bucket: sourceBucket,
    key: sourceKey,
    object: `s3://${sourceBucket}/${sourceKey}`,
    runtime: "docker exec m3-minio mc cat",
  };
}

async function analyzeReviewRowWithLocalLlm(rawRow, outputSchema, ordinal) {
  const requestBody = {
    model: localLlmModel,
    temperature: 0,
    messages: [
      {
        role: "system",
        content: [
          "You analyze ecommerce product review rows and return strict JSON only.",
          "Do not return markdown, comments, prose, or nested objects.",
          "Use only the requested output keys.",
          "For enum-like methods, choose one allowed value exactly.",
          "For issue fields, use concise snake_case labels.",
          "For summary and evidence, quote or summarize only facts present in the row.",
        ].join(" "),
      },
      {
        role: "user",
        content: buildReviewRowLlmPrompt(rawRow, outputSchema, ordinal),
      },
    ],
  };

  const response = await fetch(localLlmEndpoint, {
    body: JSON.stringify(requestBody),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(localLlmTimeoutMs),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`Local LLM review row analysis failed: HTTP ${response.status}`), {
      code: "REVIEW_ROW_LOCAL_LLM_FAILED",
      status: 502,
    });
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content ?? "";
  const parsed = parseLlmJson(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("Local LLM review row analysis did not return a JSON object."), {
      code: "REVIEW_ROW_LOCAL_LLM_BAD_JSON",
      status: 502,
    });
  }
  const projected = coerceLlmProjectedRow(parsed, outputSchema, rawRow, ordinal);
  return {
    metricsRow: metricsRowFromProjected(projected, outputSchema, rawRow, ordinal),
    projected,
  };
}

function buildReviewRowLlmPrompt(rawRow, outputSchema, ordinal) {
  const columns = outputSchema.map((column) => ({
    allowedValues: allowedValuesForMethod(column),
    method: normalizeReviewAnalysisMethod(column?.method ?? column?.analysisMethod, "copy_or_extract_field"),
    targetName: column.targetName,
    type: normalizeSchemaType(column.type),
  }));
  const rowText = JSON.stringify(rawRow ?? {});
  return [
    "Analyze this one source review row into one final CSV output row.",
    "Return one minified JSON object whose keys exactly match the requested columns.",
    "If the source row contains a copied identifier or numeric field, preserve it exactly where possible.",
    "Use null only when the requested value cannot be inferred from the row.",
    "",
    `rowOrdinal: ${ordinal}`,
    `requestedColumns: ${JSON.stringify(columns)}`,
    `sourceRow: ${truncate(rowText, localLlmMaxInputChars)}`,
  ].join("\n");
}

function allowedValuesForMethod(column) {
  const method = normalizeReviewAnalysisMethod(column?.method ?? column?.analysisMethod, "copy_or_extract_field");
  const explicit = normalizeAllowedValues(column?.allowedValues);
  if (explicit.length > 0) return explicit;
  if (method === "sentiment_3way") return ["positive", "mixed", "negative"];
  if (method === "severity_4level") return ["critical", "high", "medium", "low"];
  if (method === "boolean_y_n") return ["Y", "N"];
  return [];
}

function coerceLlmProjectedRow(llmRow, outputSchema, rawRow, ordinal) {
  const projected = {};
  for (const column of outputSchema) {
    const targetName = column.targetName;
    const method = normalizeReviewAnalysisMethod(column?.method ?? column?.analysisMethod, "copy_or_extract_field");
    const allowedValues = allowedValuesForMethod(column);
    let value = llmRow?.[targetName];
    if ((value === undefined || value === null || value === "") && method === "copy_or_extract_field") {
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
  const byMethod = (method) => {
    const column = outputSchema.find((item) => normalizeReviewAnalysisMethod(item?.method ?? item?.analysisMethod, "") === method);
    return column ? projected[column.targetName] : undefined;
  };
  const rating = Number(projected.rating ?? rawRow.rating ?? rawRow.overall ?? 0) || 0;
  return {
    asin: stringValue(projected.asin ?? rawRow.asin),
    evidence: stringValue(byMethod("evidence_span") ?? projected.evidence),
    helpful_vote: Number(projected.helpful_vote ?? rawRow.helpful_vote ?? rawRow.helpfulVote ?? 0) || 0,
    issue_category: stringValue(byMethod("issue_category") ?? projected.issue_category ?? "unclassified"),
    issue_label: stringValue(byMethod("issue_category") ?? projected.issue_category ?? "unclassified"),
    issue_subcategory: stringValue(byMethod("issue_subcategory") ?? projected.issue_subcategory ?? "unclassified"),
    parent_asin: stringValue(projected.parent_asin ?? rawRow.parent_asin),
    rating,
    review_id: stringValue(projected.review_id ?? reviewId(rawRow, ordinal)),
    sentiment: stringValue(byMethod("sentiment_3way") ?? projected.sentiment ?? "mixed"),
    severity: stringValue(byMethod("severity_4level") ?? projected.severity ?? "low"),
    summary: stringValue(byMethod("extractive_summary") ?? projected.summary),
    timestamp: Number(projected.timestamp ?? rawRow.timestamp ?? 0) || null,
    title: stringValue(projected.title ?? rawRow.title),
    user_id: stringValue(projected.user_id ?? rawRow.user_id),
    verified_purchase: Boolean(projected.verified_purchase ?? rawRow.verified_purchase),
  };
}

function parseLlmJson(content) {
  if (typeof content !== "string") return null;
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeSuggestedColumns(columns) {
  if (!Array.isArray(columns)) return [];
  return columns
    .map((column) => ({
      instruction: String(column?.instruction ?? column?.description ?? column?.label ?? column?.targetName ?? "").trim(),
      label: String(column?.label ?? column?.targetName ?? "").trim(),
      method: normalizeReviewAnalysisMethod(column?.method ?? column?.analysisMethod, "copy_or_extract_field"),
      nullable: column?.nullable !== false,
      targetName: safeColumnName(column?.targetName ?? column?.name ?? ""),
      type: normalizeSchemaType(column?.type),
      allowedValues: normalizeAllowedValues(column?.allowedValues),
    }))
    .filter((column) => column.targetName)
    .slice(0, 20);
}

function normalizeSchemaType(value) {
  const normalized = String(value ?? "String").toLowerCase();
  if (normalized.includes("float") || normalized.includes("double") || normalized.includes("decimal")) return "Float";
  if (normalized.includes("int") || normalized.includes("long")) return "Integer";
  if (normalized.includes("bool")) return "Boolean";
  if (normalized.includes("time") || normalized.includes("date")) return "Timestamp";
  return "String";
}

function normalizeOutputSchema(columns) {
  const fallback = [
    { instruction: "원본 row에서 리뷰 고유 ID를 생성", method: "copy_or_extract_field", targetName: "review_id", type: "String" },
    { instruction: "상품 ASIN", method: "copy_or_extract_field", targetName: "asin", type: "String" },
    { instruction: "상위 상품 ASIN", method: "copy_or_extract_field", targetName: "parent_asin", type: "String" },
    { instruction: "원본 평점", method: "copy_or_extract_field", targetName: "rating", type: "Float" },
    { instruction: "positive, mixed, negative 중 하나", method: "sentiment_3way", targetName: "sentiment", type: "String" },
    { instruction: "리뷰의 핵심 이슈 대분류", method: "issue_category", targetName: "issue_category", type: "String" },
    { instruction: "이슈 세부 분류", method: "issue_subcategory", targetName: "issue_subcategory", type: "String" },
    { instruction: "critical, high, medium, low 중 하나", method: "severity_4level", targetName: "severity", type: "String" },
    { instruction: "리뷰 내용을 짧게 요약", method: "extractive_summary", targetName: "summary", type: "String" },
    { instruction: "판단 근거 문장", method: "evidence_span", targetName: "evidence", type: "String" },
  ];
  const source = Array.isArray(columns) && columns.length > 0 ? columns : fallback;
  const seen = new Set();
  const normalized = [];
  for (const column of source) {
    const targetName = safeColumnName(column?.targetName ?? column?.name ?? column);
    if (!targetName || seen.has(targetName)) continue;
    seen.add(targetName);
    normalized.push({
      instruction: String(column?.instruction ?? column?.description ?? column?.label ?? targetName),
      label: String(column?.label ?? targetName),
      method: normalizeReviewAnalysisMethod(column?.method ?? column?.analysisMethod, "copy_or_extract_field"),
      nullable: column?.nullable !== false,
      targetName,
      type: normalizeSchemaType(column?.type),
      allowedValues: normalizeAllowedValues(column?.allowedValues),
    });
  }
  return normalized.length > 0 ? normalized.slice(0, 80) : fallback;
}

function projectClassifiedRow(row, outputSchema, rawRow = {}) {
  return Object.fromEntries(outputSchema.map((column) => [
    column.targetName,
    valueForRequestedColumn(row, column, rawRow),
  ]));
}

function valueForRequestedColumn(row, column, rawRow = {}) {
  const method = normalizeReviewAnalysisMethod(column?.method ?? column?.analysisMethod, "copy_or_extract_field");
  switch (method) {
    case "copy_or_extract_field":
      return copyOrExtractFieldValue(row, column, rawRow);
    case "one_of_values":
      return oneOfValuesForColumn(row, column, rawRow);
    case "sentiment_3way":
      return row.sentiment;
    case "issue_category":
      return row.issue_category;
    case "issue_subcategory":
      return row.issue_subcategory;
    case "severity_4level":
      return row.severity;
    case "boolean_y_n":
      return booleanValueFromRow(rawRow);
    case "extractive_summary":
      return row.summary;
    case "evidence_span":
      return row.evidence;
    default:
      return "";
  }
}

function normalizeReviewAnalysisMethod(value, fallback = "copy_or_extract_field") {
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

function oneOfValuesForColumn(row, column, rawRow) {
  const allowedValues = normalizeAllowedValues(column?.allowedValues);
  if (allowedValues.length === 0) return "";

  const targetName = safeColumnName(column?.targetName ?? column?.name ?? "");
  const candidates = [
    rawValueForColumn(rawRow, targetName),
    Object.prototype.hasOwnProperty.call(row, targetName) ? row[targetName] : undefined,
    row.sentiment,
    row.issue_category,
    row.issue_subcategory,
    row.severity,
    booleanValueFromRow(rawRow),
  ];
  for (const candidate of candidates) {
    const matched = canonicalAllowedValue(candidate, allowedValues);
    if (matched !== undefined) return matched;
  }

  const sourceText = reviewTextForRow(rawRow).toLowerCase();
  const textMatch = allowedValues.find((value) => sourceText.includes(String(value).toLowerCase()));
  return textMatch ?? allowedValues[0];
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

function reviewTextForRow(row) {
  return cleanText([
    row?.title,
    row?.text,
    row?.reviewText,
    row?.review_text,
    row?.body,
    row?.summary,
  ].filter(Boolean).join(" "));
}

function booleanValueFromRow(row) {
  const text = reviewTextForRow(row).toLowerCase();
  const matched = /(click|clicked|tap|tapped|pressed|selected|subscribe|subscribed|buy|bought|purchase|purchased|클릭|선택|구매)/i.test(text);
  return matched ? "Y" : "N";
}

function safeColumnName(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function spawnMinioCat(limit) {
  const container = process.env.ASKLAKE_MINIO_CONTAINER || "m3-minio";
  const endpoint = process.env.ASKLAKE_MINIO_CONTAINER_ENDPOINT || "http://127.0.0.1:9000";
  const accessKey = process.env.MINIO_ACCESS_KEY || process.env.MINIO_ROOT_USER || "m3admin";
  const secretKey = process.env.MINIO_SECRET_KEY || process.env.MINIO_ROOT_PASSWORD || "wishuponastar";
  const target = `local/${sourceBucket}/${sourceKey}`;
  const readCommand = limit > 0
    ? `mc cat ${shellQuote(target)} | head -n ${limit}`
    : `mc cat ${shellQuote(target)}`;
  const script = [
    `mc alias set local ${shellQuote(endpoint)} ${shellQuote(accessKey)} ${shellQuote(secretKey)} >/dev/null`,
    readCommand,
  ].join(" && ");
  return spawn("docker", ["exec", "-i", container, "sh", "-lc", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseJsonLine(line, result) {
  try {
    return JSON.parse(line);
  } catch {
    result.invalidRows += 1;
    return null;
  }
}

function classifyReview(row, ordinal) {
  const rating = Number(row.rating ?? row.overall ?? 0) || 0;
  const title = cleanText(row.title);
  const text = cleanText(row.text ?? row.reviewText ?? "");
  const haystack = `${title} ${text}`.toLowerCase();
  const category = findCategory(haystack, rating);
  const sentiment = inferSentiment(rating, haystack, category);
  const severity = inferSeverity(rating, category, haystack);
  const evidence = evidenceFor(text || title, category.keyword);

  return {
    asin: stringValue(row.asin),
    evidence,
    helpful_vote: Number(row.helpful_vote ?? row.helpfulVote ?? 0) || 0,
    issue_category: category.id,
    issue_label: category.label,
    issue_subcategory: category.subcategory,
    parent_asin: stringValue(row.parent_asin),
    rating,
    review_id: reviewId(row, ordinal),
    sentiment,
    severity,
    summary: summaryFor({ category, evidence, rating, sentiment, title }),
    timestamp: Number(row.timestamp ?? 0) || null,
    title,
    user_id: stringValue(row.user_id),
    verified_purchase: Boolean(row.verified_purchase),
  };
}

function findCategory(haystack, rating) {
  const negativeSignal = hasNegativeSignal(haystack);
  for (const rule of categoryRules) {
    const keyword = rule.keywords.find((item) => haystack.includes(item));
    if (!keyword) continue;
    if (rating >= 4 && !negativeSignal && !["listing_accuracy", "safety_battery"].includes(rule.id)) {
      return positiveCategory();
    }
    return { ...rule, keyword };
  }

  if (rating >= 4 || positiveKeywords.some((keyword) => haystack.includes(keyword))) {
    return positiveCategory();
  }

  return {
    id: "general_negative",
    keyword: "",
    label: "General negative",
    subcategory: "unspecified_complaint",
  };
}

function inferSentiment(rating, haystack, category) {
  const negativeSignal = hasNegativeSignal(haystack);
  if (rating <= 2) return "negative";
  if (rating === 3 || negativeSignal) return category.id === "positive_value" ? "mixed" : "negative";
  if (category.id !== "positive_value" && negativeSignal) return "mixed";
  return "positive";
}

function inferSeverity(rating, category, haystack) {
  if (category.id === "safety_battery") return "critical";
  if (/(fire|explode|smoke|shock|burn|swollen|overheat)/i.test(haystack)) return "critical";
  if (rating >= 4 && !hasNegativeSignal(haystack)) return "low";
  if (rating <= 1 && ["charging_power", "durability_quality", "screen_display"].includes(category.id)) return "high";
  if (rating <= 2 || ["charging_power", "durability_quality", "screen_display", "compatibility_fit"].includes(category.id)) return "medium";
  return "low";
}

function hasNegativeSignal(haystack) {
  return /(not|never|no|bad|poor|disappointed|waste|return|refund|broken|broke|defective|wrong|failed|cracked|pissed|doesn.?t work|does not work|stopped working)/i.test(haystack);
}

function positiveCategory() {
  return {
    id: "positive_value",
    keyword: "",
    label: "Positive / value",
    subcategory: "works_value_recommend",
  };
}

function summaryFor({ category, evidence, rating, sentiment, title }) {
  const lead = sentiment === "positive"
    ? "긍정 리뷰"
    : `${category.label} 이슈`;
  const source = evidence || title || "근거 문장 없음";
  return `${lead}: rating ${rating || "n/a"} · ${source}`.slice(0, 260);
}

function evidenceFor(text, keyword) {
  const source = cleanText(text);
  if (!source) return "";
  const sentences = source.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (keyword) {
    const matched = sentences.find((sentence) => sentence.toLowerCase().includes(keyword));
    if (matched) return truncate(matched, 190);
  }
  return truncate(sentences[0] || source, 190);
}

function recordClassifiedRow(result, row, projectedRow = row) {
  result.processedRows += 1;
  result.metrics.totalHelpfulVotes += row.helpful_vote;
  result.metrics.averageRating += row.rating;
  if (row.sentiment === "negative") result.metrics.negativeRows += 1;
  if (row.sentiment === "positive") result.metrics.positiveRows += 1;
  if (row.issue_category !== "positive_value") result.metrics.issueRows += 1;
  if (row.severity === "critical" || row.severity === "high") result.metrics.highSeverityRows += 1;

  incrementBreakdown(result, "categoryBreakdown", row.issue_category, row.issue_label);
  incrementBreakdown(result, "sentimentBreakdown", row.sentiment, row.sentiment);
  incrementBreakdown(result, "severityBreakdown", row.severity, row.severity);

  if (result.rows.length < 40 && (row.issue_category !== "positive_value" || result.rows.length < 8)) {
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

function cleanText(value) {
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function waitForProcess(child) {
  return new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(1));
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
