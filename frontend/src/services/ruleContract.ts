import type {
  CanonicalRuleDraft,
  KafkaExecutionMode,
  QualityRuleDraft,
  RuleCompilationIssue,
  RuleCompilationResult,
  SchemaColumnDraft,
  TransformStepDraft,
} from "../types";

export const RULE_CONTRACT_VERSION = "1.0" as const;

const transformOperations = new Set([
  "cast", "copy", "custom_csv_classifier", "default_value", "json_extract", "lowercase_trim", "mask",
  "null_guard", "parse_timestamp", "rename", "sql_expression", "sql_result_materialize", "text_row_analysis",
]);
const qualityOperations = new Set(["accepted_values", "not_null", "range", "regex"]);
const kafkaSnapshotTransforms = new Set([
  "cast", "copy", "default_value", "json_extract", "lowercase_trim", "mask", "null_guard", "parse_timestamp", "rename",
]);
const continuousTransforms = kafkaSnapshotTransforms;
const continuousQuality = qualityOperations;
const validRuleKinds = new Set(["transform", "quality"]);
const validErrorPolicies = new Set(["fail_batch", "quarantine", "warn"]);
const validFailureDispositions = new Set(["keep", "drop_row", "set_null"]);
const validSeverities = new Set(["warning", "error"]);
const parameterKeys = new Map<string, ReadonlySet<string> | null>([
  ["transform:cast", new Set(["format", "targetType"])],
  ["transform:copy", new Set()],
  ["transform:custom_csv_classifier", null],
  ["transform:default_value", new Set(["value"])],
  ["transform:json_extract", new Set(["path"])],
  ["transform:lowercase_trim", new Set()],
  ["transform:mask", new Set(["policy"])],
  ["transform:null_guard", new Set()],
  ["transform:parse_timestamp", new Set(["format"])],
  ["transform:rename", new Set()],
  ["transform:sql_expression", new Set(["expression"])],
  ["transform:sql_result_materialize", null],
  ["transform:text_row_analysis", null],
  ["quality:accepted_values", new Set(["values"])],
  ["quality:not_null", new Set()],
  ["quality:range", new Set(["inclusive", "max", "min"])],
  ["quality:regex", new Set(["pattern"])],
]);

export function canonicalRulesFromLegacy(
  transformSteps: TransformStepDraft[],
  qualityRules: QualityRuleDraft[],
  schemaColumns: SchemaColumnDraft[],
  transformOutputColumns: Array<[string, string]> = [],
): CanonicalRuleDraft[] {
  const typeByName = schemaTypeMap(schemaColumns, transformOutputColumns);
  const transforms = transformSteps.map((step, index) => {
    const operation = normalizeOperation(step.operation || step.kind, "transform");
    const parameters = step.canonicalParameters
      ? { ...step.canonicalParameters }
      : legacyParameters(operation, step.params, "transform");
    const [onError, failureDisposition] = canonicalFailurePolicy(step.onError);
    return {
      contractVersion: RULE_CONTRACT_VERSION,
      enabled: step.enabled !== false,
      failureDisposition,
      id: step.id || `transform-${index + 1}`,
      inputColumns: step.input ? [step.input] : [],
      kind: "transform",
      label: step.label,
      onError,
      operation,
      outputColumns: step.output ? [step.output] : [],
      outputType: inferOutputType(operation, typeByName.get(step.output), parameters, typeByName.get(step.input) ?? "String"),
      parameters,
    } satisfies CanonicalRuleDraft;
  });
  const quality = qualityRules.map((rule, index) => {
    const operation = normalizeOperation(rule.validationType || rule.kind, "quality");
    const [onError, failureDisposition] = canonicalFailurePolicy(rule.failureAction);
    return {
      contractVersion: RULE_CONTRACT_VERSION,
      enabled: rule.enabled !== false,
      failureDisposition,
      id: rule.id || `quality-${index + 1}`,
      inputColumns: rule.targetColumn ? [rule.targetColumn] : [],
      kind: "quality",
      onError,
      operation,
      outputColumns: [],
      parameters: rule.canonicalParameters
        ? { ...rule.canonicalParameters }
        : legacyParameters(operation, rule.params, "quality"),
      severity: rule.severity === "Error" ? "error" : "warning",
    } satisfies CanonicalRuleDraft;
  });
  return [...transforms, ...quality];
}

