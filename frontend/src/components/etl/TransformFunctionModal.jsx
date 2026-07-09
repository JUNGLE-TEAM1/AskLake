import React, { useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

const SQL_EXPRESSION = "SQL Expression";
const LEGACY_CSV_CLASSIFIER = "Custom CSV Classifier";
const REVIEW_ROW_ANALYSIS = "Review Row Analysis";
const FIELD_ONLY_OPERATIONS = new Set(["Default Value", "Null Guard"]);

const OUTPUT_TYPE_OPTIONS = ["string", "integer", "long", "double", "boolean", "timestamp", "date"];

const REVIEW_ANALYSIS_METHOD_OPTIONS = [
  { value: "copy_or_extract_field", label: "Copy / extract original field", kind: "copy" },
  { value: "one_of_values", label: "One of N values", kind: "classify" },
  { value: "sentiment_3way", label: "Sentiment", kind: "classify", values: ["positive", "mixed", "negative"] },
  { value: "issue_category", label: "Issue category", kind: "classify", values: ["battery_or_power", "screen_or_display", "shipping_or_package", "listing_mismatch", "durability_quality", "positive_feedback", "general_issue"] },
  { value: "issue_subcategory", label: "Issue subcategory", kind: "classify" },
  { value: "severity_4level", label: "Severity", kind: "classify", values: ["critical", "high", "medium", "low"] },
  { value: "boolean_y_n", label: "Y/N", kind: "classify", values: ["Y", "N"] },
  { value: "extractive_summary", label: "Summary", kind: "generate" },
  { value: "evidence_span", label: "Evidence span", kind: "extract" },
];

const LEGACY_METHOD_ALIASES = {
  custom_instruction: "one_of_values",
  issue_taxonomy: "issue_category",
};

const METHOD_OPTION_BY_VALUE = Object.fromEntries(REVIEW_ANALYSIS_METHOD_OPTIONS.map((option) => [option.value, option]));

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

function normalizeReviewAnalysisMethod(value, fallback = "copy_or_extract_field") {
  const raw = String(value || "").split(":")[0].trim();
  const normalized = LEGACY_METHOD_ALIASES[raw] || raw;
  return REVIEW_ANALYSIS_METHOD_OPTIONS.some((option) => option.value === normalized)
    ? normalized
    : fallback;
}

function defaultAllowedValues(method) {
  return METHOD_OPTION_BY_VALUE[normalizeReviewAnalysisMethod(method)]?.values || [];
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
  if (step?.operation !== REVIEW_ROW_ANALYSIS || !step?.params) {
    const method = "copy_or_extract_field";
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
    const method = normalizeReviewAnalysisMethod(firstColumn?.method || parsed.method, "copy_or_extract_field");
    return {
      allowedValues: Array.isArray(firstColumn?.allowedValues) ? firstColumn.allowedValues : defaultAllowedValues(method),
      method,
      sourceField: String(parsed.sourceField || sourceField),
      targetName: String(firstColumn?.targetName || parsed.targetName || outputName),
      type: String(firstColumn?.type || parsed.type || outputType || "string"),
    };
  } catch {
    const method = "copy_or_extract_field";
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

function createReviewRule({ allowedValues, method, targetName, type } = {}) {
  const normalizedMethod = normalizeReviewAnalysisMethod(method, "copy_or_extract_field");
  return {
    allowedValues: Array.isArray(allowedValues) && allowedValues.length > 0 ? allowedValues : defaultAllowedValues(normalizedMethod),
    id: newReviewRuleId(),
    method: normalizedMethod,
    targetName: normalizeCsvColumnName(targetName || "output_value") || "output_value",
    type: type || "string",
  };
}

function parseReviewAnalysisRules(step, sourceField, outputName, outputType) {
  if (step?.operation === REVIEW_ROW_ANALYSIS && step?.params) {
    try {
      const parsed = JSON.parse(step.params);
      const columns = Array.isArray(parsed.columns) ? parsed.columns : [parsed];
      const rules = columns
        .map((column, index) => createReviewRule({
          allowedValues: Array.isArray(column?.allowedValues) ? column.allowedValues : [],
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

function buildReviewRowExpression(sourceField, targetName) {
  return `REVIEW_ANALYZE(${sourceField}).${targetName}`;
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
    initialDataStep?.operation === LEGACY_CSV_CLASSIFIER || initialDataStep?.operation === REVIEW_ROW_ANALYSIS,
  );
  const [reviewRules, setReviewRules] = useState(() => parseReviewAnalysisRules(initialDataStep, sourceField, column.name, column.type));

  const functions = [
    {
      name: "Review row rule",
      group: "M3",
      desc: "Create this target row from the full source review row",
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
    setSelectedFunction("Review row rule");
    setIsClassifierEditorOpen(true);
  };

  const updateReviewRule = (id, patch) => {
    setReviewRules((prev) => prev.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));
  };

  const updateReviewRuleMethod = (id, method) => {
    const normalizedMethod = normalizeReviewAnalysisMethod(method);
    const defaults = defaultAllowedValues(normalizedMethod);
    setReviewRules((prev) => prev.map((rule) => (rule.id === id
      ? {
        ...rule,
        allowedValues: defaults.length > 0 ? defaults : [],
        method: normalizedMethod,
      }
      : rule)));
  };

  const updateReviewRuleAllowedValues = (id, value) => {
    updateReviewRule(id, { allowedValues: parseAllowedValues(value) });
  };

  const addReviewRule = () => {
    setReviewRules((prev) => [
      ...prev,
      createReviewRule({
        method: "copy_or_extract_field",
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
          const method = normalizeReviewAnalysisMethod(rule.method, "copy_or_extract_field");
          return {
            allowedValues: Array.isArray(rule.allowedValues) ? rule.allowedValues.filter(Boolean) : [],
            method,
            nullable: true,
            targetName,
            type: rule.type || "string",
          };
        })
        .filter((rule, index, rules) => rule.targetName && rules.findIndex((item) => item.targetName === rule.targetName) === index);

      if (outputColumns.length === 0) return;
      const firstColumn = outputColumns[0];
      const expression = buildReviewRowExpression(sourceField, firstColumn.targetName);
      onApply(expression, firstColumn.targetName, firstColumn.type, {
        columns: outputColumns,
        mode: "csvMultiOutput",
        onError: "Warn",
        operation: REVIEW_ROW_ANALYSIS,
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
                  <strong className="block text-base font-bold text-slate-900">Review row to CSV rows</strong>
                  <span className="font-mono text-xs font-semibold text-indigo-600">source row: {sourceField}</span>
                </div>
                <div className="flex gap-2">
                  <button
                    className="rounded-lg border border-indigo-200 bg-white px-3 py-2 text-xs font-bold text-indigo-700 hover:bg-indigo-50"
                    onClick={addReviewRule}
                    type="button"
                  >
                    + output row
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
                <div className="grid grid-cols-[56px_minmax(160px,1fr)_150px_220px_minmax(180px,1fr)_72px] bg-slate-950 font-mono text-xs font-bold text-slate-100">
                  <div className="border-r border-slate-700 px-3 py-3 text-center">#</div>
                  <div className="border-r border-slate-700 px-3 py-3">A - output_column</div>
                  <div className="border-r border-slate-700 px-3 py-3">B - type</div>
                  <div className="border-r border-slate-700 px-3 py-3">C - LLM method</div>
                  <div className="border-r border-slate-700 px-3 py-3">D - allowed_values</div>
                  <div className="px-3 py-3 text-center">delete</div>
                </div>

                <div className="max-h-[420px] overflow-auto">
                  {reviewRules.map((rule, index) => {
                    const methodOption = METHOD_OPTION_BY_VALUE[normalizeReviewAnalysisMethod(rule.method)] || METHOD_OPTION_BY_VALUE.one_of_values;
                    const canUseAllowedValues = methodOption.kind === "classify";
                    return (
                      <div
                        key={rule.id}
                        className="grid grid-cols-[56px_minmax(160px,1fr)_150px_220px_minmax(180px,1fr)_72px] border-t border-slate-200 font-mono text-sm"
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
                            disabled={!canUseAllowedValues}
                            placeholder={canUseAllowedValues ? "one value per line" : "generated at runtime"}
                            value={serializeAllowedValues(rule.allowedValues)}
                            onChange={(event) => updateReviewRuleAllowedValues(rule.id, event.target.value)}
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

              <div className="rounded-xl border border-slate-200 bg-slate-950 px-4 py-3">
                <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-400">Generated Spark expressions</span>
                <code className="mt-2 block whitespace-pre-wrap break-all font-mono text-xs text-slate-100">
                  {reviewRules.map((rule, index) => `${normalizeCsvColumnName(rule.targetName || `output_${index + 1}`)} = ${buildReviewRowExpression(sourceField, normalizeCsvColumnName(rule.targetName || `output_${index + 1}`))}`).join("\n")}
                </code>
              </div>
            </div>          ) : (
            <>
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <strong className="block text-xs font-bold text-emerald-900">리뷰 row 변환 방식</strong>
                  </div>
                  <button
                    className="shrink-0 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-bold text-white shadow-sm hover:bg-emerald-700"
                    onClick={openClassifierEditor}
                    type="button"
                  >
                    방식 선택
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
            {isClassifierEditorOpen ? "Apply Row Rule" : "Apply Transform"}
          </button>
        </div>
      </div>
    </div>
  );
}
