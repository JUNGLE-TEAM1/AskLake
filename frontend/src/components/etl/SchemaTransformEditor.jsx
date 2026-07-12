import React, { useState, useEffect, useRef } from "react";
import {
  ChevronRight,
  ChevronsRight,
  ChevronUp,
  ChevronDown,
  AlertCircle,
  CheckCircle2,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Search,
  Sparkles,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import TransformFunctionModal from "./TransformFunctionModal";
import InlineAIInput from "../ai/InlineAIInput";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { PanelHeader } from "@/components/ui/panel";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { apiConfig } from "@/services/apiClient";
import askLakeNessiIconUrl from "../../assets/asklake-nessi-icon.png";

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

const dataTypeBadgeClass = (type) => {
  const normalized = normalizeType(type);
  if (["integer", "long", "float", "double", "decimal", "number"].includes(normalized)) {
    return "border-blue-200 bg-blue-50 text-blue-700";
  }
  if (["date", "timestamp", "datetime", "time"].includes(normalized)) {
    return "border-teal-200 bg-teal-50 text-teal-700";
  }
  if (["boolean", "bool"].includes(normalized)) {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  if (["array", "map", "struct", "object", "json"].includes(normalized)) {
    return "border-slate-200 bg-slate-100 text-slate-700";
  }
  return "border-sky-200 bg-sky-50 text-sky-700";
};

const DataTypeBadge = ({ type }) => (
  <Badge
    className={`shrink-0 font-mono ${dataTypeBadgeClass(type)}`}
    shape="compact"
    size="sm"
    variant="outline"
  >
    {normalizeType(type)}
  </Badge>
);

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
  sourceSampleRows = [],
  sourceName = "Source",
  sourceId,
  sourceDatasetId,
  targetSchema = [],
  qualityRules = [],
  onSchemaChange,
  onQualityRulesChange,
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
  const [sourceQuery, setSourceQuery] = useState("");
  const [sourceType, setSourceType] = useState("all");
  const [sqlSourceQuery, setSqlSourceQuery] = useState("");
  const [sqlSourceCollapsed, setSqlSourceCollapsed] = useState(false);
  const [showSqlAssistant, setShowSqlAssistant] = useState(false);
  const [sqlPreviewVisible, setSqlPreviewVisible] = useState(false);
  const [sqlValidation, setSqlValidation] = useState({ tone: "idle", message: "SQL을 작성한 뒤 문법을 검증하세요." });
  const lastVisualSqlRef = useRef("");

  const sourceTypes = [...new Set(beforeColumns.map((column) => column.type))].sort();
  const filteredBeforeColumns = beforeColumns.filter((column) => {
    const matchesQuery = column.name.toLowerCase().includes(sourceQuery.trim().toLowerCase());
    const matchesType = sourceType === "all" || column.type === sourceType;
    return matchesQuery && matchesType;
  });
  const filteredSqlSources = sourceSchema.filter((column) => {
    const name = String(column.name || column.field || "");
    return name.toLowerCase().includes(sqlSourceQuery.trim().toLowerCase());
  });

  const validateCustomSql = () => {
    const normalized = customSql.trim().toLowerCase();
    if (!normalized.startsWith("select")) {
      setSqlValidation({ tone: "error", message: "SELECT 문으로 시작해야 합니다." });
      return false;
    }
    if (!/\bfrom\s+input\b/i.test(customSql)) {
      setSqlValidation({ tone: "error", message: "소스 테이블은 FROM input으로 참조해야 합니다." });
      return false;
    }
    setSqlValidation({ tone: "success", message: "Spark SQL 기본 문법과 input 참조를 확인했습니다." });
    return true;
  };

  const insertSqlColumn = (columnName) => {
    const editor = document.getElementById("schema-sql-transform-editor");
    if (!editor) return;
    const start = editor.selectionStart ?? customSql.length;
    const end = editor.selectionEnd ?? start;
    const nextSql = `${customSql.slice(0, start)}${columnName}${customSql.slice(end)}`;
    setCustomSql(nextSql);
    window.requestAnimationFrame(() => {
      editor.focus();
      editor.setSelectionRange(start + columnName.length, start + columnName.length);
    });
  };

  const runSqlPreview = () => {
    if (!validateCustomSql()) return;
    setSqlPreviewVisible(true);
  };

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
    } else {
      setBeforeColumns([]);
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
          type: normalizedType,
          notNull: col.notNull || false,
          defaultValue: col.defaultValue || "",
          transform: visibleStep?.expression || (visibleStep?.operation === "SQL Expression" ? visibleStep.params : col.transform || null),
          transformDisplay: visibleDisplay || (visibleStep ? col.transformDisplay : null) || (col.transform ? `${col.transform}` : null),
          transformChain: visibleChain,
          transformOperation: visibleStep?.operation || col.transformOperation || null,
          transformParams: visibleStep?.params || col.transformParams || "",
          onError: col.onError || "Warn",
          originalName: col.originalName || col.name,
          originalType: normalizeType(col.originalType) || normalizedType,
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

  const targetColumnKey = (column) => `${column.sourceId || sourceId || "source"}:${String(column.originalName || column.name).replace(/\./g, "_")}`;

  // Check if column from current source is already in target
  const isColumnInTarget = (colName) => {
    const normalizedName = String(colName).replace(/\./g, "_");
    return targetSchema.some(
      (ac) => String(ac.originalName || ac.name).replace(/\./g, "_") === normalizedName && ac.sourceId === sourceId,
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
      const normalizedType = normalizeType(c.type);

      return {
        ...c,
        name: getUniqueColumnName(convertedName),
        originalName: c.originalName,
        type: normalizedType,
        originalType: normalizedType,
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
      const normalizedType = normalizeType(c.type);

      return {
        ...c,
        name: getUniqueColumnName(convertedName),
        originalName: c.originalName,
        type: normalizedType,
        originalType: normalizedType,
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
    const newSchema = targetSchema.filter((c) => !selectedAfter.has(targetColumnKey(c)));
    onSchemaChange(newSchema);
    setSelectedAfter(new Set());
    if (onTestStatusChange) onTestStatusChange(false);
  };

  const toggleAllTargetColumns = (checked) => {
    setSelectedAfter(checked ? new Set(targetSchema.map(targetColumnKey)) : new Set());
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

  const syncColumnQualityRules = (existing, nextName, nextRules) => {
    if (!onQualityRulesChange || !Array.isArray(nextRules)) return;
    const aliases = new Set([existing.name, existing.originalName].filter(Boolean));
    const retainedRules = qualityRules.filter((rule) => !aliases.has(rule.targetColumn));
    onQualityRulesChange([
      ...retainedRules,
      ...nextRules.map((rule) => ({ ...rule, targetColumn: nextName })),
    ]);
  };

  // Apply transform function
  const applyTransform = (transformExpr, newName, newType, transformMeta = {}) => {
    if (editingColumn) {
      const next = [...targetSchema];
      const existing = next[editingColumn.index];
      const nextName = newName || existing.name;
      syncColumnQualityRules(existing, nextName, transformMeta.qualityRules);
      if (transformMeta.mode === "csvMultiOutput" && Array.isArray(transformMeta.columns)) {
        const sourceField = transformMeta.sourceField || existing.originalName || existing.sourceName || existing.name || newName;
        const outputColumns = transformMeta.columns
          .map((column, columnIndex) => {
            const method = column.method || "copy";
            const isOneOfValues = method === "one_of_values";
            const fallbackAllowed = isOneOfValues && Boolean(column.fallbackAllowed || column.allowFallback);
            const modelArtifact = isOneOfValues ? column.modelArtifact || column.selectedModelArtifact || "" : "";
            const modelId = isOneOfValues ? column.modelId || column.selectedModelId || "" : "";
            return {
              allowedValues: Array.isArray(column.allowedValues) ? column.allowedValues : [],
              fallbackAllowed,
              instruction: column.instruction || "",
              method,
              modelArtifact,
              modelId,
              modelSelectionPolicy: isOneOfValues ? (column.modelSelectionPolicy || (modelArtifact || modelId ? "explicit" : "auto")) : "none",
              nullable: column.nullable !== false,
              requireModel: isOneOfValues && !fallbackAllowed,
              targetName: String(column.targetName || `column_${columnIndex + 1}`).trim().replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || `column_${columnIndex + 1}`,
              type: column.type || "String",
            };
          })
          .filter((column, columnIndex, columns) => column.targetName && columns.findIndex((item) => item.targetName === column.targetName) === columnIndex);
        if (outputColumns.length > 0) {
          const params = JSON.stringify({ columns: outputColumns, sourceField, version: 1 });
          const expansionId = existing.expansionId
            || transformMeta.expansionId
            || `text-row-${sourceField}-${Date.now().toString(36)}`;
          const generated = outputColumns.map((column, columnIndex) => ({
            defaultValue: existing.defaultValue || "",
            expansionId,
            expandedFrom: sourceField,
            expandedIndex: columnIndex + 1,
            expandedTotal: outputColumns.length,
            included: true,
            name: column.targetName,
            nullable: column.nullable,
            notNull: existing.notNull || false,
            originalName: sourceField,
            originalType: existing.originalType || existing.type,
            role: `text-row-analysis:${column.instruction || column.targetName}`,
            sourceId: existing.sourceId,
            sourceName: `__text_analysis.${column.targetName}`,
            targetName: column.targetName,
            reviewAnalysisMethod: column.method,
            reviewAnalysisAllowedValues: column.allowedValues || [],
            reviewAnalysisFallbackAllowed: Boolean(column.fallbackAllowed),
            reviewAnalysisModelArtifact: column.modelArtifact || "",
            reviewAnalysisModelId: column.modelId || "",
            reviewAnalysisModelSelectionPolicy: column.modelSelectionPolicy || "none",
            reviewAnalysisRequireModel: Boolean(column.requireModel),
            reviewAnalysisInstruction: column.instruction || "",
            transform: `TEXT_ANALYZE(${sourceField}).${column.targetName}`,
            transformChain: [{
              display: `Text row -> ${column.targetName}`,
              expression: `TEXT_ANALYZE(${sourceField}).${column.targetName}`,
              onError: transformMeta.onError || "Warn",
              operation: transformMeta.operation || "Text Row Analysis",
              params,
              type: column.type,
            }],
            transformDisplay: `Text row -> ${column.targetName}`,
            transformOperation: transformMeta.operation || "Text Row Analysis",
            transformParams: params,
            type: column.type,
          }));
          const groupIndexes = existing.expansionId
            ? next.map((item, itemIndex) => (item.expansionId === existing.expansionId ? itemIndex : -1)).filter((itemIndex) => itemIndex >= 0)
            : existing.expandedFrom
              ? next
                .map((item, itemIndex) => (
                  item.expandedFrom === existing.expandedFrom && String(item.sourceName || "").startsWith("__text_analysis.")
                    ? itemIndex
                    : -1
                ))
                .filter((itemIndex) => itemIndex >= 0)
              : [editingColumn.index];
          const replaceStartIndex = Math.min(...groupIndexes, editingColumn.index);
          const filtered = next.filter((_, itemIndex) => !groupIndexes.includes(itemIndex));
          filtered.splice(Math.min(replaceStartIndex, filtered.length), 0, ...generated);
          onSchemaChange(filtered);
          if (onTestStatusChange) onTestStatusChange(false);
          setShowFunctionModal(false);
          setEditingColumn(null);
          return;
        }
      }
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
        name: nextName,
        type: newType || transformMeta.type || existing.type,
        defaultValue: defaultStep ? defaultStep.params : existing.defaultValue,
        notNull: typeof transformMeta.required === "boolean" ? transformMeta.required : hasNullGuard ? true : existing.notNull,
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

  // Spark SQL type mapping
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

      // Apply an explicit cast only when the type changed.
      const sparkType = TYPE_MAP[col.type];
      const originalType = col.originalType || "string";
      if (col.type !== originalType && sparkType) {
        expr = `CAST(${expr} AS ${sparkType})`;
      }

      // Apply default values with COALESCE.
      if (col.defaultValue && col.defaultValue.trim() !== "") {
        // Quote non-numeric default values.
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

      // Add an alias when the expression or output name changed.
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

    // Apply NOT NULL filters.
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
      if (lastVisualSqlRef.current === sql) return;
      lastVisualSqlRef.current = sql;
      onSqlChange(sql, "columns");
    }
  }, [targetSchema, activeTab]);

  return (
    <div className="flex flex-col overflow-hidden bg-gray-50 rounded-lg border border-gray-200">
      <PanelHeader
        className="min-h-[68px] px-5 py-3.5"
        icon={<SlidersHorizontal />}
        title="변환 설정"
      />
      {/* Tab Header */}
      <div className="flex border-b border-slate-200 bg-white">
        <button
          onClick={() => setActiveTab("columns")}
          className={`flex-1 px-6 py-3.5 text-base font-semibold transition-all border-b-2 ${
            activeTab === "columns"
              ? "text-blue-700 border-blue-600 bg-blue-50/60"
              : "text-slate-600 border-transparent hover:text-blue-700 hover:bg-blue-50/40"
          }`}
        >
          비주얼 변환
        </button>
        <button
          onClick={() => setActiveTab("sql")}
          className={`flex-1 px-6 py-3.5 text-base font-semibold transition-all border-b-2 ${
            activeTab === "sql"
              ? "text-blue-700 border-blue-600 bg-blue-50/60"
              : "text-slate-600 border-transparent hover:text-blue-700 hover:bg-blue-50/40"
          }`}
        >
          SQL 변환
        </button>
      </div>

      {/* Column Selection Tab */}
      {activeTab === "columns" && (
        <div className="flex flex-1 p-4 gap-4 min-h-[500px]">
          {/* Before Schema (Left) */}
          <div className="flex-1 basis-0 flex flex-col bg-white rounded-xl border-2 border-blue-300 shadow-sm transition-all overflow-hidden min-w-0 focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100">
            <div className="flex items-center justify-between border-b border-blue-200 bg-blue-50 px-4 py-3.5">
              <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-blue-950">
                <span className="w-1 h-3 bg-blue-600 rounded-full"></span>
                Before (Source)
              </h3>
              <span className="text-xs font-bold text-blue-700">{beforeColumns.length}개 컬럼</span>
            </div>

            {/* Source tabs for switching between multiple sources */}
            {sourceTabs && (
              <div className="px-3 py-2 border-b border-slate-100 bg-slate-50/30">
                {sourceTabs}
              </div>
            )}
            <div className="grid grid-cols-[minmax(0,1fr)_132px] gap-2 border-b border-slate-100 bg-white p-3">
              <label className="relative min-w-0">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
                <input
                  type="search"
                  value={sourceQuery}
                  onChange={(event) => setSourceQuery(event.target.value)}
                  placeholder="컬럼 검색"
                  className="h-9 w-full rounded-md border border-slate-200 bg-white pl-9 pr-3 text-sm font-semibold text-slate-800 outline-none transition-colors placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                />
              </label>
              <Select value={sourceType} onValueChange={setSourceType}>
                <SelectTrigger aria-label="소스 컬럼 타입 필터" className="h-9 w-full bg-white text-sm font-semibold">
                  <SelectValue placeholder="모든 타입" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">모든 타입</SelectItem>
                  {sourceTypes.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-[28px_minmax(0,1fr)_110px] items-center border-b border-slate-100 bg-slate-50/60 px-3 py-2 text-[11px] font-bold uppercase text-slate-500">
              <span />
              <span>컬럼</span>
              <span className="text-right">타입</span>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {filteredBeforeColumns.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm font-semibold text-slate-400">
                  검색 조건에 맞는 컬럼이 없습니다.
                </div>
              ) : (
                <div className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white">
                  {filteredBeforeColumns.map((col) => {
                    const isInTarget = isColumnInTarget(col.name);
                    const isSelected = selectedBefore.has(col.name);
                    return (
                      <div
                        key={col.name}
                        onClick={() => toggleBeforeSelection(col.name)}
                        className={`grid min-h-11 cursor-pointer grid-cols-[28px_minmax(0,1fr)_110px] items-center px-3 py-2 transition-colors ${
                          isSelected
                            ? "bg-blue-50"
                            : "bg-white hover:bg-slate-50"
                        }`}
                      >
                        <Checkbox
                          aria-label={`${col.name} 소스 컬럼 선택`}
                          checked={isSelected}
                          onClick={(event) => event.stopPropagation()}
                          onCheckedChange={() => toggleBeforeSelection(col.name)}
                        />
                        <div className="flex min-w-0 items-center gap-2 pr-3">
                          <span className={`truncate text-sm font-bold ${isSelected ? "text-blue-950" : "text-slate-900"}`}>
                            {col.name}
                          </span>
                          {isInTarget && <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" title="타겟 포함" />}
                        </div>
                        <span className="justify-self-end"><DataTypeBadge type={col.type} /></span>
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
              className="rounded-md border-2 border-blue-400 bg-blue-50 p-2 text-blue-700 shadow-sm transition-colors hover:border-blue-600 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
              title="Move selected"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
            <button
              onClick={moveAllToRight}
              disabled={beforeColumns.length === 0}
              className="rounded-md border-2 border-blue-400 bg-blue-50 p-2 text-blue-700 shadow-sm transition-colors hover:border-blue-600 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
              title="Move all"
            >
              <ChevronsRight className="w-5 h-5" />
            </button>
            <div className="h-4" />
            <button
              onClick={moveSelectedToLeft}
              disabled={selectedAfter.size === 0}
              className="rounded-md border-2 border-red-400 bg-red-50 p-2 text-red-600 shadow-sm transition-colors hover:border-red-600 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Remove selected target columns"
              title="Remove selected target columns"
            >
              <Trash2 className="w-5 h-5" />
            </button>
          </div>

          {/* After Schema (Right) */}
          <div className="flex-1 basis-0 flex flex-col bg-white rounded-xl border-2 border-blue-300 shadow-sm transition-all overflow-hidden min-w-0 focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100">
            <div className="flex items-center justify-between gap-3 border-b border-blue-200 bg-blue-50 px-4 py-3.5">
              <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-blue-950">
                <span className="w-1 h-3 bg-blue-600 rounded-full"></span>
                After (Target)
              </h3>
              <div className="flex items-center gap-3">
                <span className="text-xs font-bold text-blue-700">{targetSchema.length}개 컬럼</span>
                <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-slate-600">
                <Checkbox
                  aria-label="전체 타겟 컬럼 선택"
                  checked={targetSchema.length > 0 && selectedAfter.size === targetSchema.length ? true : selectedAfter.size > 0 ? "indeterminate" : false}
                  disabled={targetSchema.length === 0}
                  onCheckedChange={(checked) => toggleAllTargetColumns(checked === true)}
                />
                전체 선택
                </label>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {targetSchema.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm font-semibold text-slate-400">
                  왼쪽에서 출력할 컬럼을 선택하세요.
                </div>
              ) : (
                <div className="space-y-2">
                  {targetSchema.map((col, index) => (
                    <div
                      key={targetColumnKey(col)}
                      className={`rounded-lg border px-3 py-2.5 transition-all ${
                        selectedAfter.has(targetColumnKey(col))
                          ? "bg-slate-50 border-blue-300 shadow-sm ring-1 ring-blue-300"
                          : col.expandedFrom
                            ? "bg-blue-50/60 border-blue-200 hover:border-blue-300"
                            : "bg-white border-slate-200 hover:border-slate-300"
                      }`}
                    >
                      {/* Column Header */}
                      <div className="flex items-center gap-2 mb-2">
                        <Checkbox
                          aria-label={`${col.name} 선택`}
                          checked={selectedAfter.has(targetColumnKey(col))}
                          onCheckedChange={() => toggleAfterSelection(targetColumnKey(col))}
                        />
                        {col.expandedFrom && (
                          <span className="shrink-0 rounded-full bg-blue-100 px-2 py-1 text-[10px] font-bold text-blue-700" title={`Expanded from ${col.expandedFrom}`}>
                            expanded {col.expandedIndex || index + 1}/{col.expandedTotal || 1}
                          </span>
                        )}
                        <input
                          type="text"
                          value={col.name}
                          onChange={(e) =>
                            updateColumnProperty(index, "name", e.target.value)
                          }
                          className="flex-1 px-1.5 py-1 text-sm font-semibold text-slate-900 bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 transition-colors"
                        />
                        <DataTypeBadge type={col.type} />
                        {/* Field Rule Button */}
                        <button
                          onClick={() => openFunctionEditor(col, index)}
                          className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-bold transition-colors ${
                            col.transform || col.transformOperation || dataTransformChain(col.transformChain).length
                              ? "border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100"
                              : "border-slate-200 bg-white text-slate-600 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
                          }`}
                          aria-label={`${col.name} 필드 규칙 설정`}
                          title="필드 규칙 설정"
                        >
                          <SlidersHorizontal className="h-3.5 w-3.5" />
                          필드 규칙
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
        <div className="flex flex-1 flex-col gap-4 p-4 min-h-[500px]">
          <div className={`grid min-h-[360px] gap-4 ${sqlSourceCollapsed ? "grid-cols-[52px_minmax(0,1fr)]" : "grid-cols-[minmax(220px,28%)_minmax(0,1fr)]"}`}>
            <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
              <div className={`flex items-center border-b border-slate-200 bg-slate-50/50 px-3 py-3 ${sqlSourceCollapsed ? "justify-center" : "justify-between gap-3"}`}>
                {!sqlSourceCollapsed && (
                  <h3 className="flex items-center gap-2 text-sm font-bold text-slate-900">
                    <span className="h-3 w-1 rounded-full bg-blue-600" />
                    소스 스키마
                  </h3>
                )}
                <button
                  type="button"
                  onClick={() => setSqlSourceCollapsed((current) => !current)}
                  className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                  aria-label={sqlSourceCollapsed ? "소스 스키마 펼치기" : "소스 스키마 접기"}
                  title={sqlSourceCollapsed ? "소스 스키마 펼치기" : "소스 스키마 접기"}
                >
                  {sqlSourceCollapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
                </button>
              </div>
              {!sqlSourceCollapsed && (
                <>
                  <div className="border-b border-slate-100 p-3">
                    <label className="relative block">
                      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
                      <input
                        type="search"
                        value={sqlSourceQuery}
                        onChange={(event) => setSqlSourceQuery(event.target.value)}
                        placeholder="컬럼 검색"
                        className="h-9 w-full rounded-md border border-slate-200 bg-white pl-9 pr-3 text-sm font-semibold text-slate-800 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                      />
                    </label>
                  </div>
                  <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/50 px-3 py-2 text-[11px] font-bold text-slate-500">
                <span>{apiConfig.useMock ? `확인용 ${String(allSources?.[0]?.name || sourceName).toUpperCase()}` : String(allSources?.[0]?.name || sourceName).toUpperCase()}</span>
                    <span>{filteredSqlSources.length}개 컬럼</span>
                  </div>
                  <div className="flex-1 overflow-y-auto">
                    {filteredSqlSources.length > 0 ? filteredSqlSources.map((column, index) => {
                      const name = column.name || column.field;
                      return (
                        <button
                          key={`${name}-${index}`}
                          type="button"
                          onClick={() => insertSqlColumn(name)}
                          className="flex w-full items-center justify-between gap-3 border-b border-slate-100 px-3 py-2.5 text-left transition-colors hover:bg-blue-50"
                          title={`${name} 삽입`}
                        >
                          <span className="min-w-0 truncate font-mono text-sm font-semibold text-slate-800">{name}</span>
                          <DataTypeBadge type={column.type} />
                        </button>
                      );
                    }) : (
                      <div className="grid h-full place-items-center p-6 text-sm font-semibold text-slate-400">일치하는 컬럼이 없습니다.</div>
                    )}
                  </div>
                </>
              )}
            </section>

            <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/50 px-4 py-3">
                <h3 className="flex items-center gap-2 text-sm font-bold text-slate-900">
                  <span className="h-3 w-1 rounded-full bg-blue-600" />
                  SQL 변환
                </h3>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowSqlAssistant((current) => !current)}
                    className="inline-flex h-9 items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 text-sm font-bold text-blue-700 hover:bg-blue-100"
                  >
                    <img alt="" aria-hidden="true" className="size-5 rounded-full object-cover" src={askLakeNessiIconUrl} />
                    Nessie로 작성
                  </button>
                  <button
                    type="button"
                    onClick={validateCustomSql}
                    className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 hover:bg-slate-50"
                  >
                    <CheckCircle2 className="size-4" /> 문법 검증
                  </button>
                  <button
                    type="button"
                    onClick={runSqlPreview}
                    className="inline-flex h-9 items-center gap-2 rounded-md bg-blue-600 px-3 text-sm font-bold text-white hover:bg-blue-700"
                  >
                    <Play className="size-4" /> 미리보기 실행
                  </button>
                </div>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
                {showSqlAssistant && (
                  <div className="rounded-lg border border-blue-200 bg-blue-50/40 p-3">
                    <div className="mb-2 flex items-center gap-2 text-sm font-bold text-slate-900">
                      <img alt="" aria-hidden="true" className="size-6 rounded-full object-cover" src={askLakeNessiIconUrl} />
                      Nessie에게 원하는 변환을 설명하세요
                    </div>
                    <InlineAIInput
                      engine="spark"
                      metadata={{
                        columns: sourceSchema.map((column) => ({ name: column.name || column.field, type: column.type })),
                        source: "input",
                      }}
                      onApply={(sql) => {
                        setCustomSql(sql);
                        setShowSqlAssistant(false);
                        setSqlValidation({ tone: "idle", message: "Nessie가 작성한 SQL을 검증해 주세요." });
                      }}
                      onCancel={() => setShowSqlAssistant(false)}
                      placeholder="예: sentiment별 리뷰 수와 평균 심각도를 계산해줘"
                      promptType="sql_transform"
                    />
                  </div>
                )}
                <div className="flex min-h-[250px] flex-1 flex-col overflow-hidden rounded-lg border-2 border-blue-400 bg-white shadow-sm transition-shadow focus-within:border-blue-500 focus-within:ring-4 focus-within:ring-blue-100">
                  <div className="flex items-center justify-between gap-3 border-b border-blue-200 bg-blue-50 px-4 py-2 text-xs font-semibold text-blue-900">
                    <span className="inline-flex items-center gap-2"><span className="size-2 rounded-full bg-blue-500" />Spark SQL</span>
                    <span>현재 소스 · SQL 별칭 <code className="font-mono font-bold text-blue-950">input</code></span>
                  </div>
                  <Textarea
                    id="schema-sql-transform-editor"
                    value={customSql}
                    onChange={(event) => {
                      setCustomSql(event.target.value);
                      setSqlPreviewVisible(false);
                      setSqlValidation({ tone: "idle", message: "변경된 SQL을 다시 검증하세요." });
                    }}
                    placeholder="SELECT text, sentiment FROM input"
                    className="min-h-[210px] flex-1 resize-none rounded-none border-0 bg-white px-4 py-4 font-mono text-sm font-semibold leading-6 text-slate-950 caret-blue-600 shadow-none outline-none placeholder:text-slate-400 focus-visible:ring-0"
                  />
                </div>
                <div className={`flex min-h-9 items-center justify-center gap-2 rounded-md px-3 text-center text-sm font-semibold ${sqlValidation.tone === "error" ? "bg-red-50 text-red-600" : sqlValidation.tone === "success" ? "bg-emerald-50 text-emerald-700" : "bg-blue-50/60 text-slate-600"}`}>
                  {sqlValidation.tone === "error" ? <AlertCircle className="size-4" /> : sqlValidation.tone === "success" ? <CheckCircle2 className="size-4" /> : <Sparkles className="size-4" />}
                  {sqlValidation.message}
                </div>
              </div>
            </section>
          </div>

          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/50 px-4 py-3">
              <h3 className="text-sm font-bold text-slate-900">결과 미리보기</h3>
              <span className="text-xs font-semibold text-slate-500">최대 {Math.min(sourceSampleRows.length, 10)}개 행</span>
            </div>
            {sqlPreviewVisible && sourceSampleRows.length > 0 ? (
              <div className="overflow-auto">
                <table className="w-full min-w-[720px] border-collapse text-sm">
                  <thead className="bg-slate-50 text-left text-xs font-bold text-slate-500">
                    <tr>{sourceSchema.map((column) => <th key={column.name || column.field} className="border-b border-slate-200 px-4 py-3">{column.name || column.field}</th>)}</tr>
                  </thead>
                  <tbody>
                    {sourceSampleRows.slice(0, 10).map((row, rowIndex) => (
                      <tr key={rowIndex} className="border-b border-slate-100 last:border-0">
                        {sourceSchema.map((column, columnIndex) => <td key={`${column.name || column.field}-${columnIndex}`} className="max-w-64 truncate px-4 py-3 font-medium text-slate-800">{String(row[columnIndex] ?? "-")}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="flex min-h-32 items-center justify-center px-6 py-8 text-center text-sm font-semibold text-slate-400">
                <span>{sqlPreviewVisible ? "표시할 샘플 행이 없습니다." : "SQL을 검증한 뒤 미리보기를 실행하세요."}</span>
              </div>
            )}
          </section>
        </div>
      )}

      {/* Transform Function Modal */}
      {showFunctionModal && editingColumn && (
        <TransformFunctionModal
          column={editingColumn}
          qualityRules={qualityRules}
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
