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
    if (operation.includes("json")) {
      return { failed: false, value: readJsonPath(inputValue, step.params) };
    }
    if (operation.includes("upper")) {
      const trimmedValue = operation.includes("trim") ? inputValue.trim() : inputValue;
      return { failed: false, value: trimmedValue.toUpperCase() };
    }
    if (operation.includes("lower")) {
      const trimmedValue = operation.includes("trim") ? inputValue.trim() : inputValue;
      return { failed: false, value: trimmedValue.toLowerCase() };
    }
    if (operation.includes("trim")) {
      return { failed: false, value: inputValue.trim() };
    }
    if (operation.includes("replace")) {
      const { search, replacement } = parseReplaceParams(step.params);
      return { failed: false, value: inputValue.split(search).join(replacement) };
    }
    if (operation.includes("substr") || operation.includes("substring")) {
      const { length, startIndex } = parseSubstringParams(step.params);
      return { failed: false, value: inputValue.slice(startIndex, startIndex + length) };
    }
    if (operation.includes("concat")) {
      const delimiter = step.params.trim() || "-";
      return { failed: false, value: `${inputValue}${delimiter}${inputValue}` };
    }
    if (operation.includes("decimal") || operation.includes("cast")) {
      const value = Number(inputValue);
      return Number.isFinite(value) ? { failed: false, value: value.toFixed(2) } : { failed: true, value: "" };
    }
    if (operation.includes("round")) {
      const value = Number(inputValue);
      const decimals = parseIntegerParam(step.params, 2);
      return Number.isFinite(value) ? { failed: false, value: value.toFixed(decimals) } : { failed: true, value: "" };
    }
    if (operation.includes("abs")) {
      const value = Number(inputValue);
      return Number.isFinite(value) ? { failed: false, value: String(Math.abs(value)) } : { failed: true, value: "" };
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

function parseReplaceParams(params: string) {
  const rawParams = params.trim();
  if (!rawParams) return { search: "sample", replacement: "SAMPLE" };
  const separator = rawParams.includes("=>") ? "=>" : ",";
  const [search = "sample", replacement = "SAMPLE"] = rawParams.split(separator).map((value) => value.trim());
  return {
    search: search || "sample",
    replacement,
  };
}

function parseSubstringParams(params: string) {
  const [rawStart = "1", rawLength = "5"] = params.split(",").map((value) => value.trim());
  const start = Math.max(1, parseIntegerParam(rawStart, 1));
  const length = Math.max(0, parseIntegerParam(rawLength, 5));
  return { length, startIndex: start - 1 };
}

function parseIntegerParam(value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
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
        row: `${row.row_id}행`,
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
    summary: `품질 점수 ${qualityScore}% · 통과율 ${passRate}% · 유효하지 않은 행 ${invalidRowCount}개`,
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
