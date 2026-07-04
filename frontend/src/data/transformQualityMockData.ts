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
  sampleValue: string;
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
    ["1", "USR-00001", "ORD-00001", "customer1@example.com", "49.51", "KOR", "2026-07-02T10:01:00.000Z", "010-1001-2007", "2", "organic", "clean packaging / sample row 1", "ok"],
    ["2", "USR-00002", "ORD-00002", "customer2@asklake.io", "86.52", "JPN", "2026-07-03T11:02:00.000Z", "010-1002-2014", "3", "summer", "needs follow up / sample row 2", "ok"],
    ["113", "", "ORD-00113", "customer113@example.com", "593.63", "JPN", "2026-07-02T14:53:00.000Z", "010-1113-2791", "4", "organic", "clean packaging / sample row 113", "missing user_id"],
    ["131", "USR-00131", "ORD-00131", "customer131_invalid_email", "359.81", "JPN", "2026-07-04T20:11:00.000Z", "010-1131-2917", "2", "organic", "great value / sample row 131", "invalid_email"],
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
