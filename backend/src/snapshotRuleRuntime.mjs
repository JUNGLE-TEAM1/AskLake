const transformOperations = new Set([
  "cast",
  "copy",
  "default_value",
  "json_extract",
  "lowercase_trim",
  "mask",
  "null_guard",
  "parse_timestamp",
  "rename",
]);
const qualityOperations = new Set(["accepted_values", "not_null", "range", "regex"]);

export class SnapshotRuleExecutionError extends Error {
  constructor(stage, rule, reason, context = {}) {
    super(`${stage} rule ${rule?.id || "unknown"} failed: ${reason}`);
    this.name = "SnapshotRuleExecutionError";
    this.failedStage = stage;
    this.quality = context.quality;
    this.ruleId = String(rule?.id || "");
    this.transform = context.transform;
  }
}

export function supportsSnapshotRules(rules) {
  return list(rules)
    .filter((rule) => rule?.enabled !== false)
    .every((rule) => (
      rule?.kind === "transform"
        ? transformOperations.has(String(rule.operation || ""))
        : rule?.kind === "quality" && qualityOperations.has(String(rule.operation || ""))
    ));
}

export function applySnapshotRules(records, rules) {
  const canonicalRules = list(rules).filter((rule) => rule && typeof rule === "object");
  const transforms = canonicalRules.filter((rule) => rule.kind === "transform" && rule.enabled !== false);
  const qualityRules = canonicalRules.filter((rule) => rule.kind === "quality" && rule.enabled !== false);
  const transform = {
    appliedStepCount: 0,
    configuredStepCount: transforms.length,
    droppedCount: 0,
    errorCount: 0,
    quarantinedCount: 0,
    setNullCount: 0,
    warnCount: 0,
  };
  const quality = {
    blockingFailures: 0,
    configuredRuleCount: qualityRules.length,
    droppedCount: 0,
    invalidRowCount: 0,
    passRate: 100,
    quarantinedCount: 0,
    setNullCount: 0,
    status: "pass",
    summary: qualityRules.length > 0 ? "Quality rules passed" : "No quality rules",
    warnCount: 0,
  };
  const quarantined = [];
  let transformed = list(records).map((record) => structuredClone(record));

  for (const rule of transforms) {
    const output = String(rule.outputColumns?.[0] || rule.inputColumns?.[0] || "");
    if (!output) continue;
    const outcomes = transformed.map((record) => {
      try {
        return { record, value: applyTransformRule(record, rule) };
      } catch (error) {
        return { error, record };
      }
    });
    const failures = outcomes.filter((outcome) => outcome.error);
    transform.appliedStepCount += outcomes.length - failures.length;
    transform.errorCount += failures.length;
    const action = failureAction(rule);
    if (failures.length > 0 && action === "fail_batch") {
      const reason = failures[0].error?.code || failures[0].error?.message || String(failures[0].error);
      throw new SnapshotRuleExecutionError("transform", rule, reason, { quality, transform });
    }

    const next = [];
    for (const outcome of outcomes) {
      if (!outcome.error) {
        setRecordValue(outcome.record, output, outcome.value);
        next.push(outcome.record);
        continue;
      }
      const reason = outcome.error?.code || outcome.error?.message || String(outcome.error);
      if (action === "drop_row") {
        transform.droppedCount += 1;
        continue;
      }
      if (action === "quarantine") {
        quarantined.push(quarantineEntry(outcome.record, "transform", rule, reason));
        transform.quarantinedCount += 1;
        continue;
      }
      if (action === "set_null") {
        setRecordValue(outcome.record, output, null);
        transform.setNullCount += 1;
      } else {
        setRecordValue(outcome.record, output, getRecordValue(outcome.record, rule.inputColumns?.[0]));
        transform.warnCount += 1;
      }
      next.push(outcome.record);
    }
    transformed = next;
  }

  const evaluated = transformed.map((record) => ({
    failures: qualityRules.map((rule) => ({
      reason: qualityFailureReason(getRecordValue(record, rule.inputColumns?.[0]), rule),
      rule,
    })),
    record,
  }));
  const qualityInputCount = transformed.length;
  quality.evaluatedRowCount = qualityInputCount;
  quality.invalidRowCount = evaluated.filter(({ failures }) => failures.some(({ reason }) => reason)).length;
  quality.passRate = qualityInputCount
    ? Number((((qualityInputCount - quality.invalidRowCount) / qualityInputCount) * 100).toFixed(1))
    : 100;

  let blockingFailure;
  for (const rule of qualityRules) {
    if (failureAction(rule) !== "fail_batch") continue;
    const failed = evaluated.filter(({ failures }) => failures.some((item) => item.rule === rule && item.reason));
    quality.blockingFailures += failed.length;
    if (!blockingFailure && failed.length > 0) {
      blockingFailure = failed[0].failures.find((item) => item.rule === rule && item.reason);
    }
  }
  if (blockingFailure) {
    quality.status = "fail";
    quality.summary = `Quality score ${quality.passRate}% - invalid rows ${quality.invalidRowCount} - blocking ${quality.blockingFailures}`;
    throw new SnapshotRuleExecutionError("quality", blockingFailure.rule, blockingFailure.reason, { quality, transform });
  }

  const output = [];
  for (const { failures, record } of evaluated) {
    const activeFailures = failures.filter((item) => item.reason);
    if (activeFailures.length === 0) {
      output.push(record);
      continue;
    }

    let discarded = false;
    for (const { reason, rule } of activeFailures) {
      const action = failureAction(rule);
      if (action === "drop_row") {
        quality.droppedCount += 1;
        discarded = true;
        break;
      }
      if (action === "quarantine") {
        quarantined.push(quarantineEntry(record, "quality", rule, reason));
        quality.quarantinedCount += 1;
        discarded = true;
        break;
      }
      if (action === "set_null") {
        setRecordValue(record, rule.inputColumns?.[0], null);
        quality.setNullCount += 1;
      } else {
        quality.warnCount += 1;
      }
    }
    if (!discarded) output.push(record);
  }

  quality.status = quality.invalidRowCount > 0 ? "warn" : "pass";
  quality.summary = qualityRules.length > 0
    ? `Quality score ${quality.passRate}% - invalid rows ${quality.invalidRowCount} - dropped ${quality.droppedCount} - quarantined ${quality.quarantinedCount}`
    : "No quality rules";

  return { quality, quarantined, records: output, transform };
}