export function legacyRulesFromCanonical(rules: CanonicalRuleDraft[]) {
  const transformSteps = rules.filter((rule) => rule.kind === "transform").map((rule) => {
    const input = rule.inputColumns[0] ?? "";
    const output = rule.outputColumns[0] ?? input;
    const [operation, kind] = legacyTransformOperation(rule.operation, rule.outputType);
    return {
      canonicalParameters: { ...rule.parameters },
      enabled: rule.enabled,
      id: rule.id,
      input,
      kind,
      label: rule.label ?? `${operation}: ${input} -> ${output}`,
      onError: legacyFailurePolicy(rule),
      operation,
      output,
      params: legacyParameterString(rule),
    } satisfies TransformStepDraft;
  });
  const qualityRules = rules.filter((rule) => rule.kind === "quality").map((rule) => {
    const [validationType, kind] = legacyQualityOperation(rule.operation);
    return {
      canonicalParameters: { ...rule.parameters },
      enabled: rule.enabled,
      failureAction: legacyFailurePolicy(rule) as QualityRuleDraft["failureAction"],
      id: rule.id,
      kind: kind as QualityRuleDraft["kind"],
      params: legacyParameterString(rule),
      severity: rule.severity === "error" ? "Error" : "Warning",
      targetColumn: rule.inputColumns[0] ?? "",
      validationType: validationType as QualityRuleDraft["validationType"],
    } satisfies QualityRuleDraft;
  });
  return { qualityRules, transformSteps };
}

