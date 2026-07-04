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

export const TRANSFORM_QUALITY_SAMPLE_PROFILE = {
  csvPath: "docs/mock-data/customer_reviews_transform_quality_sample_1000.csv",
  datasetId: "customer_review_raw",
  sourceName: "customer_reviews_transform_quality_sample_1000.csv",
  totalRows: 1000,
  columns: [
    "row_id",
    "user_id",
    "order_id",
    "user_email",
    "price_usd",
    "country",
    "created_at",
    "phone_number",
    "rating",
    "meta_json",
    "review_text",
    "quality_issue",
  ],
  sampleRows: [
    ["1", "USR-00001", "ORD-00001", "customer1@example.com", "49.51", "KOR", "2026-07-02T10:01:00.000Z", "010-1001-2007", "2", "{\"campaign\":\"organic\",\"source\":\"mock-csv\",\"user\":{\"contact\":{\"email\":\"customer1@example.com\"}}}", "clean packaging / sample row 1", "ok"],
    ["2", "USR-00002", "ORD-00002", "customer2@asklake.io", "86.52", "JPN", "2026-07-03T11:02:00.000Z", "010-1002-2014", "3", "{\"campaign\":\"summer\",\"source\":\"mock-csv\",\"user\":{\"contact\":{\"email\":\"customer2@asklake.io\"}}}", "needs follow up / sample row 2", "ok"],
    ["113", "", "ORD-00113", "customer113@example.com", "593.63", "JPN", "2026-07-02T14:53:00.000Z", "010-1113-2791", "4", "{\"campaign\":\"organic\",\"source\":\"mock-csv\",\"user\":{\"contact\":{\"email\":\"customer113@example.com\"}}}", "clean packaging / sample row 113", "missing user_id"],
    ["131", "USR-00131", "ORD-00131", "customer131_invalid_email", "359.81", "JPN", "2026-07-04T20:11:00.000Z", "010-1131-2917", "2", "{\"campaign\":\"organic\",\"source\":\"mock-csv\",\"user\":{\"contact\":{\"email\":\"customer131_invalid_email\"}}}", "great value / sample row 131", "invalid_email"],
    ["149", "USR-00149", "ORD-00149", "customer149@example.com", "N/A", "USA", "2026-07-02T14:29:00.000Z", "010-1149-3043", "5", "{\"campaign\":\"organic\",\"source\":\"mock-csv\",\"user\":{\"contact\":{\"email\":\"customer149@example.com\"}}}", "repeat buyer / sample row 149", "bad_price"],
    ["173", "USR-00173", "ORD-00173", "customer173@example.com", "104.73", "JPN", "not-a-date", "010-1173-3211", "4", "{\"campaign\":\"organic\",\"source\":\"mock-csv\",\"user\":{\"contact\":{\"email\":\"customer173@example.com\"}}}", "premium item / sample row 173", "bad_timestamp"],
    ["191", "USR-00191", "ORD-00191", "customer191@shop.test", "774.91", "UNKNOWN", "2026-07-04T20:11:00.000Z", "010-1191-3337", "2", "{\"campaign\":\"organic\",\"source\":\"mock-csv\",\"user\":{\"contact\":{\"email\":\"customer191@shop.test\"}}}", "fast delivery / sample row 191", "invalid_country"],
    ["223", "USR-00223", "ORD-00223", "customer223@shop.test", "159.23", "JPN", "2026-07-04T16:43:00.000Z", "010-1223-3561", "4", "{broken-json", "fast delivery / sample row 223", "bad_json"],
  ],
} as const;

export const RECOMMENDED_TRANSFORM_STEPS: RecommendedTransformStep[] = [
  { id: "1", enabled: true, input: "meta_json", operation: "Extract JSONPath", output: "user_email", params: "$.user.contact.email", onError: "Set Null" },
  { id: "2", enabled: true, input: "user_email", operation: "Lowercase + Trim", output: "user_email", params: "lower(), trim()", onError: "Warn" },
  { id: "3", enabled: true, input: "price_usd", operation: "Cast Decimal", output: "price_usd", params: "decimal(10,2)", onError: "Drop Row" },
  { id: "4", enabled: true, input: "created_at", operation: "Parse Timestamp", output: "created_at_utc", params: "string to UTC", onError: "Set Null" },
  { id: "5", enabled: true, input: "phone_number", operation: "Mask", output: "phone_masked", params: "keep first 3 digits", onError: "Warn" },
];

