export function buildKafkaTargetSchema({ outputSchema = [], records = [], rules = [], schemaColumns = [] } = {}) {
  const configured = list(schemaColumns)
    .filter((column) => column?.included !== false)
    .map((column) => ({
      nullable: column.nullable !== false,
      sourceName: text(column.sourceName || column.targetName),
      targetName: text(column.targetName || column.sourceName),
      type: text(column.type || column.sourceType || "String"),
    }))
    .filter((column) => column.targetName);
  const normalizedOutputSchema = list(outputSchema).filter((item) => Array.isArray(item) && item.length >= 2);
  const hasConfiguredContract = configured.length > 0 || normalizedOutputSchema.length > 0;
  const configuredByTarget = new Map(configured.map((column) => [column.targetName, column]));
  const result = normalizedOutputSchema.length > 0
    ? normalizedOutputSchema
      .map(([name, type]) => {
        const targetName = text(name);
        const configuredColumn = configuredByTarget.get(targetName);
        return {
          nullable: configuredColumn?.nullable !== false,
          sourceName: configuredColumn?.sourceName || targetName,
          targetName,
          type: text(type || configuredColumn?.type || "String"),
        };
      })
      .filter((column) => column.targetName)
    : configured.length > 0
      ? configured
      : standardKafkaReviewSchema();
  const known = new Set(result.map((column) => column.targetName));

  if (!hasConfiguredContract) {
    for (const rule of list(rules)) {
      const output = rule?.kind === "transform" && rule?.enabled !== false ? text(rule.outputColumns?.[0]) : "";
      if (output && !known.has(output)) {
        result.push({ nullable: true, sourceName: output, targetName: output, type: text(rule.outputType || "String") });
        known.add(output);
      }
    }
  }
  if (hasConfiguredContract) return result;
  for (const record of list(records)) {
    for (const [name, value] of Object.entries(record || {})) {
      if (known.has(name)) continue;
      result.push({ nullable: value === null || value === undefined, sourceName: name, targetName: name, type: inferRecordType(value) });
      known.add(name);
    }
  }
  return result;
}

export function projectKafkaTargetRecord(record, schemaColumns) {
  const projected = {};
  for (const column of list(schemaColumns)) {
    const targetName = text(column.targetName);
    if (!targetName) continue;
    const targetValue = getRecordValue(record, targetName);
    const value = targetValue !== undefined ? targetValue : getRecordValue(record, column.sourceName);
    setRecordValue(projected, targetName, value === undefined ? null : value);
  }
  return projected;
}

export function standardKafkaReviewSchema() {
  return [
    { nullable: false, sourceName: "schema_version", targetName: "schema_version", type: "String" },
    { nullable: false, role: "Identifier", sourceName: "event_id", targetName: "event_id", type: "String" },
    { nullable: false, sourceName: "source", targetName: "source", type: "String" },
    { nullable: false, sourceName: "offset", targetName: "offset", type: "Long" },
    { nullable: false, sourceName: "review", targetName: "review", type: "String" },
    { nullable: false, role: "Event Time", sourceName: "created_at", targetName: "created_at", type: "Timestamp" },
    { nullable: false, sourceName: "raw", targetName: "raw", type: "JSON" },
  ];
}

export function getKafkaRecordValue(record, field) {
  return getRecordValue(record, field);
}

function inferRecordType(value) {
  if (typeof value === "boolean") return "Boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "Long" : "Double";
  if (value && typeof value === "object") return "JSON";
  return "String";
}

function getRecordValue(record, field) {
  const pathParts = text(field).split(".").filter(Boolean);
  if (pathParts.length === 0) return undefined;
  if (Object.hasOwn(record || {}, field)) return record[field];
  let value = record;
  for (const part of pathParts) {
    if (!value || typeof value !== "object") return undefined;
    value = value[part];
  }
  if (value !== undefined) return value;
  if (record?.raw && typeof record.raw === "object") {
    const rawField = text(field).replace(/^raw[_.]/, "");
    return record.raw[rawField] ?? record.raw[field];
  }
  return undefined;
}

function setRecordValue(record, field, value) {
  const parts = text(field).split(".").filter(Boolean);
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

function text(value) {
  return String(value ?? "").trim();
}

function list(value) {
  return Array.isArray(value) ? value : [];
}
