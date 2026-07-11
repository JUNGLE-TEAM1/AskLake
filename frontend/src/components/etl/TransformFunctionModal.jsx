import React, { useState, useRef } from 'react';
import { Sparkles } from 'lucide-react';
import InlineAIInput from '../ai/InlineAIInput';
import { ActionGroup } from '../ui/action-group';
import { Button } from '../ui/button';
import { DialogShell } from '../ui/dialog-shell';

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
  const [modelArtifacts, setModelArtifacts] = useState([]);
  const [modelArtifactsError, setModelArtifactsError] = useState("");
  const availableModelArtifacts = useMemo(() => {
    const byArtifact = new Map();
    for (const artifact of modelArtifacts) {
      if (artifact?.status !== "available" || !artifact?.modelArtifact) continue;
      const key = [
        normalizedName(artifact.targetColumn || artifact.outputColumn || ""),
        normalizedText(artifact.method),
        [...normalizedAllowedValueSet(artifact.allowedValues)].sort().join("|"),
        String(artifact.modelArtifact),
      ].join("::");
      const current = byArtifact.get(key);
      if (!current || String(artifact.updatedAt || "").localeCompare(String(current.updatedAt || "")) > 0) {
        byArtifact.set(key, artifact);
      }
    }
    return [...byArtifact.values()];
  }, [modelArtifacts]);

  useEffect(() => {
    if (!isClassifierEditorOpen) return undefined;
    let cancelled = false;
    getCatalogModelArtifacts()
      .then((items) => {
        if (cancelled) return;
        setModelArtifacts(Array.isArray(items) ? items : []);
        setModelArtifactsError("");
      })
      .catch((error) => {
        if (cancelled) return;
        setModelArtifacts([]);
        setModelArtifactsError(error instanceof Error ? error.message : "Failed to load models.");
      });
    return () => {
      cancelled = true;
    };
  }, [isClassifierEditorOpen]);

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

  const updateReviewRuleTargetName = (id, value) => {
    setReviewRules((prev) => prev.map((rule) => {
      if (rule.id !== id) return rule;
      const next = { ...rule, targetName: value };
      return ruleModelStillCompatible(next, availableModelArtifacts)
        ? next
        : { ...next, modelArtifact: "", modelId: "", modelSelectionPolicy: "auto" };
    }));
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
          modelArtifact: normalizedMethod === "one_of_values" ? rule.modelArtifact : "",
          modelId: normalizedMethod === "one_of_values" ? rule.modelId : "",
          modelSelectionPolicy: normalizedMethod === "one_of_values" ? rule.modelSelectionPolicy || "auto" : "none",
          fallbackAllowed: normalizedMethod === "one_of_values" ? Boolean(rule.fallbackAllowed) : false,
          requireModel: normalizedMethod === "one_of_values" && !rule.fallbackAllowed,
        };
      })()
      : rule)));
  };

  const updateReviewRuleAllowedValues = (id, value) => {
    const allowedValues = parseAllowedValues(value);
    setReviewRules((prev) => prev.map((rule) => {
      if (rule.id !== id) return rule;
      const next = { ...rule, allowedValues, allowedValuesInput: value };
      return ruleModelStillCompatible(next, availableModelArtifacts)
        ? next
        : { ...next, modelArtifact: "", modelId: "", modelSelectionPolicy: "auto" };
    }));
  };

  const updateReviewRuleInstruction = (id, value) => {
    updateReviewRule(id, { instruction: value });
  };

  const updateReviewRuleModel = (id, value) => {
    setReviewRules((prev) => prev.map((rule) => {
      if (rule.id !== id) return rule;
      const currentRule = ruleWithCurrentAllowedValues(rule);
      const selected = compatibleModelArtifactsForRule(currentRule, availableModelArtifacts)
        .find((artifact) => artifact.modelArtifact === value || artifact.id === value);
      return {
        ...rule,
        modelArtifact: selected?.modelArtifact || "",
        modelId: selected?.id || "",
        modelSelectionPolicy: selected ? "explicit" : "auto",
        requireModel: normalizeReviewAnalysisMethod(rule.method) === "one_of_values" && !rule.fallbackAllowed,
      };
    }));
  };

  const updateReviewRuleFallbackAllowed = (id, checked) => {
    setReviewRules((prev) => prev.map((rule) => {
      if (rule.id !== id) return rule;
      const method = normalizeReviewAnalysisMethod(rule.method);
      const fallbackAllowed = method === "one_of_values" && Boolean(checked);
      return {
        ...rule,
        fallbackAllowed,
        requireModel: method === "one_of_values" && !fallbackAllowed,
      };
    }));
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
          const allowedValues = parseAllowedValues(rule.allowedValuesInput ?? serializeAllowedValues(rule.allowedValues));
          const candidateRule = { ...rule, allowedValues, targetName };
          const compatibleModel = method === "one_of_values"
            ? compatibleModelArtifactsForRule(candidateRule, availableModelArtifacts)
              .find((artifact) => artifact.modelArtifact === rule.modelArtifact || artifact.id === rule.modelId)
            : null;
          const fallbackAllowed = method === "one_of_values" && Boolean(rule.fallbackAllowed);
          return {
            allowedValues,
            fallbackAllowed,
            instruction: String(rule.instruction || "").trim(),
            method,
            modelArtifact: compatibleModel ? String(compatibleModel.modelArtifact || "") : "",
            modelId: compatibleModel ? String(compatibleModel.id || "") : "",
            modelSelectionPolicy: method === "one_of_values" ? (compatibleModel ? "explicit" : "auto") : "none",
            nullable: true,
            requireModel: method === "one_of_values" && !fallbackAllowed,
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

    return (
        <DialogShell
            bodyClassName="!p-0"
            closeLabel="Close"
            contentClassName="rounded-2xl"
            description={(
                <>
                    Refining: <span className="text-indigo-600 font-bold">{column.originalName}</span>
                </>
            )}
            footer={(
                <ActionGroup density="compact">
                    <Button type="button" onClick={onClose} size="sm" variant="outline">
                        Cancel
                    </Button>
                    <Button type="button" onClick={() => onApply(transformExpr, newName, newType)} size="sm">
                        Apply Transform
                    </Button>
                </ActionGroup>
            )}
            footerClassName="bg-slate-50/50"
            headerClassName="bg-slate-50/50"
            onClose={onClose}
            size="md"
            title={(
                <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-normal text-slate-800">
                    <span className="h-3 w-1 rounded-full bg-indigo-500" />
                    Field Transform
                </span>
            )}
        >
            <div className="max-h-[50vh] space-y-4 overflow-y-auto p-6">
                {/* Quick Functions */}
                <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Quick Functions</label>
                    <div className="flex flex-wrap gap-2">
                        {functions.map(func => (
                            <button
                                key={func.name}
                                onClick={() => applyFunction(func)}
                                className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-tight transition-all border ${selectedFunction === func.name
                                    ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                                    : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-400 hover:text-indigo-600'
                                    }`}
                                title={func.desc}
                            >
                                {func.name}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Expression Editor */}
                <div>
                    <div className="flex items-center justify-between mb-2">
                        <label className="block text-sm font-medium text-gray-700">Transform Expression (SQL)</label>
                        <button
                            onClick={() => setShowAI(!showAI)}
                            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium
                                bg-gradient-to-r from-indigo-50 to-purple-50 text-indigo-600
                                hover:from-indigo-100 hover:to-purple-100 transition-all
                                border border-indigo-200/50"
                            title="AI Assistant"
                        >
                            <Sparkles size={14} />
                            <span>AI</span>
                        </button>
                    </div>

                    {/* AI Input Panel - appears between flex row and textarea */}
                    {showAI && (
                        <InlineAIInput
                            promptType="field_transform"
                            metadata={{
                                column_name: column.originalName,
                                column_type: column.type
                            }}
                            placeholder="e.g., convert to uppercase, extract first 3 characters..."
                            onApply={(suggestion) => {
                                // Apply AI suggestion to the transform expression
                                setTransformExpr(suggestion);
                                setShowAI(false);
                                // Focus textarea after applying
                                if (editorRef.current) {
                                    setTimeout(() => {
                                        editorRef.current.focus();
                                    }, 0);
                                }
                            }}
                            onCancel={() => setShowAI(false)}
                        />
                    )}

                    <textarea
                        ref={editorRef}
                        value={transformExpr}
                        onChange={(e) => setTransformExpr(e.target.value)}
                        rows={3}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl font-mono text-sm focus:outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50/50 transition-all bg-slate-50/30"
                        placeholder={`e.g., CONCAT(SUBSTR(${column.originalName}, 1, 3), '-', SUBSTR(${column.originalName}, 4, 4))`}
                    />
                </div>
            </div>
        </DialogShell>
    );
}
