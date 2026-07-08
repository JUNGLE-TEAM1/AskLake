import React, { useState, useEffect, useRef } from "react";
import {
  ChevronRight,
  ChevronsRight,
  ChevronUp,
  ChevronDown,
  Braces,
  Sparkles,
  Trash2,
} from "lucide-react";
import TransformFunctionModal from "./TransformFunctionModal";
import InlineAIInput from "../ai/InlineAIInput";

/**
 * SchemaTransformEditor - Dual List Box style schema transformation UI
 *
 * Props:
 * - sourceSchema: Array of { name, type } - columns from current source
 * - sourceName: string - name of current source (for prefix when duplicates)
 * - sourceId: string - ID of current source
 * - sourceDatasetId: string - ID of source dataset for testing
 * - targetSchema: Array - shared target schema (from parent)
 * - initialTargetSchema: Array - initial target schema (for edit mode)
 * - onSchemaChange: (targetSchema) => void - callback when target schema changes
 * - onTestStatusChange: (boolean) => void - callback for test status
 * - sourceTabs: ReactNode - tabs for switching between sources
 */

// Normalize type names from various backend formats to frontend format
const normalizeType = (type) => {
  if (!type) return "string";
  const lowerType = type.toLowerCase();
  const typeMap = {
    int: "integer",
    int32: "integer",
    int64: "long",
    bigint: "long",
    float32: "float",
    float64: "double",
    bool: "boolean",
    str: "string",
    datetime: "timestamp",
    text: "string",
  };
  return typeMap[lowerType] || lowerType;
};

const FIELD_ONLY_TRANSFORMS = new Set(["Default Value", "Null Guard"]);

const formatTransformChainStep = (step) => {
  if (!step) return "";
  if (step.display) return step.display;
  if (step.operation === "SQL Expression") return step.params || step.expression || "SQL Expression";
  return `${step.operation}${step.params ? `: ${step.params}` : ""}`;
};

const normalizeTransformChain = (chain, fallbackType) => {
  if (!Array.isArray(chain)) return [];
  return chain
    .filter((step) => step && (step.operation || step.params || step.expression))
    .map((step) => {
      const operation = step.operation || "SQL Expression";
      const params = step.params ?? step.expression ?? "";
      return {
        display: step.display || (operation === "SQL Expression" ? params : `${operation}${params ? `: ${params}` : ""}`),
        expression: step.expression || (operation === "SQL Expression" ? params : ""),
        onError: step.onError || "Warn",
        operation,
        params,
        type: step.type || fallbackType,
      };
    });
};

const primaryTransformStep = (chain) => chain.find((step) => !FIELD_ONLY_TRANSFORMS.has(step.operation)) || null;
const dataTransformChain = (chain) => (Array.isArray(chain) ? chain.filter((step) => !FIELD_ONLY_TRANSFORMS.has(step.operation)) : []);

