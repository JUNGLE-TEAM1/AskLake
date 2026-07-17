export type TransformQualitySeverity = "Warning" | "Error";
export type TransformQualityFailureAction = "Warn" | "Quarantine" | "Fail Run" | "Drop Row" | "Set Null";

export type TransformQualityPreviewSample = {
  affectedColumn: string;
  failedRows: number;
  inputValue: string;
  matchedRows: number;
  outputValue: string;
  status: "Success" | "Review";
  runtime: "local" | "gateway" | "pending";
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
  params?: string;
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

export type TransformQualityRuntimeOutputs = Record<string, TransformQualitySampleRow[]>;

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

export type ReviewAnalysisMethod =
  | "copy"
  | "one_of_values"
  | "instruction";

export type ReviewAnalysisColumnConfig = {
  allowedValues: string[];
  instruction: string;
  method: ReviewAnalysisMethod;
  sourceField: string;
  targetName: string;
};

const REVIEW_ANALYSIS_METHODS = new Set<ReviewAnalysisMethod>([
  "copy",
  "one_of_values",
  "instruction",
]);

export function runTransformQualitySamplePreview(
  recipeSteps: TransformQualityRecipeStepInput[],
  qualityRules: TransformQualityRuleInput[],
  sampleRows: TransformQualitySampleRow[] = [],
  runtimeOutputs: TransformQualityRuntimeOutputs = {},
): TransformQualityRunnerResult {
  const previewByStepId: Record<string, TransformQualityStepPreview> = {};
  let transformedRows = sampleRows.map((row) => ({ ...row }));

  recipeSteps.forEach((step) => {
    const beforeRows = transformedRows.map((row) => ({ ...row }));
    let failedRows = 0;
    const failedIndexes: number[] = [];
    const reviewAnalysisStep = isReviewAnalysisStep(step);
    const runtimeRows = reviewAnalysisStep ? runtimeOutputs[reviewAnalysisRuntimeKey(step)] : undefined;

    transformedRows = transformedRows.map((row, rowIndex) => {
      const { failed, value } = applyTransformStep(row, step, rowIndex, runtimeRows);
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
      runtime: reviewAnalysisStep ? runtimeRows ? "gateway" : "pending" : "local",
      status: failedRows > 0 || (reviewAnalysisStep && !runtimeRows) ? "Review" : "Success",
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

function applyTransformStep(
  row: TransformQualitySampleRow,
  step: TransformQualityRecipeStepInput,
  rowIndex: number,
  runtimeRows?: TransformQualitySampleRow[],
) {
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
    if (isReviewAnalysisStep(step)) {
      const runtimeRow = runtimeRows?.[rowIndex];
      if (!runtimeRow || !(step.output in runtimeRow)) {
        return { failed: true, value: "" };
      }
      return { failed: false, value: runtimeRow[step.output] ?? "" };
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

export function isReviewAnalysisStep(step: TransformQualityRecipeStepInput) {
  const operation = step.operation.toLowerCase();
  return operation.includes("review row analysis")
    || operation.includes("text row analysis")
    || operation.includes("review_analyze")
    || operation.includes("text_analyze");
}

export function reviewAnalysisRuntimeKey(step: TransformQualityRecipeStepInput) {
  return JSON.stringify({
    id: step.id,
    input: step.input,
    operation: step.operation,
    output: step.output,
    params: step.params,
  });
}

export function parseReviewAnalysisConfig(step: TransformQualityRecipeStepInput): ReviewAnalysisColumnConfig {
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
  if (method === "copy_or_extract_field") return "copy";
  if (method === "custom_instruction" || method === "instruction" || method === "summary" || method === "extractive_summary" || method === "evidence" || method === "evidence_span") return "instruction";
  if (["sentiment", "sentiment_3way", "issue_present", "issue_present_binary", "action_needed", "action_needed_binary", "boolean_y_n", "issue_taxonomy", "issue_category", "issue_subcategory", "severity_4level"].includes(method)) return "one_of_values";
  return REVIEW_ANALYSIS_METHODS.has(method as ReviewAnalysisMethod) ? method as ReviewAnalysisMethod : fallback;
}

function inferReviewAnalysisMethod(targetName: string): ReviewAnalysisMethod {
  const target = normalizePreviewName(targetName);
  if (["review_id", "asin", "parent_asin", "rating", "title", "text", "review_text", "timestamp", "event_time", "user_id", "verified_purchase", "helpful_vote"].includes(target)) {
    return "copy";
  }
  if (target === "sentiment" || target === "issue_present" || target === "has_issue" || target === "action_needed" || target === "needs_action" || target === "issue_subcategory" || target === "issue_category" || target === "severity") {
    return "one_of_values";
  }
  if (target === "summary" || target === "evidence" || target.includes("reason")) {
    return "instruction";
  }
  if (target.endsWith("_yn") || target.startsWith("is_") || target.startsWith("has_")) {
    return "one_of_values";
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
