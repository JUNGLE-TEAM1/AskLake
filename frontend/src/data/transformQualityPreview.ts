export type TransformQualitySeverity = "Warning" | "Error";
export type TransformQualityFailureAction = "Warn" | "Quarantine" | "Fail Run" | "Drop Row" | "Set Null";

export type TransformQualityPreviewSample = {
  affectedColumn: string;
  failedRows: number;
  inputValue: string;
  matchedRows: number;
  outputValue: string;
  status: "Success" | "Review";
};

export type RecommendedTransformStep = {
  enabled: boolean;
  id: string;
  input: string;
  onError: TransformQualityFailureAction;
  operation: string;
  output: string;
  params: string;
};

export type QualityRuleOption = {
  failureAction: TransformQualityFailureAction;
  id: string;
  severity: TransformQualitySeverity;
  targetColumn: string;
  validationType: "Not Null" | "Range Check" | "Regex Match" | "Accepted Values";
};

export type TransformQualityInvalidRow = {
  action: TransformQualityFailureAction;
  column: string;
  reason: string;
  row: string;
  ruleId?: string;
  sampleValue: string;
};

export type TransformQualitySampleRow = Record<string, string>;

export type TransformQualityRecipeStepInput = {
  id: string;
  input: string;
  onError: string;
  operation: string;
  output: string;
  params: string;
};

export type TransformQualityRuleInput = {
  failureAction: TransformQualityFailureAction;
  id: string;
  severity: TransformQualitySeverity;
  targetColumn: string;
  validationType: QualityRuleOption["validationType"];
};

export type TransformQualityValidationResult = {
  failedRows: TransformQualityInvalidRow[];
  invalidRowCount: number;
  passRate: number;
  qualityScore: number;
  sampleRows: number;
  status: "pass" | "warn" | "fail";
  summary: string;
};

export type TransformQualityStepPreview = TransformQualityPreviewSample & {
  afterRows: string[][];
  beforeRows: string[][];
  columns: string[];
};

export type TransformQualityRunnerResult = {
  sampleRows: TransformQualitySampleRow[];
  transformedRows: TransformQualitySampleRow[];
  validation: TransformQualityValidationResult;
  previewByStepId: Record<string, TransformQualityStepPreview>;
};

type CustomCsvClassifierRule = {
  condition: string;
  pattern: string;
  value: string;
};

type CustomCsvClassifierConfig = {
  fallbackValue: string;
  rules: CustomCsvClassifierRule[];
  sourceField: string;
};

type ReviewAnalysisMethod =
  | "copy_or_extract_field"
  | "one_of_values"
  | "sentiment_3way"
  | "issue_category"
  | "issue_subcategory"
  | "severity_4level"
  | "boolean_y_n"
  | "extractive_summary"
  | "evidence_span";

type ReviewAnalysisColumnConfig = {
  allowedValues: string[];
  instruction: string;
  method: ReviewAnalysisMethod;
  sourceField: string;
  targetName: string;
};

const REVIEW_ANALYSIS_METHODS = new Set<ReviewAnalysisMethod>([
  "copy_or_extract_field",
  "one_of_values",
  "sentiment_3way",
  "issue_category",
  "issue_subcategory",
  "severity_4level",
  "boolean_y_n",
  "extractive_summary",
  "evidence_span",
]);