function applyTransformRule(record, rule) {
  const input = getRecordValue(record, rule.inputColumns?.[0]);
  const operation = String(rule.operation || "");
  const parameters = object(rule.parameters);
  const outputType = rule.outputType;

  if (operation === "null_guard") {
    if (isMissing(input)) throw ruleError("missing_required_value");
    return castValue(input, outputType);
  }
  if (operation === "default_value") {
    return castValue(isMissing(input) ? parameters.value : input, outputType);
  }
  if (operation === "lowercase_trim") {
    return input === null || input === undefined ? null : String(input).trim().toLowerCase();
  }
  if (operation === "json_extract") {
    const value = readJsonPath(input, parameters.path);
    if (value === undefined) throw ruleError("json_path_not_found");
    return castValue(value, outputType || "String");
  }
  if (operation === "mask") {
    return input === null || input === undefined ? null : maskPhoneNumber(String(input));
  }
  if (operation === "parse_timestamp") {
    return castValue(input, "Timestamp");
  }
  if (operation === "cast" || operation === "copy" || operation === "rename") {
    return castValue(input, outputType || parameters.targetType);
  }
  throw ruleError("unsupported_transform_operation");
}

function castValue(value, targetType) {
  if (isMissing(value)) return null;
  const type = String(targetType || "").trim().toLowerCase();
  if (!type) return value;
  if (type.includes("bool")) {
    const normalized = String(value).trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(normalized)) return true;
    if (["false", "0", "no", "n"].includes(normalized)) return false;
    throw ruleError("boolean_cast_failed");
  }
  if (["integer", "int", "long", "bigint"].some((token) => type.includes(token))) {
    const normalized = String(value).trim();
    if (!/^[+-]?\d+$/.test(normalized)) throw ruleError("integer_cast_failed");
    const numeric = Number(normalized);
    if (!Number.isSafeInteger(numeric)) throw ruleError("integer_cast_failed");
    return numeric;
  }
  if (["float", "double", "decimal", "number", "numeric", "real"].some((token) => type.includes(token))) {
    const numeric = Number(String(value).trim());
    if (!Number.isFinite(numeric)) throw ruleError("numeric_cast_failed");
    return numeric;
  }
  if (type.includes("timestamp") || type.includes("datetime")) {
    const timestamp = new Date(String(value).trim());
    if (Number.isNaN(timestamp.getTime())) throw ruleError("timestamp_cast_failed");
    return timestamp.toISOString().replace(".000Z", "Z");
  }
  if (type === "date") {
    const timestamp = new Date(String(value).trim());
    if (Number.isNaN(timestamp.getTime())) throw ruleError("date_cast_failed");
    return timestamp.toISOString().slice(0, 10);
  }
  if (["json", "array", "struct", "map", "object"].some((token) => type.includes(token))) {
    if (value && typeof value === "object") return structuredClone(value);
    try {
      return JSON.parse(String(value));
    } catch {
      throw ruleError("json_cast_failed");
    }
  }
  return value && typeof value === "object" ? JSON.stringify(value) : String(value);
}