export default function SchemaTransformEditor({
  sourceSchema = [],
  sourceName = "Source",
  sourceId,
  sourceDatasetId,
  targetSchema = [],
  onSchemaChange,
  onTestStatusChange,
  onSqlChange,
  initialTargetSchema = [],
  initialCustomSql = "",
  sourceTabs = null,
  allSources = [], // All source nodes info: [{ id, datasetId, name, schema }]
}) {
  // State - beforeColumns is local, targetSchema is managed by parent
  const [beforeColumns, setBeforeColumns] = useState([]);
  const [selectedBefore, setSelectedBefore] = useState(new Set());
  const [selectedAfter, setSelectedAfter] = useState(new Set());
  const [isInitialized, setIsInitialized] = useState(false);
  const [isSqlInitialized, setIsSqlInitialized] = useState(false);

  // Transform function modal
  const [showFunctionModal, setShowFunctionModal] = useState(false);
  const [editingColumn, setEditingColumn] = useState(null);

  // Tab UI: Column Selection vs SQL Transform
  const [activeTab, setActiveTab] = useState("columns"); // 'columns' | 'sql'
  const [customSql, setCustomSql] = useState("");
  const [showAI, setShowAI] = useState(false);

  // Initialize beforeColumns when sourceSchema changes (source tab switches)
  useEffect(() => {
    if (sourceSchema && sourceSchema.length > 0) {
      const columns = sourceSchema.map((col) => ({
        name: col.name || col.field,
        type: normalizeType(col.type),
        originalName: col.name || col.field,
      }));
      setBeforeColumns(columns);
      // Clear selections when source changes
      setSelectedBefore(new Set());
      setSelectedAfter(new Set());
    }
  }, [JSON.stringify(sourceSchema)]);

  // Initialize targetSchema from initialTargetSchema only once
  useEffect(() => {
    if (
      !isInitialized &&
      initialTargetSchema &&
      initialTargetSchema.length > 0
    ) {
      const initialAfter = initialTargetSchema.map((col) => {
        const normalizedType = normalizeType(col.type);
        const normalizedChain = normalizeTransformChain(col.transformChain, normalizedType);
        const visibleChain = dataTransformChain(normalizedChain);
        const visibleStep = primaryTransformStep(visibleChain);
        const visibleDisplay = visibleChain.map(formatTransformChainStep).filter(Boolean).join(" -> ");
        return {
          ...col,
          type: normalizedType, // ?€???•ê·œ??
          notNull: col.notNull || false,
          defaultValue: col.defaultValue || "",
          transform: visibleStep?.expression || (visibleStep?.operation === "SQL Expression" ? visibleStep.params : col.transform || null),
          transformDisplay: visibleDisplay || (visibleStep ? col.transformDisplay : null) || (col.transform ? `${col.transform}` : null),
          transformChain: visibleChain,
          transformOperation: visibleStep?.operation || col.transformOperation || null,
          transformParams: visibleStep?.params || col.transformParams || "",
          onError: col.onError || "Warn",
          originalName: col.originalName || col.name,
          originalType: normalizeType(col.originalType) || normalizedType, // ?ë³¸ ?€??ë³´ì¡´
          sourceId: col.sourceId || sourceId,
          sourceName: col.sourceName || sourceName,
        };
      });
      onSchemaChange(initialAfter);
      setIsInitialized(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(initialTargetSchema), isInitialized]);

  // Notify parent when customSql changes (SQL tab only)
  useEffect(() => {
    if (onSqlChange && activeTab === "sql" && customSql.trim()) {
      onSqlChange(customSql, "sql");
    }
  }, [customSql, activeTab]);

  // Initialize customSql from prop only once (edit mode)
  useEffect(() => {
    if (!isSqlInitialized && initialCustomSql && initialCustomSql.trim()) {
      setCustomSql(initialCustomSql);
      setIsSqlInitialized(true);
    }
  }, [initialCustomSql, isSqlInitialized]);

  // Selection handlers
  const toggleBeforeSelection = (colName) => {
    setSelectedBefore((prev) => {
      const next = new Set(prev);
      if (next.has(colName)) {
        next.delete(colName);
      } else {
        next.add(colName);
      }
      return next;
    });
  };

  const toggleAfterSelection = (colName) => {
    setSelectedAfter((prev) => {
      const next = new Set(prev);
      if (next.has(colName)) {
        next.delete(colName);
      } else {
        next.add(colName);
      }
      return next;
    });
  };

  // Check if column from current source is already in target
  const isColumnInTarget = (colName) => {
    return targetSchema.some(
      (ac) => ac.originalName === colName && ac.sourceId === sourceId,
    );
  };

  // Generate unique name with prefix if needed
  const getUniqueColumnName = (colName) => {
    if (allSources.length <= 1) {
      return colName;
    }
    // Check if this exact name already exists in target (from different source)
    const nameExists = targetSchema.some(
      (ac) => ac.name === colName && ac.sourceId !== sourceId,
    );
    if (nameExists) {
      // Add source name as prefix
      return `${sourceName}_${colName}`;
    }
    return colName;
  };

  // Move handlers
  const moveSelectedToRight = () => {
    const toMove = beforeColumns.filter((c) => selectedBefore.has(c.name));
    // Filter out columns that are already in target from THIS source
    const newColumns = toMove.filter((c) => !isColumnInTarget(c.originalName));

    if (newColumns.length === 0) {
      setSelectedBefore(new Set());
      return;
    }

    const enriched = newColumns.map((c) => {
      // Convert dot notation to underscore for MongoDB fields
      const convertedName = c.name.replace(/\./g, "_");
      const convertedOriginalName = c.originalName.replace(/\./g, "_");
      const normalizedType = normalizeType(c.type);

      return {
        ...c,
        name: getUniqueColumnName(convertedName),
        originalName: convertedOriginalName,
        type: normalizedType, // ?€??ëª…ì‹œ???¤ì •
        originalType: normalizedType, // ?ë³¸ ?€???€??
        notNull: false,
        defaultValue: "",
        transform: null,
        transformDisplay: null,
        transformChain: [],
        transformOperation: null,
        transformParams: "",
        onError: "Warn",
        sourceId: sourceId,
        sourceName: sourceName,
      };
    });

    onSchemaChange([...targetSchema, ...enriched]);
    setSelectedBefore(new Set());
    if (onTestStatusChange) onTestStatusChange(false);
  };

  const moveAllToRight = () => {
    // Filter out columns that are already in target from THIS source
    const newColumns = beforeColumns.filter(
      (c) => !isColumnInTarget(c.originalName),
    );

    if (newColumns.length === 0) {
      setSelectedBefore(new Set());
      return;
    }

    const enriched = newColumns.map((c) => {
      // Convert dot notation to underscore for MongoDB fields
      const convertedName = c.name.replace(/\./g, "_");
      const convertedOriginalName = c.originalName.replace(/\./g, "_");
      const normalizedType = normalizeType(c.type);

      return {
        ...c,
        name: getUniqueColumnName(convertedName),
        originalName: convertedOriginalName,
        type: normalizedType, // ?€??ëª…ì‹œ???¤ì •
        originalType: normalizedType, // ?ë³¸ ?€???€??
        notNull: false,
        defaultValue: "",
        transform: null,
        transformDisplay: null,
        transformChain: [],
        transformOperation: null,
        transformParams: "",
        onError: "Warn",
        sourceId: sourceId,
        sourceName: sourceName,
      };
    });

    onSchemaChange([...targetSchema, ...enriched]);
    setSelectedBefore(new Set());
    if (onTestStatusChange) onTestStatusChange(false);
  };

  const moveSelectedToLeft = () => {
    // Remove selected columns from targetSchema
    const newSchema = targetSchema.filter((c) => !selectedAfter.has(c.name));
    onSchemaChange(newSchema);
    setSelectedAfter(new Set());
    if (onTestStatusChange) onTestStatusChange(false);
  };

  const moveAllToLeft = () => {
    // Clear all target columns
    onSchemaChange([]);
    setSelectedAfter(new Set());
    if (onTestStatusChange) onTestStatusChange(false);
  };

  // Reorder handlers
  const moveUp = (index) => {
    if (index <= 0) return;
    const next = [...targetSchema];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    onSchemaChange(next);
  };

  const moveDown = (index) => {
    if (index >= targetSchema.length - 1) return;
    const next = [...targetSchema];
    [next[index], next[index + 1]] = [next[index + 1], next[index]];
    onSchemaChange(next);
  };

  // Column property handlers
  const updateColumnProperty = (index, property, value) => {
    const next = [...targetSchema];
    next[index] = { ...next[index], [property]: value };
    onSchemaChange(next);
    if (onTestStatusChange) onTestStatusChange(false);
  };

  // Open transform function editor
  const openFunctionEditor = (column, index) => {
    setEditingColumn({ ...column, index });
    setShowFunctionModal(true);
  };

  // Apply transform function
  const applyTransform = (transformExpr, newName, newType, transformMeta = {}) => {
    if (editingColumn) {
      const next = [...targetSchema];
      const existing = next[editingColumn.index];
      const fallbackOperation = transformMeta.operation || "SQL Expression";
      const fallbackParams = transformMeta.params ?? (fallbackOperation === "SQL Expression" ? transformExpr : "");
      const fallbackStep = {
        display: transformMeta.display || (
          fallbackOperation === "SQL Expression"
            ? transformExpr
            : `${fallbackOperation}${fallbackParams ? `: ${fallbackParams}` : ""}`
        ),
        expression: transformMeta.expression || (fallbackOperation === "SQL Expression" ? transformExpr : ""),
        onError: transformMeta.onError || existing.onError || "Warn",
        operation: fallbackOperation,
        params: fallbackParams,
        type: transformMeta.type || newType || existing.type,
      };
      const rawChain = normalizeTransformChain(
        Array.isArray(transformMeta.chain) && transformMeta.chain.length > 0
          ? transformMeta.chain
          : [fallbackStep],
        newType || transformMeta.type || existing.type,
      );
      const chain = dataTransformChain(rawChain);
      const dataStep = primaryTransformStep(chain);
      const defaultStep = rawChain.find((step) => step.operation === "Default Value");
      const hasNullGuard = rawChain.some((step) => step.operation === "Null Guard");
      const display = chain.map(formatTransformChainStep).filter(Boolean).join(" -> ");
      next[editingColumn.index] = {
        ...existing,
        name: newName || existing.name,
        type: newType || transformMeta.type || existing.type,
        defaultValue: defaultStep ? defaultStep.params : existing.defaultValue,
        notNull: hasNullGuard ? true : existing.notNull,
        onError: dataStep?.onError || transformMeta.onError || existing.onError || "Warn",
        transform: dataStep?.expression || (dataStep?.operation === "SQL Expression" ? dataStep.params : null),
        transformChain: chain,
        transformDisplay: display || null,
        transformOperation: dataStep?.operation || null,
        transformParams: dataStep?.params || "",
      };
      onSchemaChange(next);
      if (onTestStatusChange) onTestStatusChange(false);
    }
    setShowFunctionModal(false);
    setEditingColumn(null);
  };

  // Spark SQL ?€??ë§¤í•‘
  const TYPE_MAP = {
    string: "STRING",
    integer: "INT",
    long: "BIGINT",
    double: "DOUBLE",
    float: "FLOAT",
    boolean: "BOOLEAN",
    timestamp: "TIMESTAMP",
    date: "DATE",
  };

  // Generate SQL from targetSchema (optionally filter by sourceId for testing)
  const generateSql = (filterBySourceId = null) => {
    // If SQL Transform tab and custom SQL is provided, use it
    if (activeTab === "sql" && customSql.trim()) {
      return customSql.trim();
    }

    // Otherwise, generate from Column Selection
    const columnsToUse = filterBySourceId
      ? targetSchema.filter((col) => col.sourceId === filterBySourceId)
      : targetSchema;

    if (columnsToUse.length === 0) return "SELECT * FROM input";

    // For UNION ALL, use the original column names from input DataFrame
    // which already has all columns aligned
    const selectClauses = columnsToUse.map((col) => {
      // Get the source info to check if it's MongoDB
      const source = allSources.find((s) => s.id === col.sourceId);
      const isMongoDB = source?.sourceType === "mongodb";

      // Use originalName for SELECT since that's what exists in the source data
      // For MongoDB, convert dot notation to underscore to match backend conversion
      const columnName = isMongoDB
        ? col.originalName.replace(/\./g, "_")
        : col.originalName;

      if (col.transform) {
        // Quote the alias to handle reserved words
        return `${col.transform} AS "${col.name}"`;
      }

      let expr = `\`${columnName}\``;

      // 1. Type Cast ?ìš© (?€?…ì´ ë³€ê²½ëœ ê²½ìš°?ë§Œ)
      const sparkType = TYPE_MAP[col.type];
      const originalType = col.originalType || "string";
      if (col.type !== originalType && sparkType) {
        expr = `CAST(${expr} AS ${sparkType})`;
      }

      // 2. Default Value ?ìš© (COALESCE)
      if (col.defaultValue && col.defaultValue.trim() !== "") {
        // ?«ìž ?€?…ì´ë©??°ì˜´???†ì´, ?„ë‹ˆë©??°ì˜´?œë¡œ ê°ì‹¸ê¸?
        const isNumericType = ["integer", "long", "double", "float"].includes(
          col.type,
        );
        const defaultVal = isNumericType
          ? col.defaultValue
          : `'${col.defaultValue.replace(/'/g, "''")}'`;

        if (col.type === "string") {
          expr = `COALESCE(NULLIF(${expr}, ''), ${defaultVal})`;
        } else {
          expr = `COALESCE(${expr}, ${defaultVal})`;
        }
      }

      // 3. AS alias ì¶”ê? (ì»¬ëŸ¼ëª?ë³€ê²? CAST, ?ëŠ” COALESCE ?ìš©??ê²½ìš°)
      const typeChanged = col.type !== originalType;
      const needsAlias =
        col.name !== columnName ||
        (col.defaultValue && col.defaultValue.trim() !== "") ||
        typeChanged;
      if (needsAlias) {
        return `${expr} AS "${col.name}"`;
      }

      // Quote column names to handle SQL reserved words (e.g., 'cast', 'type', 'year')
      return expr;
    });

    // NOT NULL ?„í„° ?ìš©
    const notNullCols = columnsToUse.filter((c) => c.notNull);
    let whereClause = "";
    if (notNullCols.length > 0) {
      const conditions = notNullCols.map((col) => {
        const source = allSources.find((s) => s.id === col.sourceId);
        const isMongoDB = source?.sourceType === "mongodb";
        const columnName = isMongoDB
          ? col.originalName.replace(/\./g, "_")
          : col.originalName;
        return `"${columnName}" IS NOT NULL`;
      });
      whereClause = ` WHERE ${conditions.join(" AND ")}`;
    }

    return `SELECT ${selectClauses.join(", ")} FROM input${whereClause}`;
  };

  // Notify parent when visual transform SQL changes
  useEffect(() => {
    if (onSqlChange && activeTab === "columns" && targetSchema.length > 0) {
      const sql = generateSql();
      onSqlChange(sql, "columns");
    }
  }, [targetSchema, activeTab]);

  return (
    <div className="flex flex-col bg-gray-50 rounded-lg border border-gray-200">
      {/* Tab Header */}
      <div className="flex border-b border-slate-200 bg-white rounded-t-lg">
        <button
          onClick={() => setActiveTab("columns")}
          className={`flex-1 px-6 py-3 text-sm font-semibold transition-all border-b-2 ${
            activeTab === "columns"
              ? "text-indigo-700 border-indigo-600 bg-indigo-50/30"
              : "text-slate-600 border-transparent hover:text-slate-900 hover:bg-slate-50"
          }`}
        >
          Visual Transform
        </button>
        <button
          onClick={() => setActiveTab("sql")}
          className={`flex-1 px-6 py-3 text-sm font-semibold transition-all border-b-2 ${
            activeTab === "sql"
              ? "text-indigo-700 border-indigo-600 bg-indigo-50/30"
              : "text-slate-600 border-transparent hover:text-slate-900 hover:bg-slate-50"
          }`}
        >
          SQL Transform
        </button>
      </div>

      {/* Column Selection Tab */}
      {activeTab === "columns" && (
        <div className="flex flex-1 p-4 gap-4 min-h-[500px]">
          {/* Before Schema (Left) */}
          <div className="flex-1 basis-0 flex flex-col bg-white rounded-xl border border-slate-200 shadow-sm transition-all overflow-hidden min-w-0">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/50 flex items-center justify-between">
              <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-2">
                <span className="w-1 h-3 bg-indigo-600 rounded-full"></span>
                Before (Source)
              </h3>
            </div>

            {/* Source tabs for switching between multiple sources */}
            {sourceTabs && (
              <div className="px-3 py-2 border-b border-slate-100 bg-slate-50/30">
                {sourceTabs}
              </div>
            )}
            <div className="flex-1 overflow-y-auto p-2">
              {beforeColumns.length === 0 ? (
                <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                  All columns moved to target
                </div>
              ) : (
                <div className="space-y-1">
                  {beforeColumns.map((col) => {
                    const isInTarget = isColumnInTarget(col.name);
                    const isSelected = selectedBefore.has(col.name);
                    return (
                      <div
                        key={col.name}
                        onClick={() => toggleBeforeSelection(col.name)}
                        className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-all border ${
                          isSelected
                            ? "bg-indigo-50 border-indigo-200 shadow-sm"
                            : "bg-white border-transparent hover:bg-slate-50"
                        }`}
                      >
                        <div
                          className={`w-4 h-4 rounded border transition-colors flex items-center justify-center ${
                            isSelected
                              ? "bg-indigo-600 border-indigo-600"
                              : "bg-white border-slate-300"
                          }`}
                        >
                          {isSelected && (
                            <div className="w-1.5 h-1.5 bg-white rounded-full"></div>
                          )}
                        </div>
                        <div className="flex flex-col min-w-0">
                          <div className="flex items-center gap-2">
                            <span
                              className={`font-semibold text-sm truncate ${isSelected ? "text-indigo-900" : "text-slate-700"}`}
                            >
                              {col.name}
                            </span>
                            {isInTarget && (
                              <span
                                className="w-1.5 h-1.5 rounded-full bg-slate-300 shrink-0"
                                title="Already in target"
                              ></span>
                            )}
                          </div>
                        </div>
                        <span
                          className={`ml-auto px-1.5 py-0.5 text-[10px] font-bold rounded font-mono shrink-0 ${isSelected ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-500"}`}
                        >
                          {col.type}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Move Buttons (Center) */}
          <div className="flex flex-col items-center justify-center gap-2 px-2">
            <button
              onClick={moveSelectedToRight}
              disabled={selectedBefore.size === 0}
              className="p-2 rounded-md bg-white border border-gray-300 hover:bg-blue-50 hover:border-blue-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="Move selected"
            >
              <ChevronRight className="w-5 h-5 text-gray-600" />
            </button>
            <button
              onClick={moveAllToRight}
              disabled={beforeColumns.length === 0}
              className="p-2 rounded-md bg-white border border-gray-300 hover:bg-blue-50 hover:border-blue-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="Move all"
            >
              <ChevronsRight className="w-5 h-5 text-gray-600" />
            </button>
            <div className="h-4" />
            <button
              onClick={moveSelectedToLeft}
              disabled={selectedAfter.size === 0}
              className="p-2 rounded-md bg-white border border-gray-300 hover:bg-red-50 hover:border-red-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              aria-label="Remove selected target columns"
              title="Remove selected target columns"
            >
              <Trash2 className="w-5 h-5 text-gray-600" />
            </button>
            <button
              onClick={moveAllToLeft}
              disabled={targetSchema.length === 0}
              className="p-2 rounded-md bg-white border border-gray-300 hover:bg-red-50 hover:border-red-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              aria-label="Remove all target columns"
              title="Remove all target columns"
            >
              <Trash2 className="w-6 h-6 text-gray-600" />
            </button>
          </div>

          {/* After Schema (Right) */}
          <div className="flex-1 basis-0 flex flex-col bg-white rounded-xl border border-slate-200 shadow-sm transition-all overflow-hidden min-w-0">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/50">
              <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-2">
                <span className="w-1 h-3 bg-indigo-600 rounded-full"></span>
                After (Target)
              </h3>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {targetSchema.length === 0 ? (
                <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                  Select columns from the left
                </div>
              ) : (
                <div className="space-y-2">
                  {targetSchema.map((col, index) => (
                    <div
                      key={`${col.name}-${index}`}
                      className={`p-2.5 rounded-xl border transition-all ${
                        selectedAfter.has(col.name)
                          ? "bg-slate-50 border-indigo-300 shadow-sm ring-1 ring-indigo-300"
                          : "bg-white border-slate-200 hover:border-slate-300"
                      }`}
                    >
                      {/* Column Header */}
                      <div className="flex items-center gap-2 mb-2">
                        <div
                          onClick={() => toggleAfterSelection(col.name)}
                          className={`w-4 h-4 rounded border transition-colors flex items-center justify-center cursor-pointer ${
                            selectedAfter.has(col.name)
                              ? "bg-indigo-600 border-indigo-600"
                              : "bg-white border-slate-300 hover:border-indigo-400"
                          }`}
                        >
                          {selectedAfter.has(col.name) && (
                            <div className="w-1.5 h-1.5 bg-white rounded-full"></div>
                          )}
                        </div>
                        <input
                          type="text"
                          value={col.name}
                          onChange={(e) =>
                            updateColumnProperty(index, "name", e.target.value)
                          }
                          className="flex-1 px-1.5 py-1 text-sm font-semibold text-slate-900 bg-white border border-slate-200 rounded-md focus:outline-none focus:border-indigo-500 transition-colors"
                        />
                        <select
                          value={col.type}
                          onChange={(e) =>
                            updateColumnProperty(index, "type", e.target.value)
                          }
                          className="px-1 py-1 text-[10px] font-bold border border-slate-200 rounded-md bg-white text-slate-700 focus:outline-none focus:border-indigo-500 transition-colors"
                        >
                          <option value="string">string</option>
                          <option value="integer">integer</option>
                          <option value="long">long</option>
                          <option value="double">double</option>
                          <option value="boolean">boolean</option>
                          <option value="timestamp">timestamp</option>
                          <option value="date">date</option>
                        </select>
                        {/* Transform Function Button */}
                        <button
                          onClick={() => openFunctionEditor(col, index)}
                          className={`p-1.5 rounded transition-colors ${
                            col.transform || col.transformOperation || dataTransformChain(col.transformChain).length
                              ? "bg-purple-100 text-purple-600 hover:bg-purple-200"
                              : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                          }`}
                          title="Add transform function"
                        >
                          <Braces className="w-4 h-4" />
                        </button>
                        {/* Reorder Buttons */}
                        <button
                          onClick={() => moveUp(index)}
                          disabled={index === 0}
                          className="p-1 rounded hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          <ChevronUp className="w-4 h-4 text-gray-500" />
                        </button>
                        <button
                          onClick={() => moveDown(index)}
                          disabled={index === targetSchema.length - 1}
                          className="p-1 rounded hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          <ChevronDown className="w-4 h-4 text-gray-500" />
                        </button>
                      </div>

                      {/* Column Options */}
                      <div className="flex items-center gap-4 ml-6 text-xs">
                        {/* Not Null Toggle */}
                        <label className="flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={col.notNull || false}
                            onChange={(e) =>
                              updateColumnProperty(
                                index,
                                "notNull",
                                e.target.checked,
                              )
                            }
                            className="w-3.5 h-3.5 text-blue-600 rounded focus:ring-blue-500"
                          />
                          <span className="text-gray-600">NOT NULL</span>
                        </label>

                        {/* Default Value */}
                        <label className="flex items-center gap-1.5">
                          <span className="text-gray-500">Default:</span>
                          <input
                            type="text"
                            value={col.defaultValue || ""}
                            onChange={(e) =>
                              updateColumnProperty(
                                index,
                                "defaultValue",
                                e.target.value,
                              )
                            }
                            placeholder="NULL"
                            className="w-20 px-1.5 py-0.5 border border-gray-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                          />
                        </label>

                        {/* Transform Display */}
                        {col.transformDisplay && (
                          <span className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded text-xs font-mono">
                            fx: {col.transformDisplay}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* SQL Transform Tab */}
      {activeTab === "sql" && (
        <div className="flex flex-1 p-4 gap-4 min-h-[500px]">
          {/* Left: Source Panel (Read-only reference) */}
          <div className="w-1/3 flex flex-col bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/50">
              <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-2">
                <span className="w-1 h-3 bg-indigo-600 rounded-full"></span>
                Available Sources
              </h3>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {allSources && allSources.length > 0 ? (
                <div className="space-y-4">
                  {allSources.map((source, idx) => (
                    <div
                      key={source.id || idx}
                      className="border border-slate-200 rounded-lg p-3 bg-slate-50/30"
                    >
                      <h4 className="text-sm font-semibold text-slate-900 mb-2">
                        {source.name}
                      </h4>
                      {source.schema && source.schema.length > 0 ? (
                        <ul className="space-y-1">
                          {source.schema.map((col, colIdx) => (
                            <li
                              key={colIdx}
                              className="flex items-center justify-between text-xs"
                            >
                              <span className="text-slate-700 font-mono">
                                {col.name}
                              </span>
                              <span className="text-slate-500 text-[10px]">
                                {col.type}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-xs text-slate-400 italic">
                          No schema available
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex items-center justify-center h-full text-slate-400 text-sm">
                  No sources available
                </div>
              )}
            </div>
          </div>

          {/* Right: SQL Editor */}
          <div className="flex-1 flex flex-col bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/50 flex items-center justify-between">
              <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-2">
                <span className="w-1 h-3 bg-purple-600 rounded-full"></span>
                SQL Query Editor
              </h3>
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
            <div className="flex-1 flex flex-col p-4">
              {/* AI Input Panel - appears between header and textarea */}
              {showAI && (
                <InlineAIInput
                  promptType="sql_transform"
                  metadata={{
                    sources: allSources.map((s) => ({
                      name: s.name,
                      schema: s.schema || [],
                    })),
                  }}
                  placeholder="e.g., join tables, aggregate data, filter rows..."
                  onApply={(suggestion) => {
                    setCustomSql(suggestion);
                    setShowAI(false);
                  }}
                  onCancel={() => setShowAI(false)}
                />
              )}

              <textarea
                value={customSql}
                onChange={(e) => setCustomSql(e.target.value)}
                placeholder="SELECT id, name FROM input"
                className="flex-1 px-4 py-3 border border-slate-200 rounded-lg font-mono text-sm text-slate-800 placeholder-slate-400 focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
                style={{
                  fontFamily: 'Consolas, Monaco, "Courier New", monospace',
                  minHeight: "300px",
                }}
              />
              <div className="mt-3 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                <p className="text-xs text-blue-800">
                  <strong>Advanced SQL Transform:</strong> Write complex queries
                  with JOIN, GROUP BY, and aggregations. Note that previews run
                  on <strong>DuckDB</strong> for fast feedback, while the actual
                  ETL executes on <strong>Spark SQL</strong> for scale.
                  Reference sources by their dataset names.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Transform Function Modal */}
      {showFunctionModal && editingColumn && (
        <TransformFunctionModal
          column={editingColumn}
          onApply={applyTransform}
          onClose={() => {
            setShowFunctionModal(false);
            setEditingColumn(null);
          }}
        />
      )}
    </div>
  );
}