export function runTransformQualitySamplePreview(
  recipeSteps: TransformQualityRecipeStepInput[],
  qualityRules: TransformQualityRuleInput[],
  sampleRows: TransformQualitySampleRow[] = [],
): TransformQualityRunnerResult {
  const previewByStepId: Record<string, TransformQualityStepPreview> = {};
  let transformedRows = sampleRows.map((row) => ({ ...row }));

  recipeSteps.forEach((step) => {
    const beforeRows = transformedRows.map((row) => ({ ...row }));
    let failedRows = 0;
    const failedIndexes: number[] = [];

    transformedRows = transformedRows.map((row, rowIndex) => {
      const { failed, value } = applyTransformStep(row, step);
      if (failed) {
        failedRows += 1;
        failedIndexes.push(rowIndex);
      }
      return { ...row, [step.output]: value };
    });

    const firstBefore = beforeRows[0] ?? {};
    const firstAfter = transformedRows[0] ?? {};
    const previewColumns = Array.from(new Set(["row_id", step.input, step.output])).filter(Boolean);
    const previewRows = selectStepPreviewRows(beforeRows, transformedRows, previewColumns, step, failedIndexes);

    previewByStepId[step.id] = {
      affectedColumn: step.output,
      afterRows: previewRows.afterRows,
      beforeRows: previewRows.beforeRows,
      columns: previewColumns,
      failedRows,
      inputValue: firstBefore[step.input] ?? "",
      matchedRows: Math.max(0, sampleRows.length - failedRows),
      outputValue: firstAfter[step.output] ?? "",
      status: failedRows > 0 ? "Review" : "Success",
    };
  });

  const validation = runQualityRules(transformedRows, qualityRules);

  return {
    previewByStepId,
    sampleRows,
    transformedRows,
    validation,
  };
}

function applyTransformStep(row: TransformQualitySampleRow, step: TransformQualityRecipeStepInput) {
  const inputValue = row[step.input] ?? "";
  const operation = step.operation.toLowerCase();

  try {
    if (operation.includes("default")) {
      return { failed: false, value: inputValue.trim() ? inputValue : step.params };
    }
    if (operation.includes("null guard") || operation.includes("not null")) {
      return inputValue.trim() ? { failed: false, value: inputValue } : { failed: true, value: "" };
    }
    if (operation.includes("sql expression")) {
      return { failed: false, value: inputValue };
    }
    if (operation.includes("custom csv classifier") || operation.includes("csv classifier")) {
      return { failed: false, value: classifyCustomCsvValue(row, step, inputValue) };
    }
    if (operation.includes("review row analysis") || operation.includes("review_analyze")) {
      return { failed: false, value: reviewRowAnalysisPreviewValue(row, step) };
    }
    if (operation.includes("json")) {
      return { failed: false, value: readJsonPath(inputValue, step.params) };
    }
    if (operation.includes("lower") || operation.includes("trim")) {
      return { failed: false, value: inputValue.trim().toLowerCase() };
    }
    if (operation.includes("decimal") || operation.includes("cast")) {
      const value = Number(inputValue);
      return Number.isFinite(value) ? { failed: false, value: value.toFixed(2) } : { failed: true, value: "" };
    }
    if (operation.includes("timestamp") || operation.includes("date")) {
      const value = new Date(inputValue);
      return Number.isNaN(value.getTime()) ? { failed: true, value: "" } : { failed: false, value: value.toISOString().replace("T", " ").replace(".000Z", " UTC") };
    }
    if (operation.includes("mask")) {
      return { failed: false, value: maskPhoneNumber(inputValue) };
    }
    return { failed: false, value: inputValue };
  } catch {
    return { failed: true, value: "" };
  }
}

function reviewRowAnalysisPreviewValue(row: TransformQualitySampleRow, step: TransformQualityRecipeStepInput) {
  const config = parseReviewAnalysisConfig(step);
  const text = getReviewText(row, config.sourceField);
  const rating = getReviewRating(row);

  if (looksLikeConfidenceOrScore(config.targetName) && config.method !== "copy_or_extract_field") {
    return runtimeAnalysisPlaceholder(config.method);
  }
  if (!hasReviewAnalysisSignal(text, rating) && config.method !== "copy_or_extract_field" && config.method !== "one_of_values") {
    return runtimeAnalysisPlaceholder(config.method);
  }

  const category = reviewIssueCategoryForText(text, rating);

  switch (config.method) {
    case "copy_or_extract_field":
      return copyOrExtractReviewField(row, config, step);
    case "sentiment_3way":
      return reviewSentimentForText(text, rating, category.id);
    case "issue_category":
      return category.id;
    case "issue_subcategory":
      return category.label;
    case "severity_4level":
      return reviewSeverityForText(text, rating, category.id);
    case "boolean_y_n":
      return reviewBooleanForText(text, config);
    case "extractive_summary":
      return reviewExtractiveSummary(text);
    case "evidence_span":
      return reviewEvidenceSpan(text);
    case "one_of_values":
      return config.allowedValues[0] ?? runtimeAnalysisPlaceholder(config.method);
    default:
      return runtimeAnalysisPlaceholder(config.method);
  }
}

