export const RULE_CONTRACT_VERSION = "1.0";

const transformOperations = new Set([
  "cast", "copy", "custom_csv_classifier", "default_value", "json_extract", "lowercase_trim", "mask",
  "null_guard", "parse_timestamp", "rename", "sql_expression", "sql_result_materialize", "text_row_analysis",
]);
const qualityOperations = new Set(["accepted_values", "not_null", "range", "regex"]);
const kafkaSnapshotTransforms = new Set([
  "cast", "copy", "default_value", "json_extract", "lowercase_trim", "mask", "null_guard", "parse_timestamp", "rename",
]);
const validRuleKinds = new Set(["transform", "quality"]);
const validErrorPolicies = new Set(["fail_batch", "quarantine", "warn"]);
const validFailureDispositions = new Set(["keep", "drop_row", "set_null"]);
const validSeverities = new Set(["warning", "error"]);
const parameterKeys = new Map([
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

export function compileRuleContract(request = {}) {
  const schemaColumns = array(request.schemaColumns);
  const declaredOutputs = normalizeOutputColumns(request.transformOutputColumns);
  const canonicalSupplied = Object.hasOwn(request, "ruleContractVersion") || array(request.rules).length > 0;
  const canonical = canonicalSupplied
    ? array(request.rules)
    : canonicalRulesFromLegacy(request.transformSteps, request.qualityRules, schemaColumns, declaredOutputs);
  const available = schemaTypeMap(schemaColumns);
  const outputTypes = new Map();
  for (const column of schemaColumns.filter((item) => item?.included !== false)) {
    const name = text(column?.targetName || column?.sourceName);
    if (name) outputTypes.set(name, canonicalSchemaType(column?.type));
  }
  const declaredTypes = new Map(declaredOutputs.map(([name, type]) => [name, canonicalSchemaType(type)]));
  const issues = [];
  if (canonicalSupplied && request.ruleContractVersion !== RULE_CONTRACT_VERSION) {
    issues.push(issue(
      request.ruleContractVersion === undefined ? "RULE_CONTRACT_VERSION_REQUIRED" : "RULE_CONTRACT_VERSION_UNSUPPORTED",
      "ruleContractVersion",
      request.ruleContractVersion === undefined
        ? "Canonical rules require ruleContractVersion 1.0."
        : `Unsupported rule contract version: ${text(request.ruleContractVersion)}`,
    ));
  }
  const seenIds = new Set();
  const executionMode = text(request.executionMode || "snapshot");
  const kafkaSnapshot = executionMode === "snapshot" && text(request.sourceType).toLowerCase().includes("kafka");

  const rules = canonical.map((rawRule, index) => {
    const rule = rawRule && typeof rawRule === "object" ? rawRule : {};
    const kind = text(rule.kind);
    const id = text(rule.id) || `rule-${index + 1}`;
    const operation = normalizeOperation(rule.operation, kind);
    const inputColumns = uniqueNames(rule.inputColumns);
    const outputColumns = uniqueNames(rule.outputColumns);
    const parameters = object(rule.parameters);
    const enabled = rule.enabled !== false;
    const onError = text(rule.onError);
    const failureDisposition = text(rule.failureDisposition);
    const severity = text(rule.severity || (kind === "quality" ? "warning" : ""));

    if (seenIds.has(id)) issues.push(issue("RULE_ID_DUPLICATE", "id", `Duplicate rule id: ${id}`, id));
    seenIds.add(id);
    if (text(rule.contractVersion) !== RULE_CONTRACT_VERSION) {
      issues.push(issue("RULE_CONTRACT_VERSION_UNSUPPORTED", "contractVersion", `Unsupported rule contract version: ${text(rule.contractVersion)}`, id));
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
    const supportedOperations = kind === "transform" ? transformOperations : kind === "quality" ? qualityOperations : new Set();
    if (!supportedOperations.has(operation)) {
      issues.push(issue("RULE_OPERATION_UNSUPPORTED", "operation", `Unsupported ${kind || "unknown"} operation: ${text(rule.operation)}`, id));
    }
    const allowedParameterKeys = parameterKeys.get(`${kind}:${operation}`);
    if (allowedParameterKeys !== undefined && allowedParameterKeys !== null) {
      const unsupportedKeys = Object.keys(parameters).filter((key) => !allowedParameterKeys.has(key)).sort();
      if (unsupportedKeys.length > 0) {
        issues.push(issue("RULE_PARAMETER_UNSUPPORTED", "parameters", `Unsupported parameters for ${operation}: ${unsupportedKeys.join(", ")}`, id));
      }
    }

    if (enabled) {
      if (executionMode === "continuous") {
        issues.push(issue(
          "RULE_EXECUTION_MODE_UNSUPPORTED",
          "operation",
          `Continuous does not support enabled rule '${id}' until the streaming compiler phase.`,
          id,
        ));
      } else if (kafkaSnapshot && kind === "transform" && !kafkaSnapshotTransforms.has(operation)) {
        issues.push(issue(
          "RULE_EXECUTION_MODE_UNSUPPORTED",
          "operation",
          `Kafka Snapshot does not support transform operation: ${operation}`,
          id,
        ));
      }
      if (inputColumns.length !== 1) {
        issues.push(issue("RULE_INPUT_ARITY", "inputColumns", "Current rule contract requires exactly one input column.", id));
      }
      for (const name of inputColumns) {
        if (!available.has(name)) issues.push(issue("RULE_INPUT_NOT_FOUND", "inputColumns", `Rule input column does not exist: ${name}`, id));
      }
      if (kind === "transform" && outputColumns.length !== 1) {
        issues.push(issue("RULE_OUTPUT_ARITY", "outputColumns", "Transform rules require exactly one output column.", id));
      }
      if (kind === "quality" && outputColumns.length > 0) {
        issues.push(issue("RULE_OUTPUT_NOT_ALLOWED", "outputColumns", "Quality rules do not create output columns.", id));
      }
      if (operation === "json_extract" && !text(parameters.path).startsWith("$")) {
        issues.push(issue("RULE_PARAMETER_INVALID", "parameters.path", "JSON extract path must start with '$'.", id));
      }
      if (operation === "sql_expression" && !text(parameters.expression)) {
        issues.push(issue("RULE_PARAMETER_REQUIRED", "parameters.expression", "SQL expression is required.", id));
      }
    }

    const inputType = available.get(inputColumns[0]) || "String";
    const outputType = kind === "transform"
      ? inferOutputType(operation, rule.outputType || declaredTypes.get(outputColumns[0]), parameters, inputType)
      : undefined;
    const normalized = {
      contractVersion: RULE_CONTRACT_VERSION,
      enabled,
      failureDisposition,
      id,
      inputColumns,
      kind,
      ...(text(rule.label) ? { label: text(rule.label) } : {}),
      onError,
      operation,
      outputColumns,
      ...(outputType ? { outputType } : {}),
      parameters,
      ...(severity ? { severity } : {}),
    };
    if (enabled && kind === "transform" && outputColumns.length === 1) {
      available.set(outputColumns[0], outputType || "String");
      outputTypes.set(outputColumns[0], outputType || "String");
    }
    return normalized;
  });

  const legacy = legacyRulesFromCanonical(rules);
  return {
    qualityRules: legacy.qualityRules,
    result: {
      contractVersion: RULE_CONTRACT_VERSION,
      issues,
      outputSchema: [...outputTypes.entries()],
      rules,
      status: issues.length > 0 ? "fail" : "pass",
    },
    transformSteps: legacy.transformSteps,
  };
}

export function canonicalRulesFromLegacy(transformSteps, qualityRules, schemaColumns, transformOutputColumns = []) {
  const typeByName = schemaTypeMap(array(schemaColumns), normalizeOutputColumns(transformOutputColumns));
  const transforms = array(transformSteps).map((step, index) => {
    const operation = normalizeOperation(step?.operation || step?.kind, "transform");
    const parameters = isObject(step?.canonicalParameters)
      ? object(step.canonicalParameters)
      : legacyParameters(operation, step?.params, "transform");
    const [onError, failureDisposition] = canonicalFailurePolicy(step?.onError);
    const input = text(step?.input);
    const output = text(step?.output || input);
    return {
      contractVersion: RULE_CONTRACT_VERSION,
      enabled: step?.enabled !== false,
      failureDisposition,
      id: text(step?.id) || `transform-${index + 1}`,
      inputColumns: input ? [input] : [],
      kind: "transform",
      ...(text(step?.label) ? { label: text(step.label) } : {}),
      onError,
      operation,
      outputColumns: output ? [output] : [],
      outputType: inferOutputType(operation, typeByName.get(output), parameters, typeByName.get(input) || "String"),
      parameters,
    };
  });
  const quality = array(qualityRules).map((rule, index) => {
    const operation = normalizeOperation(rule?.validationType || rule?.kind, "quality");
    const [onError, failureDisposition] = canonicalFailurePolicy(rule?.failureAction);
    const target = text(rule?.targetColumn);
    return {
      contractVersion: RULE_CONTRACT_VERSION,
      enabled: rule?.enabled !== false,
      failureDisposition,
      id: text(rule?.id) || `quality-${index + 1}`,
      inputColumns: target ? [target] : [],
      kind: "quality",
      onError,
      operation,
      outputColumns: [],
      parameters: isObject(rule?.canonicalParameters)
        ? object(rule.canonicalParameters)
        : legacyParameters(operation, rule?.params, "quality"),
      severity: rule?.severity === "Error" ? "error" : "warning",
    };
  });
  return [...transforms, ...quality];
}

export function legacyRulesFromCanonical(rules) {
  const transformSteps = array(rules).filter((rule) => rule?.kind === "transform").map((rule) => {
    const input = text(rule.inputColumns?.[0]);
    const output = text(rule.outputColumns?.[0] || input);
    const [operation, kind] = legacyTransformOperation(rule.operation, rule.outputType);
    return {
      canonicalParameters: object(rule.parameters),
      enabled: rule.enabled !== false,
      id: text(rule.id),
      input,
      kind,
      label: text(rule.label) || `${operation}: ${input} -> ${output}`,
      onError: legacyFailurePolicy(rule),
      operation,
      output,
      params: legacyParameterString(rule),
    };
  });
  const qualityRules = array(rules).filter((rule) => rule?.kind === "quality").map((rule) => {
    const [validationType, kind] = legacyQualityOperation(rule.operation);
    return {
      canonicalParameters: object(rule.parameters),
      enabled: rule.enabled !== false,
      failureAction: legacyFailurePolicy(rule),
      id: text(rule.id),
      kind,
      params: legacyParameterString(rule),
      severity: rule.severity === "error" ? "Error" : "Warning",
      targetColumn: text(rule.inputColumns?.[0]),
      validationType,
    };
  });
  return { qualityRules, transformSteps };
}

function normalizeOperation(value, kind) {
  const normalized = text(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
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

function canonicalFailurePolicy(value) {
  const normalized = text(value || "Warn").toLowerCase();
  if (normalized.includes("fail")) return ["fail_batch", "keep"];
  if (normalized.includes("quarantine")) return ["quarantine", "keep"];
  if (normalized.includes("drop")) return ["warn", "drop_row"];
  if (normalized.includes("null")) return ["warn", "set_null"];
  return ["warn", "keep"];
}

function legacyFailurePolicy(rule) {
  if (rule.failureDisposition === "drop_row") return "Drop Row";
  if (rule.failureDisposition === "set_null") return "Set Null";
  if (rule.onError === "fail_batch") return "Fail Run";
  if (rule.onError === "quarantine") return "Quarantine";
  return "Warn";
}

function legacyParameters(operation, rawValue, kind) {
  if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) return { ...rawValue };
  const raw = text(rawValue);
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

function inferOutputType(operation, declaredType, parameters, inputType) {
  if (declaredType) return canonicalSchemaType(declaredType);
  if (operation === "cast") return canonicalSchemaType(parameters.targetType || parameters.format || "Double");
  if (operation === "parse_timestamp") return "Timestamp";
  if (["json_extract", "lowercase_trim", "mask", "custom_csv_classifier", "text_row_analysis"].includes(operation)) return "String";
  return canonicalSchemaType(inputType);
}

function legacyTransformOperation(operation, outputType) {
  if (operation === "cast") return [`Cast ${outputType || "Double"}`, "cast"];
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
  })[operation] || [operation, "derive"];
}

function legacyQualityOperation(operation) {
  return ({
    accepted_values: ["Accepted Values", "acceptedValues"],
    not_null: ["Not Null", "notNull"],
    range: ["Range Check", "range"],
    regex: ["Regex Match", "regex"],
    unique: ["Unique", "unique"],
  })[operation] || [operation, operation];
}

function legacyParameterString(rule) {
  const parameters = object(rule.parameters);
  if (rule.kind === "quality") return Object.keys(parameters).length ? JSON.stringify(parameters) : "";
  if (rule.operation === "json_extract") return text(parameters.path || "$.value");
  if (rule.operation === "cast") return text(parameters.format || parameters.targetType || rule.outputType || "Double");
  if (rule.operation === "parse_timestamp") return text(parameters.format || "UTC");
  if (rule.operation === "mask") return text(parameters.policy || "keep first 3 digits");
  if (rule.operation === "default_value") return String(parameters.value ?? "");
  if (rule.operation === "sql_expression") return text(parameters.expression);
  if (rule.operation === "lowercase_trim") return "lower(), trim()";
  return Object.keys(parameters).length ? JSON.stringify(parameters) : "";
}

function schemaTypeMap(schemaColumns, outputColumns = []) {
  const result = new Map();
  for (const column of schemaColumns.filter((item) => item?.included !== false)) {
    const type = canonicalSchemaType(column?.type);
    if (text(column?.sourceName)) result.set(text(column.sourceName), type);
    if (text(column?.targetName)) result.set(text(column.targetName), type);
  }
  for (const [name, type] of outputColumns) result.set(name, canonicalSchemaType(type));
  return result;
}

function canonicalSchemaType(value) {
  const normalized = text(value).toLowerCase();
  if (["json", "array", "struct", "map", "object"].some((token) => normalized.includes(token))) return "JSON";
  if (normalized.includes("bool")) return "Boolean";
  if (normalized.includes("timestamp") || normalized.includes("datetime")) return "Timestamp";
  if (normalized === "date") return "Date";
  if (["bigint", "int64", "long"].some((token) => normalized.includes(token))) return "Long";
  if (["smallint", "tinyint", "int32", "integer"].some((token) => normalized.includes(token)) || normalized === "int") return "Integer";
  if (["float", "double", "decimal", "numeric", "number", "real"].some((token) => normalized.includes(token))) return "Double";
  return "String";
}

function normalizeOutputColumns(columns) {
  return array(columns)
    .filter((column) => Array.isArray(column) && text(column[0]))
    .map(([name, type]) => [text(name), canonicalSchemaType(type)]);
}

function parseObject(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function uniqueNames(values) {
  return [...new Set(array(values).map(text).filter(Boolean))];
}

function issue(code, field, message, ruleId) {
  return { code, field, message, ruleId };
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value) {
  return String(value ?? "").trim();
}
