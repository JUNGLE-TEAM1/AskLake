import React, { useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

const SQL_EXPRESSION = "SQL Expression";
const FIELD_ONLY_OPERATIONS = new Set(["Default Value", "Null Guard"]);

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

  const functions = [
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

  const appendStep = (func) => {
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
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 w-[640px] max-h-[85vh] overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50">
          <h3 className="text-xs font-bold text-slate-800 uppercase tracking-widest flex items-center gap-2">
            <span className="w-1 h-3 bg-indigo-500 rounded-full"></span>
            Field Transform
          </h3>
          <p className="text-[10px] text-slate-500 font-medium mt-1">
            Refining: <span className="text-indigo-600 font-bold">{sourceField}</span>
          </p>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto max-h-[56vh]">
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
            <label className="block text-sm font-medium text-gray-700 mb-2">Transform Expression (SQL)</label>

            <textarea
              ref={editorRef}
              value={transformExpr}
              onChange={(event) => updateExpression(event.target.value)}
              rows={3}
              className="w-full px-3 py-2 border border-slate-200 rounded-xl font-mono text-sm focus:outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50/50 transition-all bg-slate-50/30"
              placeholder={`e.g., CONCAT(SUBSTR(${sourceField}, 1, 3), '-', SUBSTR(${sourceField}, 4, 4))`}
            />
          </div>
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
            Apply Transform
          </button>
        </div>
      </div>
    </div>
  );
}