function parseReviewAnalysisConfig(step: TransformQualityRecipeStepInput): ReviewAnalysisColumnConfig {
  const targetName = normalizePreviewName(step.output);
  const fallbackMethod = inferReviewAnalysisMethod(targetName);
  const legacyFields = parseReviewAnalyzeFields(step.params);
  const fallbackSourceField = findPreferredSourceField(legacyFields) || parseReviewSourceField(step.params) || step.input;

  try {
    const parsed = JSON.parse(step.params || "{}") as Record<string, unknown>;
    const columns = Array.isArray(parsed.columns) ? parsed.columns : [parsed];
    const column = selectReviewAnalysisColumn(columns, targetName);
    const rawColumn = isRecord(column) ? column : {};
    const method = normalizeReviewAnalysisMethod(
      String(rawColumn.method || rawColumn.analysisMethod || parsed.method || ""),
      targetName,
      fallbackMethod,
    );
    return {
      allowedValues: parseReviewAllowedValues(rawColumn.allowedValues ?? parsed.allowedValues, method),
      instruction: String(rawColumn.instruction || rawColumn.pattern || parsed.instruction || ""),
      method,
      sourceField: String(parsed.sourceField || rawColumn.sourceField || fallbackSourceField),
      targetName: normalizePreviewName(String(rawColumn.targetName || rawColumn.value || parsed.outputColumn || parsed.targetName || targetName)),
    };
  } catch {
    return {
      allowedValues: parseReviewAllowedValues("", fallbackMethod),
      instruction: step.params,
      method: fallbackMethod,
      sourceField: fallbackSourceField,
      targetName,
    };
  }
}