export function compileRuleContract({
  contractVersion,
  executionMode = "snapshot",
  qualityRules,
  rules,
  schemaColumns,
  sourceType,
  transformOutputColumns = [],
  transformSteps,
}: {
  contractVersion?: string;
  executionMode?: KafkaExecutionMode;
  qualityRules: QualityRuleDraft[];
  rules?: CanonicalRuleDraft[];
  schemaColumns: SchemaColumnDraft[];
  sourceType: string;
  transformOutputColumns?: Array<[string, string]>;
  transformSteps: TransformStepDraft[];
}): RuleCompilationResult {
  const canonical = rules !== undefined
    ? rules
    : canonicalRulesFromLegacy(transformSteps, qualityRules, schemaColumns, transformOutputColumns);
  const available = schemaTypeMap(schemaColumns);
  const outputTypes = new Map<string, string>();
  schemaColumns.filter((column) => column.included !== false).forEach((column) => {
    const target = column.targetName || column.sourceName;
    const targetType = canonicalSchemaType(column.type);
    if (target) outputTypes.set(target, targetType);
  });
  const declaredTypes = new Map(transformOutputColumns.map(([name, type]) => [name, canonicalSchemaType(type)]));
  const issues: RuleCompilationIssue[] = [];
  if (rules !== undefined && contractVersion === undefined) {
    issues.push(issue(
      "RULE_CONTRACT_VERSION_REQUIRED",
      "ruleContractVersion",
      "Canonical rules require ruleContractVersion 1.0.",
    ));
  } else if (contractVersion !== undefined && contractVersion !== RULE_CONTRACT_VERSION) {
    issues.push(issue(
      "RULE_CONTRACT_VERSION_UNSUPPORTED",
      "ruleContractVersion",
      `Unsupported rule contract version: ${contractVersion}`,
    ));
  }
  const seenIds = new Set<string>();
  const kafkaSnapshot = executionMode === "snapshot" && sourceType.toLowerCase().includes("kafka");
  const normalizedRules = canonical.map((rule, index) => {
    const kind = String(rule.kind ?? "");
    const id = rule.id.trim() || `rule-${index + 1}`;
    const operation = normalizeOperation(rule.operation, kind as CanonicalRuleDraft["kind"]);
    const inputColumns = uniqueNames(rule.inputColumns);
    const outputColumns = uniqueNames(rule.outputColumns);
    const parameters = { ...rule.parameters };
    const onError = String(rule.onError ?? "");
    const failureDisposition = String(rule.failureDisposition ?? "");
    const severity = String(rule.severity ?? (kind === "quality" ? "warning" : ""));
    if (seenIds.has(id)) issues.push(issue("RULE_ID_DUPLICATE", "id", `Duplicate rule id: ${id}`, id));
    seenIds.add(id);
    if (String(rule.contractVersion ?? "") !== RULE_CONTRACT_VERSION) {
      issues.push(issue("RULE_CONTRACT_VERSION_UNSUPPORTED", "contractVersion", `Unsupported rule contract version: ${String(rule.contractVersion ?? "")}`, id));
    }
    if (!validRuleKinds.has(kind)) issues.push(issue("RULE_KIND_UNSUPPORTED", "kind", `Unsupported rule kind: ${kind}`, id));
    if (!validErrorPolicies.has(onError)) issues.push(issue("RULE_ERROR_POLICY_UNSUPPORTED", "onError", `Unsupported onError policy: ${onError}`, id));
    if (!validFailureDispositions.has(failureDisposition)) {
      issues.push(issue("RULE_FAILURE_DISPOSITION_UNSUPPORTED", "failureDisposition", `Unsupported failureDisposition: ${failureDisposition}`, id));
    }
    if (["fail_batch", "quarantine"].includes(onError) && ["drop_row", "set_null"].includes(failureDisposition)) {
      issues.push(issue("RULE_FAILURE_POLICY_CONFLICT", "failureDisposition", `${onError} requires failureDisposition 'keep'.`, id));
    }
    if (severity && !validSeverities.has(severity)) issues.push(issue("RULE_SEVERITY_UNSUPPORTED", "severity", `Unsupported severity: ${severity}`, id));
    const supported = kind === "transform" ? transformOperations : kind === "quality" ? qualityOperations : new Set<string>();
    if (!supported.has(operation)) issues.push(issue("RULE_OPERATION_UNSUPPORTED", "operation", `Unsupported ${kind || "unknown"} operation: ${rule.operation}`, id));
    const allowedParameterKeys = parameterKeys.get(`${kind}:${operation}`);
    if (allowedParameterKeys !== undefined && allowedParameterKeys !== null) {
      const unsupportedKeys = Object.keys(parameters).filter((key) => !allowedParameterKeys.has(key)).sort();
      if (unsupportedKeys.length > 0) {
        issues.push(issue("RULE_PARAMETER_UNSUPPORTED", "parameters", `Unsupported parameters for ${operation}: ${unsupportedKeys.join(", ")}`, id));
      }
    }
    if (rule.enabled) {
      if (executionMode === "continuous" && (
        (kind === "transform" && !continuousTransforms.has(operation))
        || (kind === "quality" && !continuousQuality.has(operation))
      )) {
        issues.push(issue("RULE_EXECUTION_MODE_UNSUPPORTED", "operation", `Continuous does not support stateful or engine-specific ${kind} operation: ${operation}`, id));
      } else if (kafkaSnapshot && rule.kind === "transform" && !kafkaSnapshotTransforms.has(operation)) {
        issues.push(issue("RULE_EXECUTION_MODE_UNSUPPORTED", "operation", `Kafka Snapshot does not support transform operation: ${operation}`, id));
      }
      if (inputColumns.length !== 1) issues.push(issue("RULE_INPUT_ARITY", "inputColumns", "Current rule contract requires exactly one input column.", id));
      inputColumns.forEach((name) => {
        if (!availableInputType(available, name)) issues.push(issue("RULE_INPUT_NOT_FOUND", "inputColumns", `Rule input column does not exist: ${name}`, id));
      });
      if (kind === "transform" && outputColumns.length !== 1) {
        issues.push(issue("RULE_OUTPUT_ARITY", "outputColumns", "Transform rules require exactly one output column.", id));
      }
      if (kind === "quality" && outputColumns.length > 0) {
        issues.push(issue("RULE_OUTPUT_NOT_ALLOWED", "outputColumns", "Quality rules do not create output columns.", id));
      }
      validateRuleParameters(operation, parameters, id, issues);
    }
    const inputType = availableInputType(available, inputColumns[0] ?? "") ?? "String";
    const outputType = kind === "transform"
      ? inferOutputType(operation, rule.outputType ?? declaredTypes.get(outputColumns[0] ?? ""), parameters, inputType)
      : undefined;
    if (rule.enabled && kind === "transform" && outputColumns.length === 1) {
      available.set(outputColumns[0], outputType ?? "String");
      outputTypes.set(outputColumns[0], outputType ?? "String");
    }
    return {
      ...rule,
      contractVersion: RULE_CONTRACT_VERSION,
      failureDisposition: failureDisposition as CanonicalRuleDraft["failureDisposition"],
      id,
      inputColumns,
      kind: kind as CanonicalRuleDraft["kind"],
      onError: onError as CanonicalRuleDraft["onError"],
      operation,
      outputColumns,
      outputType,
      parameters,
      ...(severity ? { severity: severity as CanonicalRuleDraft["severity"] } : {}),
    } satisfies CanonicalRuleDraft;
  });
  const fullSqlTransform = normalizedRules.some((rule) => {
    const expression = String(rule.parameters.expression ?? "").trim().toLowerCase();
    return rule.enabled
      && rule.kind === "transform"
      && rule.operation === "sql_expression"
      && (expression.startsWith("select") || expression.startsWith("with"));
  });
  if (fullSqlTransform && declaredTypes.size === 0) {
    issues.push(issue(
      "RULE_OUTPUT_SCHEMA_REQUIRED",
      "transformOutputColumns",
      "Full SQL transforms require a validated output schema.",
    ));
  }
  return {
    contractVersion: RULE_CONTRACT_VERSION,
    issues,
    outputSchema: Array.from((fullSqlTransform ? declaredTypes : outputTypes).entries()),
    rules: normalizedRules,
    status: issues.length > 0 ? "fail" : "pass",
  };
}

