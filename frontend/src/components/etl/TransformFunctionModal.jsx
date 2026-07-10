import React, { useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

const SQL_EXPRESSION = "SQL Expression";
const LEGACY_CSV_CLASSIFIER = "Custom CSV Classifier";
const REVIEW_ROW_ANALYSIS = "Review Row Analysis";
const TEXT_ROW_ANALYSIS = "Text Row Analysis";
const FIELD_ONLY_OPERATIONS = new Set(["Default Value", "Null Guard"]);

const OUTPUT_TYPE_OPTIONS = ["string", "integer", "long", "double", "boolean", "timestamp", "date"];

const REVIEW_ANALYSIS_METHOD_OPTIONS = [
  { value: "copy", label: "Copy", kind: "copy" },
  { value: "one_of_values", label: "One of values", kind: "classify" },
  { value: "instruction", label: "Instruction", kind: "instruction" },
];

const LEGACY_METHOD_ALIASES = {
  copy_or_extract_field: "copy",
  custom_instruction: "instruction",
  copy: "copy",
  instruction: "instruction",
  issue_taxonomy: "one_of_values",
  issue_category: "one_of_values",
  issue_subcategory: "one_of_values",
  severity_4level: "one_of_values",
  text_classification: "one_of_values",
  sentiment: "one_of_values",
  sentiment_3way: "one_of_values",
  issue_present: "one_of_values",
  issue_present_binary: "one_of_values",
  action_needed: "one_of_values",
  action_needed_binary: "one_of_values",
  boolean_y_n: "one_of_values",
  summary: "instruction",
  evidence: "instruction",
  extractive_summary: "instruction",
  evidence_span: "instruction",
};

const METHOD_OPTION_BY_VALUE = Object.fromEntries(REVIEW_ANALYSIS_METHOD_OPTIONS.map((option) => [option.value, option]));
const LEGACY_METHOD_DEFAULT_VALUES = {
  issue_category: ["charging_power", "screen_display", "shipping_delivery", "listing_accuracy", "durability_quality", "no_issue", "other_issue"],
  issue_subcategory: ["charging_or_power", "screen_or_display", "shipping_or_package", "listing_mismatch", "durability_or_quality", "positive_feedback", "other"],
  severity_4level: ["critical", "high", "medium", "low"],
  sentiment: ["positive", "mixed", "negative"],
  sentiment_3way: ["positive", "mixed", "negative"],
  issue_present: ["issue", "no_issue"],
  issue_present_binary: ["issue", "no_issue"],
  action_needed: ["action_needed", "low_or_none"],
  action_needed_binary: ["action_needed", "low_or_none"],
  boolean_y_n: ["Y", "N"],
};

const LEGACY_METHOD_DEFAULT_INSTRUCTIONS = {
  evidence: "Extract the source sentence that best supports this output.",
  evidence_span: "Extract the source sentence that best supports this output.",
  extractive_summary: "Summarize the row in one short factual sentence.",
  summary: "Summarize the row in one short factual sentence.",
};

function formatChainStep(step) {
  if (!step) return "";
  if (step.display) return step.display;
  if (step.operation === SQL_EXPRESSION) return step.params || step.expression || SQL_EXPRESSION;
  return `${step.operation}${step.params ? `: ${step.params}` : ""}`;
}

function normalizeChainStep(step, fallbackType) {
  const operation = step?.operation || SQL_EXPRESSION;
  const params = step?.params ?? step?.expression ?? "";
  return {
    display: step?.display || (operation === SQL_EXPRESSION ? params : `${operation}${params ? `: ${params}` : ""}`),
    expression: step?.expression || (operation === SQL_EXPRESSION ? params : ""),
    onError: step?.onError || "Warn",
    operation,
    params,
    type: step?.type || fallbackType,
  };
}

function initialChainFromColumn(column, sourceField) {
  if (Array.isArray(column.transformChain) && column.transformChain.length > 0) {
    return column.transformChain
      .map((step) => normalizeChainStep(step, column.type))
      .filter((step) => !FIELD_ONLY_OPERATIONS.has(step.operation));
  }

  const chain = [];
  if (column.transform || column.transformOperation) {
    const operation = column.transformOperation || SQL_EXPRESSION;
    const params = column.transformParams || column.transform || sourceField;
    chain.push(normalizeChainStep({
      display: column.transformDisplay,
      expression: column.transform || params,
      onError: column.onError,
      operation,
      params,
      type: column.type,
    }, column.type));
  }

  return chain;
}

function dataTransformStep(chain) {
  return chain.find((step) => !FIELD_ONLY_OPERATIONS.has(step.operation)) || null;
}

function lastDataTransformStep(chain) {
  return [...chain].reverse().find((step) => !FIELD_ONLY_OPERATIONS.has(step.operation)) || null;
}

function normalizeReviewAnalysisMethod(value, fallback = "copy") {
  const raw = String(value || "").split(":")[0].trim();
  const normalized = LEGACY_METHOD_ALIASES[raw] || raw;
  return REVIEW_ANALYSIS_METHOD_OPTIONS.some((option) => option.value === normalized)
    ? normalized
    : fallback;
}

function defaultAllowedValues(method) {
  const raw = String(method || "").split(":")[0].trim();
  return LEGACY_METHOD_DEFAULT_VALUES[raw] || METHOD_OPTION_BY_VALUE[normalizeReviewAnalysisMethod(method)]?.values || [];
}

function defaultInstruction(method, targetName) {
  const raw = String(method || "").split(":")[0].trim();
  if (LEGACY_METHOD_DEFAULT_INSTRUCTIONS[raw]) return LEGACY_METHOD_DEFAULT_INSTRUCTIONS[raw];
  const normalizedMethod = normalizeReviewAnalysisMethod(method);
  const normalizedTarget = normalizeCsvColumnName(targetName || "").toLowerCase();
  if (normalizedMethod !== "instruction") return "";
  if (normalizedTarget.includes("summary")) return LEGACY_METHOD_DEFAULT_INSTRUCTIONS.summary;
  if (normalizedTarget.includes("evidence") || normalizedTarget.includes("reason")) return LEGACY_METHOD_DEFAULT_INSTRUCTIONS.evidence;
  return "Use the whole source row and produce this output column according to its name.";
}

function isRowAnalysisOperation(operation) {
  return operation === REVIEW_ROW_ANALYSIS || operation === TEXT_ROW_ANALYSIS;
}

function parseAllowedValues(value) {
  return String(value || "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function serializeAllowedValues(values) {
  return (Array.isArray(values) ? values : []).join("\n");
}

function parseReviewAnalysisStep(step, sourceField, outputName, outputType) {
  if (!isRowAnalysisOperation(step?.operation) || !step?.params) {
    const method = "copy";
    return {
      allowedValues: defaultAllowedValues(method),
      method,
      sourceField,
      targetName: outputName,
      type: outputType || "string",
    };
  }
  try {
    const parsed = JSON.parse(step.params);
    const firstColumn = Array.isArray(parsed.columns) ? parsed.columns[0] : parsed;
    const rawMethod = firstColumn?.method || parsed.method;
    const method = normalizeReviewAnalysisMethod(rawMethod, "copy");
    return {
      allowedValues: Array.isArray(firstColumn?.allowedValues) ? firstColumn.allowedValues : defaultAllowedValues(rawMethod || method),
      instruction: String(firstColumn?.instruction || parsed.instruction || defaultInstruction(rawMethod || method, outputName)),
      method,
      sourceField: String(parsed.sourceField || sourceField),
      targetName: String(firstColumn?.targetName || parsed.targetName || outputName),
      type: String(firstColumn?.type || parsed.type || outputType || "string"),
    };
  } catch {
    const method = "copy";
    return {
      allowedValues: defaultAllowedValues(method),
      method,
      sourceField,
      targetName: outputName,
      type: outputType || "string",
    };
  }
}

function newReviewRuleId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createReviewRule({ allowedValues, instruction, method, targetName, type } = {}) {
  const normalizedMethod = normalizeReviewAnalysisMethod(method, "copy");
  const normalizedAllowedValues = Array.isArray(allowedValues) && allowedValues.length > 0
    ? allowedValues
    : defaultAllowedValues(method || normalizedMethod);
  return {
    allowedValues: normalizedAllowedValues,
    allowedValuesInput: serializeAllowedValues(normalizedAllowedValues),
    id: newReviewRuleId(),
    instruction: String(instruction || defaultInstruction(method || normalizedMethod, targetName)).trim(),
    method: normalizedMethod,
    targetName: normalizeCsvColumnName(targetName || "output_value") || "output_value",
    type: type || "string",
  };
}

function parseReviewAnalysisRules(step, sourceField, outputName, outputType) {
  if (isRowAnalysisOperation(step?.operation) && step?.params) {
    try {
      const parsed = JSON.parse(step.params);
      const columns = Array.isArray(parsed.columns) ? parsed.columns : [parsed];
      const rules = columns
        .map((column, index) => createReviewRule({
          allowedValues: Array.isArray(column?.allowedValues) ? column.allowedValues : [],
          instruction: column?.instruction || column?.description || "",
          method: column?.method || column?.analysisMethod || parsed.method,
          targetName: column?.targetName || column?.value || parsed.outputColumn || outputName || `output_${index + 1}`,
          type: column?.type || parsed.type || outputType || "string",
        }))
        .filter((rule) => rule.targetName);
      if (rules.length > 0) return rules;
    } catch {
      // Fall back to a single editable output row below.
    }
  }
  const firstRule = parseReviewAnalysisStep(step, sourceField, outputName, outputType);
  return [createReviewRule(firstRule)];
}

function normalizeCsvColumnName(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function buildTextRowExpression(sourceField, targetName) {
  return `TEXT_ANALYZE(${sourceField}).${targetName}`;
}

export default function TransformFunctionModal({ column, onApply, onClose }) {
  const editorRef = useRef(null);
  const sourceField = column.originalName || column.name;
  const initialChain = useMemo(() => initialChainFromColumn(column, sourceField), [column, sourceField]);
  const initialDataStep = lastDataTransformStep(initialChain);
  const [newName, setNewName] = useState(column.name);
  const [newType, setNewType] = useState(column.type);
  const [transformExpr, setTransformExpr] = useState(
    initialDataStep?.expression || initialDataStep?.params || column.transform || sourceField,
  );
  const [chain, setChain] = useState(initialChain);
  const [selectedFunction, setSelectedFunction] = useState(initialChain[initialChain.length - 1]?.operation || "");
  const [isClassifierEditorOpen, setIsClassifierEditorOpen] = useState(
    initialDataStep?.operation === LEGACY_CSV_CLASSIFIER || isRowAnalysisOperation(initialDataStep?.operation),
  );
  const [reviewRules, setReviewRules] = useState(() => parseReviewAnalysisRules(initialDataStep, sourceField, column.name, column.type));

  const functions = [
    {
      name: "Text row to CSV",
      group: "M3",
      desc: "Split one text/source row into structured CSV output columns",
      detail: "classifier",
      type: "string",
    },
    { name: "UPPER", group: "SQL", desc: "Convert to uppercase", build: (base) => `UPPER(CAST(${base} AS STRING))` },
    { name: "LOWER", group: "SQL", desc: "Convert to lowercase", build: (base) => `LOWER(CAST(${base} AS STRING))` },
    { name: "TRIM", group: "SQL", desc: "Remove whitespace", build: (base) => `TRIM(CAST(${base} AS STRING))` },
    { name: "REPLACE", group: "SQL", desc: "Replace characters", build: (base) => `REPLACE(CAST(${base} AS STRING), '', '')` },
    { name: "SUBSTR", group: "SQL", desc: "Extract substring", build: (base) => `SUBSTR(CAST(${base} AS STRING), 1, 10)` },
    { name: "CONCAT", group: "SQL", desc: "Concatenate strings", build: (base) => `CONCAT(CAST(${base} AS STRING), '-', CAST(${base} AS STRING))` },
    { name: "CAST", group: "SQL", desc: "Convert type", build: (base) => `CAST(${base} AS STRING)` },
    { name: "COALESCE", group: "SQL", desc: "Handle nulls", build: (base) => `COALESCE(${base}, 'default')` },
    { name: "ROUND", group: "SQL", desc: "Round number", build: (base) => `ROUND(CAST(${base} AS DOUBLE), 2)`, type: "double" },
    { name: "ABS", group: "SQL", desc: "Absolute value", build: (base) => `ABS(CAST(${base} AS DOUBLE))`, type: "double" },
    {
      name: "JSONPATH",
      group: "M3",
      desc: "Extract value from JSON by JSONPath",
      build: (base) => `get_json_object(CAST(${base} AS STRING), '$.value')`,
      operation: "Extract JSONPath",
      params: "$.value",
      onError: "Set Null",
      type: "string",
    },
    {
      name: "LOWER+TRIM",
      group: "M3",
      desc: "Normalize text with lowercase and trim",
      build: (base) => `LOWER(TRIM(CAST(${base} AS STRING)))`,
      operation: "Lowercase + Trim",
      params: "lower(), trim()",
      onError: "Warn",
      type: "string",
    },
    {
      name: "DECIMAL",
      group: "M3",
      desc: "Cast value to double",
      build: (base) => `CAST(${base} AS DOUBLE)`,
      operation: "Cast Decimal",
      params: "double",
      onError: "Set Null",
      type: "double",
    },
    {
      name: "TIMESTAMP",
      group: "M3",
      desc: "Parse text as timestamp",
      build: (base) => `TO_TIMESTAMP(CAST(${base} AS STRING))`,
      operation: "Parse Timestamp",
      params: "UTC",
      onError: "Set Null",
      type: "timestamp",
    },
    {
      name: "MASK",
      group: "M3",
      desc: "Mask phone-like values",
      build: (base) => `REGEXP_REPLACE(CAST(${base} AS STRING), '(\\\\d{3})-\\\\d{4}-(\\\\d{4})', '$1-****-$2')`,
      operation: "Mask",
      params: "phone",
      onError: "Warn",
      type: "string",
    },
    {
      name: "DEFAULT",
      group: "M3",
      desc: "Fill empty values with a default",
      build: (base) => `COALESCE(${base}, 'default')`,
      operation: "Default Value",
      params: "default",
      onError: "Warn",
    },
    {
      name: "NOT NULL",
      group: "M3",
      desc: "Reject rows where this field is empty",
      build: (base) => base,
      operation: "Null Guard",
      params: "required",
      onError: "Fail Run",
    },
  ];

  const openClassifierEditor = () => {
    setSelectedFunction("Text row to CSV");
    setIsClassifierEditorOpen(true);
  };

  const updateReviewRule = (id, patch) => {
    setReviewRules((prev) => prev.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));
  };

  const updateReviewRuleMethod = (id, method) => {
    const normalizedMethod = normalizeReviewAnalysisMethod(method);
    setReviewRules((prev) => prev.map((rule) => (rule.id === id
      ? (() => {
        const defaults = defaultAllowedValues(method);
        return {
          ...rule,
          allowedValues: normalizedMethod === "one_of_values" ? defaults : [],
          allowedValuesInput: normalizedMethod === "one_of_values" ? serializeAllowedValues(defaults) : "",
          instruction: normalizedMethod === "instruction"
            ? (rule.instruction || defaultInstruction(method, rule.targetName))
            : "",
          method: normalizedMethod,
        };
      })()
      : rule)));
  };

  const updateReviewRuleAllowedValues = (id, value) => {
    updateReviewRule(id, { allowedValues: parseAllowedValues(value), allowedValuesInput: value });
  };

  const updateReviewRuleInstruction = (id, value) => {
    updateReviewRule(id, { instruction: value });
  };

  const addReviewRule = () => {
    setReviewRules((prev) => [
      ...prev,
      createReviewRule({
        method: "copy",
        targetName: `output_${prev.length + 1}`,
        type: "string",
      }),
    ]);
  };

  const removeReviewRule = (id) => {
    setReviewRules((prev) => (prev.length > 1 ? prev.filter((rule) => rule.id !== id) : prev));
  };

  const appendStep = (func) => {
    if (func.detail === "classifier") {
      openClassifierEditor();
      return;
    }
    const outputField = newName.trim() || sourceField;
    const baseExpr = dataTransformStep(chain) ? transformExpr?.trim() || outputField : outputField;
    const expression = func.build(baseExpr);
    const operation = func.operation || SQL_EXPRESSION;
    const params = func.params ?? expression;
    const nextStep = normalizeChainStep({
      expression,
      onError: func.onError || "Warn",
      operation,
      params,
      type: func.type || newType,
    }, newType);
    const nextChain = [...chain, nextStep];

    setChain(nextChain);
    setSelectedFunction(func.name);
    if (func.type) setNewType(func.type);
    setTransformExpr(expression);

    if (editorRef.current) {
      setTimeout(() => editorRef.current.focus(), 0);
    }
  };

  const updateExpression = (value) => {
    const nextStep = normalizeChainStep({
      expression: value,
      operation: SQL_EXPRESSION,
      params: value,
      type: newType,
    }, newType);
    setTransformExpr(value);
    setSelectedFunction("CUSTOM");
    setChain(value.trim() ? [nextStep] : []);
  };

  const removeChainStep = (index) => {
    setChain((prev) => {
      const next = prev.filter((_, itemIndex) => itemIndex !== index);
      const lastDataStep = dataTransformStep([...next].reverse());
      setTransformExpr(lastDataStep?.expression || lastDataStep?.params || sourceField);
      return next;
    });
  };

  const clearChain = () => {
    setChain([]);
    setSelectedFunction("");
    setTransformExpr(newName.trim() || sourceField);
  };

  const applyTransform = () => {
    if (isClassifierEditorOpen) {
      const outputColumns = reviewRules
        .map((rule, index) => {
          const targetName = normalizeCsvColumnName(rule.targetName || `output_${index + 1}`) || `output_${index + 1}`;
          const method = normalizeReviewAnalysisMethod(rule.method, "copy");
          return {
            allowedValues: parseAllowedValues(rule.allowedValuesInput ?? serializeAllowedValues(rule.allowedValues)),
            instruction: String(rule.instruction || "").trim(),
            method,
            nullable: true,
            targetName,
            type: rule.type || "string",
          };
        })
        .filter((rule, index, rules) => rule.targetName && rules.findIndex((item) => item.targetName === rule.targetName) === index);

      if (outputColumns.length === 0) return;
      const firstColumn = outputColumns[0];
      const expression = buildTextRowExpression(sourceField, firstColumn.targetName);
      onApply(expression, firstColumn.targetName, firstColumn.type, {
        columns: outputColumns,
        mode: "csvMultiOutput",
        onError: "Warn",
        operation: TEXT_ROW_ANALYSIS,
        sourceField,
      });
      return;
    }
    const fallbackStep = transformExpr.trim() && transformExpr.trim() !== sourceField
      ? [normalizeChainStep({
        expression: transformExpr,
        operation: SQL_EXPRESSION,
        params: transformExpr,
        type: newType,
      }, newType)]
      : [];
    const normalizedChain = (chain.length > 0 ? chain : fallbackStep).map((step) => normalizeChainStep({
      ...step,
      type: step.type || newType,
    }, newType));
    const primaryStep = dataTransformStep(normalizedChain) || normalizedChain[0] || {
      operation: SQL_EXPRESSION,
      params: transformExpr,
      expression: transformExpr,
      onError: "Warn",
      type: newType,
    };

    onApply(transformExpr, newName, newType, {
      ...primaryStep,
      chain: normalizedChain,
      display: normalizedChain.map(formatChainStep).join(" -> "),
      type: newType,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1002]">
      <div className={`bg-white rounded-2xl shadow-xl border border-slate-200 max-h-[90vh] overflow-hidden ${isClassifierEditorOpen ? "w-[calc(100vw-24px)] max-w-[980px]" : "w-[640px]"}`}>
        <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50">
          <h3 className="text-xs font-bold text-slate-800 uppercase tracking-widest flex items-center gap-2">
            <span className="w-1 h-3 bg-indigo-500 rounded-full"></span>
            Field Transform
          </h3>
        </div>

        <div className={`p-6 space-y-4 overflow-y-auto ${isClassifierEditorOpen ? "max-h-[72vh]" : "max-h-[56vh]"}`}>
          {!isClassifierEditorOpen && (
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="text-xs font-bold text-slate-600">Output name</span>
              <input
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-bold text-slate-600">Output type</span>
              <select
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
                value={newType}
                onChange={(event) => setNewType(event.target.value)}
              >
                <option value="string">string</option>
                <option value="integer">integer</option>
                <option value="long">long</option>
                <option value="double">double</option>
                <option value="boolean">boolean</option>
                <option value="timestamp">timestamp</option>
                <option value="date">date</option>
              </select>
            </label>
          </div>
          )}

          {isClassifierEditorOpen ? (
            <div className="space-y-5 rounded-xl border border-indigo-100 bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <strong className="block text-base font-bold text-slate-900">Text row to structured CSV columns</strong>
                  <span className="font-mono text-xs font-semibold text-indigo-600">source field: {sourceField}</span>
                </div>
                <div className="flex gap-2">
                  <button
                    className="rounded-lg border border-indigo-200 bg-white px-3 py-2 text-xs font-bold text-indigo-700 hover:bg-indigo-50"
                    onClick={addReviewRule}
                    type="button"
                  >
                    + output column
                  </button>
                  <button
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-500 hover:border-indigo-300 hover:text-indigo-600"
                    onClick={() => setIsClassifierEditorOpen(false)}
                    type="button"
                  >
                    Back
                  </button>
                </div>
              </div>

              <div className="overflow-hidden rounded-xl border border-slate-300 bg-white">
                <div className="grid grid-cols-[56px_minmax(150px,1fr)_132px_180px_minmax(260px,1.4fr)_72px] bg-slate-950 font-mono text-xs font-bold text-slate-100">
                  <div className="border-r border-slate-700 px-3 py-3 text-center">#</div>
                  <div className="border-r border-slate-700 px-3 py-3">A - output_column</div>
                  <div className="border-r border-slate-700 px-3 py-3">B - type</div>
                  <div className="border-r border-slate-700 px-3 py-3">C - method</div>
                  <div className="border-r border-slate-700 px-3 py-3">D - values_or_instruction</div>
                  <div className="px-3 py-3 text-center">delete</div>
                </div>

                <div className="max-h-[420px] overflow-auto">
                  {reviewRules.map((rule, index) => {
                    const methodOption = METHOD_OPTION_BY_VALUE[normalizeReviewAnalysisMethod(rule.method)] || METHOD_OPTION_BY_VALUE.one_of_values;
                    const canUseAllowedValues = methodOption.kind === "classify";
                    const canUseInstruction = methodOption.kind === "instruction";
                    return (
                      <div
                        key={rule.id}
                        className="grid grid-cols-[56px_minmax(150px,1fr)_132px_180px_minmax(260px,1.4fr)_72px] border-t border-slate-200 font-mono text-sm"
                      >
                        <div className="flex items-center justify-center bg-slate-50 px-3 py-2 text-xs font-bold text-slate-500">
                          {index + 1}
                        </div>
                        <div className="border-l border-slate-200 p-0">
                          <input
                            className="h-full min-h-12 w-full border-0 px-3 font-mono text-sm outline-none focus:bg-indigo-50 focus:ring-2 focus:ring-inset focus:ring-indigo-500"
                            value={rule.targetName}
                            onChange={(event) => updateReviewRule(rule.id, { targetName: event.target.value })}
                          />
                        </div>
                        <div className="border-l border-slate-200 p-0">
                          <select
                            className="h-full min-h-12 w-full border-0 bg-white px-3 font-mono text-sm outline-none focus:bg-indigo-50 focus:ring-2 focus:ring-inset focus:ring-indigo-500"
                            value={rule.type}
                            onChange={(event) => updateReviewRule(rule.id, { type: event.target.value })}
                          >
                            {OUTPUT_TYPE_OPTIONS.map((type) => (
                              <option key={type} value={type}>{type}</option>
                            ))}
                          </select>
                        </div>
                        <div className="border-l border-slate-200 p-0">
                          <select
                            className="h-full min-h-12 w-full border-0 bg-white px-3 font-mono text-sm outline-none focus:bg-indigo-50 focus:ring-2 focus:ring-inset focus:ring-indigo-500"
                            value={normalizeReviewAnalysisMethod(rule.method)}
                            onChange={(event) => updateReviewRuleMethod(rule.id, event.target.value)}
                          >
                            {REVIEW_ANALYSIS_METHOD_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </div>
                        <div className="border-l border-slate-200 p-0">
                          <textarea
                            className="min-h-12 w-full resize-y border-0 px-3 py-2 font-mono text-sm outline-none focus:bg-indigo-50 focus:ring-2 focus:ring-inset focus:ring-indigo-500 disabled:bg-slate-50 disabled:text-slate-400"
                            disabled={!canUseAllowedValues && !canUseInstruction}
                            placeholder={
                              canUseAllowedValues
                                ? "value_1\nvalue_2\nvalue_3"
                                : canUseInstruction
                                  ? "natural language instruction for this output"
                                  : "source value is copied"
                            }
                            value={canUseInstruction ? (rule.instruction || "") : (rule.allowedValuesInput ?? serializeAllowedValues(rule.allowedValues))}
                            onChange={(event) => (
                              canUseInstruction
                                ? updateReviewRuleInstruction(rule.id, event.target.value)
                                : updateReviewRuleAllowedValues(rule.id, event.target.value)
                            )}
                          />
                        </div>
                        <div className="flex items-center justify-center border-l border-slate-200 bg-slate-50 px-2 py-2">
                          <button
                            className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-bold text-slate-500 hover:border-red-300 hover:text-red-600 disabled:opacity-40"
                            disabled={reviewRules.length <= 1}
                            onClick={() => removeReviewRule(rule.id)}
                            type="button"
                          >
                            del
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

            </div>          ) : (
            <>
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <strong className="block text-xs font-bold text-emerald-900">Text row structuring</strong>
                  </div>
                  <button
                    className="shrink-0 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-bold text-white shadow-sm hover:bg-emerald-700"
                    onClick={openClassifierEditor}
                    type="button"
                  >
                    Select method
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Quick Functions</label>
                <div className="flex flex-wrap gap-2">
                  {functions.map((func) => (
                    <button
                      key={func.name}
                      onClick={() => appendStep(func)}
                      className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-tight transition-all border ${
                        selectedFunction === func.name
                          ? "bg-indigo-600 text-white border-indigo-600 shadow-sm"
                          : func.group === "M3"
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200 hover:border-emerald-500"
                            : "bg-white text-slate-600 border-slate-200 hover:border-indigo-400 hover:text-indigo-600"
                      }`}
                      title={func.desc}
                      type="button"
                    >
                      {func.name}
                    </button>
                  ))}
                </div>
              </div>

              {chain.length > 0 && (
                <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-600">Transform chain</span>
                    <button
                      className="text-[10px] font-bold uppercase tracking-wide text-slate-500 hover:text-red-600"
                      onClick={clearChain}
                      type="button"
                    >
                      Clear
                    </button>
                  </div>
                  <div className="space-y-1.5">
                    {chain.map((step, index) => (
                      <div key={`${step.operation}-${index}`} className="flex items-center gap-2 rounded-lg bg-white px-2 py-1.5 text-xs text-slate-700 ring-1 ring-slate-200">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-[10px] font-bold text-indigo-600">
                          {index + 1}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono">{formatChainStep(step)}</span>
                        <button
                          className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                          onClick={() => removeChainStep(index)}
                          title="Remove step"
                          type="button"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-gray-700">Transform Expression (SQL)</label>
                </div>

                <textarea
                  ref={editorRef}
                  value={transformExpr}
                  onChange={(event) => updateExpression(event.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl font-mono text-sm focus:outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50/50 transition-all bg-slate-50/30"
                  placeholder={`e.g., CONCAT(SUBSTR(${sourceField}, 1, 3), '-', SUBSTR(${sourceField}, 4, 4))`}
                />
              </div>
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-2 bg-slate-50/50">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-bold text-slate-500 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-all"
            type="button"
          >
            Cancel
          </button>
          <button
            onClick={applyTransform}
            className="px-5 py-2 bg-indigo-600 text-white text-xs font-bold rounded-lg hover:bg-indigo-700 transition-all shadow-md shadow-indigo-200"
            type="button"
          >
            {isClassifierEditorOpen ? "Apply Text Schema" : "Apply Transform"}
          </button>
        </div>
      </div>
    </div>
  );
}