export const QUALITY_RULE_OPTIONS: QualityRuleOption[] = [
  { id: "qr-user-id-required", validationType: "Not Null", targetColumn: "user_id", severity: "Error", failureAction: "Fail Run" },
  { id: "qr-email-format", validationType: "Regex Match", targetColumn: "user_email", severity: "Warning", failureAction: "Quarantine" },
  { id: "qr-price-positive", validationType: "Range Check", targetColumn: "price_usd", severity: "Error", failureAction: "Quarantine" },
  { id: "qr-country-accepted", validationType: "Accepted Values", targetColumn: "country", severity: "Warning", failureAction: "Warn" },
];

export const TRANSFORM_QUALITY_PREVIEW_BY_STEP_ID: Record<string, TransformQualityPreviewSample> = {
  "1": {
    affectedColumn: "user_email",
    failedRows: 0,
    inputValue: '{ "user": { "contact": { "email": "customer1@example.com" } } }',
    matchedRows: 1000,
    outputValue: "customer1@example.com",
    status: "Success",
  },
  "2": {
    affectedColumn: "user_email",
    failedRows: 15,
    inputValue: "  Customer131_Invalid_Email  ",
    matchedRows: 985,
    outputValue: "customer131_invalid_email",
    status: "Review",
  },
  "3": {
    affectedColumn: "price_usd",
    failedRows: 0,
    inputValue: "593.63",
    matchedRows: 1000,
    outputValue: "593.63",
    status: "Success",
  },
  "4": {
    affectedColumn: "created_at_utc",
    failedRows: 0,
    inputValue: "2026-07-02T10:01:00.000Z",
    matchedRows: 1000,
    outputValue: "2026-07-02 10:01:00 UTC",
    status: "Success",
  },
  "5": {
    affectedColumn: "phone_masked",
    failedRows: 0,
    inputValue: "010-1001-2007",
    matchedRows: 1000,
    outputValue: "010-****-2007",
    status: "Success",
  },
};

export const TRANSFORM_QUALITY_INVALID_ROWS: TransformQualityInvalidRow[] = [
  { row: "Row #113", column: "user_id", reason: "Missing required value", action: "Fail Run", sampleValue: "" },
  { row: "Row #226", column: "user_id", reason: "Missing required value", action: "Fail Run", sampleValue: "" },
  { row: "Row #339", column: "user_id", reason: "Missing required value", action: "Fail Run", sampleValue: "" },
  { row: "Row #131", column: "user_email", reason: "Email format check failed", action: "Quarantine", sampleValue: "customer131_invalid_email" },
  { row: "Row #262", column: "user_email", reason: "Email format check failed", action: "Quarantine", sampleValue: "customer262_invalid_email" },
  { row: "Row #393", column: "user_email", reason: "Email format check failed", action: "Quarantine", sampleValue: "customer393_invalid_email" },
];

export const TRANSFORM_QUALITY_VALIDATION_RESULT = {
  failedRows: TRANSFORM_QUALITY_INVALID_ROWS,
  invalidRowCount: 15,
  passRate: 98.5,
  qualityScore: 98.5,
  sampleRows: TRANSFORM_QUALITY_SAMPLE_PROFILE.totalRows,
  status: "warn" as const,
  summary: "98.5% quality score · 98.5% pass rate · 15 invalid rows · user_id/email rules need review",
};

const COUNTRIES = ["KOR", "JPN", "USA"] as const;
const EMAIL_DOMAINS = ["example.com", "asklake.io", "shop.test", "acme.com"] as const;
const CAMPAIGNS = ["organic", "summer"] as const;
const REVIEW_TEXTS = [
  "clean packaging",
  "needs follow up",
  "great value",
  "refund requested",
  "repeat buyer",
  "premium item",
  "support contacted",
  "fast delivery",
] as const;