function normalizeOperation(value: string, kind: CanonicalRuleDraft["kind"]) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (kind === "quality") {
    if (normalized.includes("not_null") || normalized === "notnull") return "not_null";
    if (normalized.includes("accepted")) return "accepted_values";
    if (normalized.includes("range")) return "range";
    if (normalized.includes("regex")) return "regex";
    if (normalized.includes("unique")) return "unique";
    return normalized;
  }
  if (normalized.includes("sql_result_materialize")) return "sql_result_materialize";
  if (normalized.includes("sql_expression")) return "sql_expression";
  if (["review_row_analysis", "text_row_analysis", "review_analyze", "text_analyze"].some((token) => normalized.includes(token))) return "text_row_analysis";
  if (normalized.includes("custom_csv_classifier") || normalized === "csv_classifier") return "custom_csv_classifier";
  if (normalized.includes("default")) return "default_value";
  if (normalized.includes("null_guard") || normalized.includes("not_null")) return "null_guard";
  if (normalized.includes("json")) return "json_extract";
  if (normalized.includes("lower") || normalized.includes("trim")) return "lowercase_trim";
  if (normalized.includes("decimal") || normalized.startsWith("cast")) return "cast";
  if (normalized.includes("timestamp") || ["date", "parse_date"].includes(normalized)) return "parse_timestamp";
  if (normalized.includes("mask")) return "mask";
  if (normalized.includes("rename")) return "rename";
  if (["copy", "derive", ""].includes(normalized)) return "copy";
  return normalized;
}

function canonicalFailurePolicy(value: string): [CanonicalRuleDraft["onError"], CanonicalRuleDraft["failureDisposition"]] {
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("fail")) return ["fail_batch", "keep"];
  if (normalized.includes("quarantine")) return ["quarantine", "keep"];
  if (normalized.includes("drop")) return ["warn", "drop_row"];
  if (normalized.includes("null")) return ["warn", "set_null"];
  return ["warn", "keep"];
}

function legacyFailurePolicy(rule: CanonicalRuleDraft) {
  if (rule.failureDisposition === "drop_row") return "Drop Row";
  if (rule.failureDisposition === "set_null") return "Set Null";
  if (rule.onError === "fail_batch") return "Fail Run";
  if (rule.onError === "quarantine") return "Quarantine";
  return "Warn";
}

function legacyParameters(operation: string, rawValue: unknown, kind: CanonicalRuleDraft["kind"]): Record<string, unknown> {
  if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) return { ...(rawValue as Record<string, unknown>) };
  const raw = String(rawValue ?? "").trim();
  const parsed = parseObject(raw);
  if (parsed) return parsed;
  if (kind === "quality") {
    if (operation === "regex" && raw) return { pattern: raw };
    if (operation === "accepted_values" && raw) return { values: raw.split(",").map((item) => item.trim()).filter(Boolean) };
    if (operation === "range" && raw) {
      const [min, max] = raw.split(",").map((item) => item.trim());
      return { min, ...(max ? { max } : {}) };
    }
    return {};
  }
  if (operation === "json_extract") return { path: raw || "$.value" };
  if (operation === "cast") return { format: raw, targetType: canonicalSchemaType(raw || "Double") };
  if (operation === "parse_timestamp") return { format: raw || "UTC" };
  if (operation === "mask") return { policy: raw || "keep first 3 digits" };
  if (operation === "default_value") return { value: raw };
  if (operation === "sql_expression") return { expression: raw };
  if (raw && !["lowercase_trim", "null_guard", "rename", "copy"].includes(operation)) return { value: raw };
  return {};
}