function selectReviewAnalysisColumn(columns: unknown[], targetName: string) {
  return columns.find((column) => {
    if (!isRecord(column)) return false;
    const candidate = normalizePreviewName(String(column.targetName || column.value || ""));
    return candidate === targetName;
  }) ?? columns[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeReviewAnalysisMethod(rawMethod: string, targetName: string, fallback: ReviewAnalysisMethod): ReviewAnalysisMethod {
  const method = normalizePreviewName(rawMethod.split(":")[0] ?? "");
  if (method === "custom_instruction") return "one_of_values";
  if (method === "issue_taxonomy") return targetName === "issue_subcategory" ? "issue_subcategory" : "issue_category";
  return REVIEW_ANALYSIS_METHODS.has(method as ReviewAnalysisMethod) ? method as ReviewAnalysisMethod : fallback;
}

function inferReviewAnalysisMethod(targetName: string): ReviewAnalysisMethod {
  const target = normalizePreviewName(targetName);
  if (["review_id", "asin", "parent_asin", "rating", "title", "text", "review_text", "timestamp", "event_time", "user_id", "verified_purchase", "helpful_vote"].includes(target)) {
    return "copy_or_extract_field";
  }
  if (target === "sentiment") {
    return "sentiment_3way";
  }
  if (target === "issue_subcategory") {
    return "issue_subcategory";
  }
  if (target === "issue_category") {
    return "issue_category";
  }
  if (target === "severity") {
    return "severity_4level";
  }
  if (target === "summary") {
    return "extractive_summary";
  }
  if (target === "evidence") {
    return "evidence_span";
  }
  if (target.endsWith("_yn") || target.startsWith("is_") || target.startsWith("has_")) {
    return "boolean_y_n";
  }
  return "one_of_values";
}

function parseReviewAllowedValues(value: unknown, method: ReviewAnalysisMethod) {
  const parsedValues = Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : String(value || "")
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  if (parsedValues.length > 0) return parsedValues;
  if (method === "sentiment_3way") return ["positive", "mixed", "negative"];
  if (method === "severity_4level") return ["critical", "high", "medium", "low"];
  if (method === "boolean_y_n") return ["Y", "N"];
  return [];
}

function parseReviewAnalyzeFields(params: string) {
  const match = String(params || "").match(/review_analy[sz]e\(([^)]*)\)/i);
  if (!match) return [];
  return match[1].split(",").map((field) => normalizePreviewName(field)).filter(Boolean);
}

function findPreferredSourceField(fields: string[]) {
  return fields.find((field) => ["text", "review_text", "body"].includes(field)) || fields[0] || "";
}

function copyOrExtractReviewField(row: TransformQualitySampleRow, config: ReviewAnalysisColumnConfig, step: TransformQualityRecipeStepInput) {
  const target = normalizePreviewName(config.targetName);
  const rating = Number(row.rating ?? row.stars ?? row.score ?? 0) || 0;
  const asin = String(row.asin ?? row.product_id ?? "");
  const userId = String(row.user_id ?? row.reviewer_id ?? row.customer_id ?? "");
  const timestamp = String(row.timestamp ?? row.event_time ?? "");
  if (target === "review_id") return [asin, userId, timestamp].filter(Boolean).join("_") || "review_sample";
  if (target === "asin") return asin;
  if (target === "parent_asin") return String(row.parent_asin ?? "");
  if (target === "rating") return String(rating || "");
  if (target === "title") return String(row.title ?? row.review_title ?? "");
  if (target === "text" || target === "review_text") return String(row.text ?? row.review_text ?? row.body ?? row[config.sourceField] ?? "");
  if (target === "timestamp" || target === "event_time") return timestamp;
  if (target === "user_id") return userId;
  if (target === "verified_purchase") return String(row.verified_purchase ?? row.verified ?? "");
  if (target === "helpful_vote") return String(row.helpful_vote ?? row.helpful_votes ?? "");
  return String(row[target] ?? row[config.sourceField] ?? row[step.input] ?? "");
}

function getReviewText(row: TransformQualitySampleRow, sourceField: string) {
  return String(row.text ?? row.review_text ?? row.body ?? row[sourceField] ?? "");
}

function getReviewRating(row: TransformQualitySampleRow) {
  const rating = Number(row.rating ?? row.stars ?? row.score ?? 0);
  return Number.isFinite(rating) ? rating : 0;
}

function hasReviewAnalysisSignal(text: string, rating: number) {
  return text.trim().length > 0 || rating > 0;
}

function reviewSentimentForText(text: string, rating: number, category: string) {
  if (rating > 0 && rating <= 2) return "negative";
  if (/(refund|broken|defect|wrong|missing|overheat|danger|fail|bad|poor|terrible|not work)/i.test(text)) return "negative";
  if (rating === 3 || category !== "positive_feedback") return "mixed";
  return "positive";
}

function reviewIssueCategoryForText(text: string, rating: number) {
  const rules = [
    { id: "battery_or_power", label: "battery_power", pattern: /(battery|charge|charging|charger|power|cable|usb|plug|overheat|hot)/i },
    { id: "screen_or_display", label: "screen_display", pattern: /(screen|display|glass|crack|touch|protector)/i },
    { id: "shipping_or_package", label: "shipping_package", pattern: /(shipping|delivery|package|packaging|arrived|box)/i },
    { id: "listing_mismatch", label: "listing_accuracy", pattern: /(not as described|wrong|fake|different|missing|picture|listing)/i },
    { id: "durability_quality", label: "durability_quality", pattern: /(broke|broken|defect|quality|cheap|scratch|stopped|fail)/i },
  ];
  const matched = rules.find((rule) => rule.pattern.test(text));
  if (matched) return matched;
  if (rating > 0 && rating <= 2) return { id: "general_issue", label: "general_negative" };
  return { id: "positive_feedback", label: "positive_value" };
}

function reviewSeverityForText(text: string, rating: number, category: string) {
  if (/(explode|fire|burn|smoke|danger|injury)/i.test(text)) return "critical";
  if (category === "battery_or_power" && /(overheat|hot|danger|smoke)/i.test(text)) return "high";
  if (rating === 1) return "high";
  if (rating === 2 || /(broken|defect|stopped|fail|wrong|missing)/i.test(text)) return "medium";
  return "low";
}

function reviewBooleanForText(text: string, config: ReviewAnalysisColumnConfig) {
  const target = normalizePreviewName(config.targetName);
  if (target.includes("negative") || target.includes("issue") || target.includes("complaint")) {
    return /(refund|broken|defect|wrong|missing|overheat|danger|fail|bad|poor|terrible|not work)/i.test(text) ? "Y" : "N";
  }
  return text.trim() ? "Y" : "N";
}

function reviewExtractiveSummary(text: string) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return runtimeAnalysisPlaceholder("extractive_summary");
  const sentence = cleaned.split(/(?<=[.!?])\s+/)[0] || cleaned;
  return sentence.length > 96 ? `${sentence.slice(0, 93)}...` : sentence;
}

