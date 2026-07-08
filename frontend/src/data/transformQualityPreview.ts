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
    if (operation.includes("default")) {
      return { failed: false, value: inputValue.trim() ? inputValue : step.params };
    }
    if (operation.includes("null guard") || operation.includes("not null")) {
      return inputValue.trim() ? { failed: false, value: inputValue } : { failed: true, value: "" };
    }
    if (operation.includes("sql expression")) {
      return { failed: false, value: inputValue };
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