function inferOutputType(operation: string, declaredType: unknown, parameters: Record<string, unknown>, inputType: string) {
  if (declaredType) return canonicalSchemaType(declaredType);
  if (operation === "cast") return canonicalSchemaType(parameters.targetType ?? parameters.format ?? "Double");
  if (operation === "parse_timestamp") return "Timestamp";
  if (["json_extract", "lowercase_trim", "mask", "custom_csv_classifier", "text_row_analysis"].includes(operation)) return "String";
  return canonicalSchemaType(inputType);
}

function legacyTransformOperation(operation: string, outputType?: string): [string, TransformStepDraft["kind"]] {
  if (operation === "cast") return [`Cast ${outputType ?? "Double"}`, "cast"];
  return ({
    copy: ["Copy", "derive"],
    custom_csv_classifier: ["Custom CSV Classifier", "derive"],
    default_value: ["Default Value", "derive"],
    json_extract: ["Extract JSONPath", "jsonPath"],
    lowercase_trim: ["Lowercase + Trim", "trim"],
    mask: ["Mask", "mask"],
    null_guard: ["Null Guard", "derive"],
    parse_timestamp: ["Parse Timestamp", "cast"],
    rename: ["Rename", "rename"],
    sql_expression: ["SQL Expression", "derive"],
    sql_result_materialize: ["SQL_RESULT_MATERIALIZE", "derive"],
    text_row_analysis: ["Text Row Analysis", "derive"],
  } as Record<string, [string, TransformStepDraft["kind"]]>)[operation] ?? [operation, "derive"];
}

function legacyQualityOperation(operation: string): [string, string] {
  return ({
    accepted_values: ["Accepted Values", "acceptedValues"],
    not_null: ["Not Null", "notNull"],
    range: ["Range Check", "range"],
    regex: ["Regex Match", "regex"],
    unique: ["Unique", "unique"],
  } as Record<string, [string, string]>)[operation] ?? [operation, operation];
}

function legacyParameterString(rule: CanonicalRuleDraft) {
  if (rule.kind === "quality") return Object.keys(rule.parameters).length ? JSON.stringify(rule.parameters) : "";
  if (rule.operation === "json_extract") return String(rule.parameters.path ?? "$.value");
  if (rule.operation === "cast") return String(rule.parameters.format ?? rule.parameters.targetType ?? rule.outputType ?? "Double");
  if (rule.operation === "parse_timestamp") return String(rule.parameters.format ?? "UTC");
  if (rule.operation === "mask") return String(rule.parameters.policy ?? "keep first 3 digits");
  if (rule.operation === "default_value") return String(rule.parameters.value ?? "");
  if (rule.operation === "sql_expression") return String(rule.parameters.expression ?? "");
  if (rule.operation === "lowercase_trim") return "lower(), trim()";
  return Object.keys(rule.parameters).length ? JSON.stringify(rule.parameters) : "";
}

function schemaTypeMap(schemaColumns: SchemaColumnDraft[], outputColumns: Array<[string, string]> = []) {
  const result = new Map<string, string>();
  schemaColumns.filter((column) => column.included !== false).forEach((column) => {
    const sourceType = canonicalSchemaType(column.sourceType ?? column.type);
    const targetType = canonicalSchemaType(column.type);
    if (column.targetName) result.set(column.targetName, targetType);
    if (column.sourceName) result.set(column.sourceName, sourceType);
  });
  outputColumns.forEach(([name, type]) => result.set(name, canonicalSchemaType(type)));
  return result;
}

function availableInputType(available: Map<string, string>, name: string) {
  if (!name) return undefined;
  if (available.has(name)) return available.get(name);
  const [root, ...path] = name.split(".");
  return path.length > 0 && available.get(root) === "JSON" ? "String" : undefined;
}