function reviewEvidenceSpan(text: string) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return runtimeAnalysisPlaceholder("evidence_span");
  const sentence = cleaned.split(/(?<=[.!?])\s+/)[0] || cleaned;
  return sentence.length > 120 ? `${sentence.slice(0, 117)}...` : sentence;
}

function looksLikeConfidenceOrScore(targetName: string) {
  return /(^|_)(confidence|quality|score|probability|prob|performance|accuracy)(_|$)/i.test(targetName);
}

function runtimeAnalysisPlaceholder(method: ReviewAnalysisMethod) {
  return `${method}: runtime output`;
}

function parseReviewSourceField(params: string) {
  try {
    const parsed = JSON.parse(params || "{}");
    return String(parsed.sourceField || "text");
  } catch {
    return "text";
  }
}

function normalizePreviewName(value: string) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
}

function classifyCustomCsvValue(row: TransformQualitySampleRow, step: TransformQualityRecipeStepInput, inputValue: string) {
  const config = parseCustomCsvClassifierConfig(step.params, step.input);
  const sourceValue = String(row[config.sourceField] ?? row[step.input] ?? inputValue ?? "");
  const fallback = config.rules.find((rule) => rule.condition === "else")?.value
    || config.fallbackValue
    || config.rules.at(-1)?.value
    || sourceValue;
  const matched = config.rules.find((rule) => rule.condition !== "else" && matchesCustomCsvRule(sourceValue, rule));
  return matched?.value ?? fallback;
}

function parseCustomCsvClassifierConfig(params: string, input: string) {
  try {
    const parsed = JSON.parse(params || "{}");
    const rules: CustomCsvClassifierRule[] = Array.isArray(parsed.rules)
      ? parsed.rules
        .map((rule: Record<string, unknown>) => ({
          condition: String(rule.condition || "keyword_any"),
          pattern: String(rule.pattern || ""),
          value: String(rule.value || "").trim(),
        }))
        .filter((rule: { value: string }) => rule.value)
      : [];
    return {
      fallbackValue: String(parsed.fallbackValue || ""),
      rules,
      sourceField: String(parsed.sourceField || input),
    } satisfies CustomCsvClassifierConfig;
  } catch {
    return { fallbackValue: "", rules: [], sourceField: input } satisfies CustomCsvClassifierConfig;
  }
}