export function createTransformQualitySampleRows(totalRows = TRANSFORM_QUALITY_SAMPLE_PROFILE.totalRows): TransformQualitySampleRow[] {
  return Array.from({ length: totalRows }, (_, index) => {
    const rowNumber = index + 1;
    const qualityIssues: string[] = [];
    const addIssue = (issue: string) => {
      qualityIssues.push(issue);
    };

    let country: string = COUNTRIES[index % COUNTRIES.length];
    const campaign = CAMPAIGNS[index % CAMPAIGNS.length];
    const emailDomain = EMAIL_DOMAINS[index % EMAIL_DOMAINS.length];
    let userId = `USR-${String(rowNumber).padStart(5, "0")}`;
    let normalizedEmail = `customer${rowNumber}@${emailDomain}`;
    let price = ((rowNumber * 37) % 900 + rowNumber / 100).toFixed(2);
    const hour = String(9 + (rowNumber % 12)).padStart(2, "0");
    const minute = String(rowNumber % 60).padStart(2, "0");
    const day = String(1 + (rowNumber % 4)).padStart(2, "0");
    let createdAt = `2026-07-${day}T${hour}:${minute}:00.000Z`;
    let phoneNumber = `010-${String(1000 + rowNumber).slice(-4)}-${String(2000 + ((rowNumber * 7) % 8000)).padStart(4, "0")}`;
    let reviewText = `${REVIEW_TEXTS[index % REVIEW_TEXTS.length]} / sample row ${rowNumber}`;

    if (rowNumber % 113 === 0) {
      userId = "";
      addIssue("missing user_id");
    }
    if (rowNumber % 131 === 0) {
      normalizedEmail = `customer${rowNumber}_invalid_email`;
      addIssue("invalid_email");
    }
    if (rowNumber % 149 === 0) {
      price = "N/A";
      addIssue("bad_price");
    }
    if (rowNumber % 167 === 0) {
      price = "-42.00";
      addIssue("negative_price");
    }
    if (rowNumber % 173 === 0) {
      createdAt = "not-a-date";
      addIssue("bad_timestamp");
    }
    if (rowNumber % 191 === 0) {
      country = "UNKNOWN";
      addIssue("invalid_country");
    }
    if (rowNumber % 211 === 0) {
      phoneNumber = "NO_PHONE";
      addIssue("bad_phone");
    }
    if (rowNumber % 227 === 0) {
      reviewText = "";
      addIssue("empty_review_text");
    }

    const userEmail = rowNumber <= 5 || (rowNumber % 17 === 0 && rowNumber % 131 !== 0) ? `  Customer${rowNumber}@${emailDomain.toUpperCase()}  ` : normalizedEmail;
    const metaJson = rowNumber % 223 === 0 ? "{broken-json" : JSON.stringify({
      campaign,
      source: "mock-csv",
      user: {
        contact: {
          email: userEmail,
        },
      },
    });
    if (rowNumber % 223 === 0) addIssue("bad_json");

    return {
      row_id: String(rowNumber),
      user_id: userId,
      order_id: `ORD-${String(rowNumber).padStart(5, "0")}`,
      user_email: userEmail,
      price_usd: price,
      country,
      created_at: createdAt,
      phone_number: phoneNumber,
      rating: String((rowNumber % 5) + 1),
      meta_json: metaJson,
      review_text: reviewText,
      quality_issue: qualityIssues.length > 0 ? qualityIssues.join(", ") : "ok",
    };
  });
}

export function runTransformQualitySamplePreview(
  recipeSteps: TransformQualityRecipeStepInput[],
  qualityRules: TransformQualityRuleInput[],
  sampleRows = createTransformQualitySampleRows(),
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
        row: `Row #${row.row_id}`,
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
    summary: `${qualityScore}% quality score · ${passRate}% pass rate · ${invalidRowCount} invalid rows`,
  };
}

function getQualityFailureReason(value: string, rule: TransformQualityRuleInput) {
  switch (rule.validationType) {
    case "Accepted Values":
      return ["KOR", "JPN", "USA"].includes(value) ? "" : "Value is outside accepted set";
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