function qualityFailureReason(value, rule) {
  const operation = String(rule.operation || "");
  const parameters = object(rule.parameters);
  if (operation === "not_null") return isMissing(value) ? "missing_required_value" : "";
  if (operation === "range") {
    if (isMissing(value)) return "numeric_range_check_failed";
    const numeric = Number(String(value).trim());
    const minimum = parameters.min === undefined || parameters.min === null || parameters.min === ""
      ? Number.NEGATIVE_INFINITY
      : Number(parameters.min);
    const maximum = parameters.max === undefined || parameters.max === null || parameters.max === ""
      ? Number.POSITIVE_INFINITY
      : Number(parameters.max);
    const inclusive = parameters.inclusive !== false;
    const valid = Number.isFinite(numeric)
      && !Number.isNaN(minimum)
      && !Number.isNaN(maximum)
      && (inclusive ? numeric >= minimum && numeric <= maximum : numeric > minimum && numeric < maximum);
    return valid ? "" : "numeric_range_check_failed";
  }
  if (operation === "regex") {
    try {
      return new RegExp(String(parameters.pattern || "")).test(String(value ?? "")) ? "" : "regex_match_failed";
    } catch {
      return "invalid_regex_pattern";
    }
  }
  if (operation === "accepted_values") {
    const values = Array.isArray(parameters.values) ? parameters.values.map(String) : [];
    return values.includes(String(value ?? "")) ? "" : "value_not_accepted";
  }
  return "unsupported_quality_operation";
}

function failureAction(rule) {
  if (rule.onError === "fail_batch") return "fail_batch";
  if (rule.onError === "quarantine") return "quarantine";
  if (rule.failureDisposition === "drop_row") return "drop_row";
  if (rule.failureDisposition === "set_null") return "set_null";
  return "keep";
}

function quarantineEntry(record, stage, rule, reason) {
  return {
    event_id: String(getRecordValue(record, "event_id") ?? ""),
    reason,
    record: structuredClone(record),
    ruleId: String(rule.id || ""),
    stage,
    targetColumn: String(rule.inputColumns?.[0] || rule.outputColumns?.[0] || ""),
  };
}

function getRecordValue(record, field) {
  const pathParts = String(field || "").split(".").filter(Boolean);
  if (pathParts.length === 0) return undefined;
  if (Object.hasOwn(record, field)) return record[field];
  let value = record;
  for (const part of pathParts) {
    if (!value || typeof value !== "object") return undefined;
    value = value[part];
  }
  if (value !== undefined) return value;
  if (record.raw && typeof record.raw === "object") {
    const rawField = String(field).replace(/^raw[_.]/, "");
    return record.raw[rawField] ?? record.raw[field];
  }
  return undefined;
}

function setRecordValue(record, field, value) {
  const parts = String(field || "").split(".").filter(Boolean);
  if (parts.length === 0) return;
  if (parts.length === 1) {
    record[parts[0]] = value;
    return;
  }
  let target = record;
  for (const part of parts.slice(0, -1)) {
    if (!target[part] || typeof target[part] !== "object") target[part] = {};
    target = target[part];
  }
  target[parts.at(-1)] = value;
}

function readJsonPath(input, expression) {
  if (input === null || input === undefined) throw ruleError("json_input_missing");
  const source = typeof input === "string" ? JSON.parse(input) : input;
  const pathParts = String(expression || "$").replace(/^\$\.?/, "").split(".").filter(Boolean);
  return pathParts.reduce((value, part) => value?.[part], source);
}

function maskPhoneNumber(value) {
  return value.replace(/(\d{3})-?\d{4}-?(\d{4})/, "$1-****-$2");
}

function isMissing(value) {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function ruleError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

function list(value) {
  return Array.isArray(value) ? value : [];
}