function matchesCustomCsvRule(value: string, rule: CustomCsvClassifierRule) {
  const normalized = value.toLowerCase();
  if (rule.condition === "empty") return value.trim().length === 0;
  if (rule.condition === "not_empty") return value.trim().length > 0;
  if (rule.condition === "numeric_lte") return Number(value) <= (Number(rule.pattern) || 0);
  if (rule.condition === "numeric_gte") return Number(value) >= (Number(rule.pattern) || 0);
  const keywords = rule.pattern.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (keywords.length === 0) return false;
  if (rule.condition === "keyword_all") return keywords.every((keyword) => normalized.includes(keyword));
  return keywords.some((keyword) => normalized.includes(keyword));
}

function readJsonPath(rawJson: string, path: string) {
  const parsed = JSON.parse(rawJson);
  const keys = path.replace(/^\$\./, "").split(".").filter(Boolean);
  const value = keys.reduce<unknown>((current, key) => {
    if (current && typeof current === "object" && key in current) {
      return (current as Record<string, unknown>)[key];
    }
    return "";
  }, parsed);
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function maskPhoneNumber(value: string) {
  const match = value.match(/^(\d{3})-\d{4}-(\d{4})$/);
  if (!match) return value;
  return `${match[1]}-****-${match[2]}`;
}

function runQualityRules(rows: TransformQualitySampleRow[], qualityRules: TransformQualityRuleInput[]): TransformQualityValidationResult {
  const failedRows = rows.flatMap((row) => {
    return qualityRules.flatMap((rule) => {
      const reason = getQualityFailureReason(row[rule.targetColumn] ?? "", rule);
      if (!reason) return [];
      return [{
        action: rule.failureAction,
        column: rule.targetColumn,
        reason,
        ruleId: rule.id,
        row: String(row.row_id ?? ""),
        sampleValue: row[rule.targetColumn] ?? "",
      }];
    });
  });
  const invalidRowIds = new Set(failedRows.map((row) => row.row));
  const invalidRowCount = invalidRowIds.size;
  const passRate = rows.length ? Number((((rows.length - invalidRowCount) / rows.length) * 100).toFixed(1)) : 100;
  const qualityScore = passRate;
  const hasBlockingFailure = failedRows.some((row) => row.action === "Fail Run");
  const status: TransformQualityValidationResult["status"] = invalidRowCount === 0 ? "pass" : hasBlockingFailure ? "fail" : "warn";

  return {
    failedRows,
    invalidRowCount,
    passRate,
    qualityScore,
    sampleRows: rows.length,
    status,
    summary: `Quality score ${qualityScore}% - pass rate ${passRate}% - invalid rows ${invalidRowCount}`,
  };
}

function getQualityFailureReason(value: string, rule: TransformQualityRuleInput) {
  switch (rule.validationType) {
    case "Accepted Values":
      return ["KOR", "JPN", "USA", "KR", "US"].includes(value) ? "" : "Value is outside accepted set";
    case "Not Null":
      return value.trim() ? "" : "Missing required value";
    case "Range Check": {
      const numericValue = Number(value);
      return Number.isFinite(numericValue) && numericValue > 0 ? "" : "Numeric range check failed";
    }
    case "Regex Match":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? "" : "Email format check failed";
    default:
      return "";
  }
}

function selectStepPreviewRows(
  beforeRows: TransformQualitySampleRow[],
  afterRows: TransformQualitySampleRow[],
  columns: string[],
  step: TransformQualityRecipeStepInput,
  failedIndexes: number[],
) {
  const changedIndexes = beforeRows
    .map((row, index) => ({ index, changed: (afterRows[index]?.[step.output] ?? "") !== (row[step.output] ?? "") }))
    .filter((row) => row.changed)
    .map((row) => row.index);
  const fallbackIndexes = beforeRows.map((_, index) => index);
  const selectedIndexes = Array.from(new Set([...failedIndexes, ...changedIndexes, ...fallbackIndexes])).slice(0, 5);

  return {
    afterRows: selectedIndexes.map((index) => columns.map((column) => afterRows[index]?.[column] ?? "")),
    beforeRows: selectedIndexes.map((index) => columns.map((column) => beforeRows[index]?.[column] ?? "")),
  };
}