function validateRuleParameters(
  operation: string,
  parameters: Record<string, unknown>,
  ruleId: string,
  issues: RuleCompilationIssue[],
) {
  if (operation === "json_extract") {
    const path = String(parameters.path ?? "").trim();
    if (!path) issues.push(issue("RULE_PARAMETER_REQUIRED", "parameters.path", "JSON extract path is required.", ruleId));
    else if (!path.startsWith("$")) issues.push(issue("RULE_PARAMETER_INVALID", "parameters.path", "JSON extract path must start with '$'.", ruleId));
  }
  if (operation === "sql_expression" && !String(parameters.expression ?? "").trim()) {
    issues.push(issue("RULE_PARAMETER_REQUIRED", "parameters.expression", "SQL expression is required.", ruleId));
  }
  if (operation === "regex") {
    const pattern = String(parameters.pattern ?? "");
    if (!pattern) issues.push(issue("RULE_PARAMETER_REQUIRED", "parameters.pattern", "Regex pattern is required.", ruleId));
    else {
      try {
        new RegExp(pattern);
      } catch {
        issues.push(issue("RULE_PARAMETER_INVALID", "parameters.pattern", "Regex pattern is invalid.", ruleId));
      }
    }
  }
  if (operation === "accepted_values") {
    const values = Array.isArray(parameters.values)
      ? parameters.values.map((value) => String(value).trim()).filter(Boolean)
      : [];
    if (values.length === 0) issues.push(issue("RULE_PARAMETER_REQUIRED", "parameters.values", "Accepted values require at least one value.", ruleId));
  }
  if (operation === "range") {
    const hasMin = parameters.min !== undefined && parameters.min !== null && parameters.min !== "";
    const hasMax = parameters.max !== undefined && parameters.max !== null && parameters.max !== "";
    if (!hasMin && !hasMax) {
      issues.push(issue("RULE_PARAMETER_REQUIRED", "parameters", "Range requires min or max.", ruleId));
    } else {
      const min = hasMin ? Number(parameters.min) : Number.NEGATIVE_INFINITY;
      const max = hasMax ? Number(parameters.max) : Number.POSITIVE_INFINITY;
      if ((hasMin && !Number.isFinite(min)) || (hasMax && !Number.isFinite(max)) || min > max) {
        issues.push(issue("RULE_PARAMETER_INVALID", "parameters", "Range min/max must be finite numbers and min must not exceed max.", ruleId));
      }
    }
    if (parameters.inclusive !== undefined && typeof parameters.inclusive !== "boolean") {
      issues.push(issue("RULE_PARAMETER_INVALID", "parameters.inclusive", "Range inclusive must be boolean.", ruleId));
    }
  }
  if (operation === "mask") {
    const policy = String(parameters.policy ?? "").trim().toLowerCase();
    if (!policy) issues.push(issue("RULE_PARAMETER_REQUIRED", "parameters.policy", "Mask policy is required.", ruleId));
    else if (!["phone", "keep first 3 digits"].includes(policy)) issues.push(issue("RULE_PARAMETER_INVALID", "parameters.policy", "Mask policy must be phone.", ruleId));
  }
  if (operation === "parse_timestamp") {
    const format = String(parameters.format ?? "").trim().toUpperCase();
    if (!format) issues.push(issue("RULE_PARAMETER_REQUIRED", "parameters.format", "Timestamp format is required.", ruleId));
    else if (!["ISO-8601", "UTC"].includes(format)) issues.push(issue("RULE_PARAMETER_INVALID", "parameters.format", "Timestamp format must be ISO-8601.", ruleId));
  }
}

function canonicalSchemaType(value: unknown) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["json", "array", "struct", "map", "object"].some((token) => normalized.includes(token))) return "JSON";
  if (normalized.includes("bool")) return "Boolean";
  if (normalized.includes("timestamp") || normalized.includes("datetime")) return "Timestamp";
  if (normalized === "date") return "Date";
  if (["bigint", "int64", "long"].some((token) => normalized.includes(token))) return "Long";
  if (["smallint", "tinyint", "int32", "integer"].some((token) => normalized.includes(token)) || normalized === "int") return "Integer";
  if (["float", "double", "decimal", "numeric", "number", "real"].some((token) => normalized.includes(token))) return "Double";
  return "String";
}

function parseObject(value: string) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function uniqueNames(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function issue(code: string, field: string, message: string, ruleId?: string): RuleCompilationIssue {
  return { code, field, message, ruleId };
}
