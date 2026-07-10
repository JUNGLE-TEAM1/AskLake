import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  Database,
  Download,
  PanelLeftClose,
  PanelLeftOpen,
  PlayCircle,
  RotateCcw,
  Search,
  Sparkles,
  Table2,
} from "lucide-react";
import { ActionGroup } from "@/components/ui/action-group";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { FilterToolbarInput, FilterToolbarSearch } from "@/components/ui/filter-toolbar";
import { FormFieldGroup, NativeSelectField } from "@/components/ui/form-field-group";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { Panel } from "@/components/ui/panel";
import { ResultPanel } from "@/components/ui/preview-panel";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { executeQueryPreview } from "../../services/mockApi";
import {
  generateQueryAiSuggestion,
  type QueryAiSuggestion,
} from "../../services/queryAiService";
import type { AuditResult, CatalogDataset, CreateDerivedDatasetRequest, DashboardEntry, DerivedDatasetLayer, SqlResultDraft } from "../../types";
import { DashboardPage } from "../dashboard/DashboardPage";
import { SqlDatasetTree } from "./SqlDatasetRow";
import { SqlPreviewTable } from "./SqlPreviewTable";
import { SchemaDetailsPanel } from "./SqlSchemaPanel";
import {
  PREVIEW_ROW_LIMIT,
  buildAutocompleteCandidates,
  buildDefaultDerivedDatasetDescription,
  buildDefaultDerivedDatasetName,
  buildDefaultDerivedDatasetTags,
  buildJoinDraftQuery,
  buildDefaultQuery,
  escapeCsvCell,
  formatDuration,
  formatResultTimestamp,
  getAutocompleteContext,
  getColumnInsertText,
  getPreflightSummary,
  parseDerivedDatasetTags,
  runSqlPreflight,
  type AutocompleteCandidate,
  type SqlPreflightResult,
} from "./sqlLogic";

const QUERY_AI_PROMPT_PLACEHOLDER = "만들고 싶은 분석을 자연어로 입력해 주세요.";
const PREVIEW_ROW_LIMIT_MIN = 10;
const PREVIEW_ROW_LIMIT_STEP = 10;

function isSqlCandidateDataset(dataset: CatalogDataset) {
  const normalizedName = dataset.name.toLowerCase();
  const normalizedTags = dataset.tags.map((tag) => tag.toLowerCase());

  return !normalizedName.includes("legacy") && !normalizedTags.includes("#legacy");
}

export function SqlAnalysisPage({
  cachedResult,
  dataset,
  datasets,
  onAction,
  onPrepareDatasetJob,
  onResultChange,
}: {
  cachedResult?: SqlResultDraft | null;
  dataset: CatalogDataset | null;
  datasets: CatalogDataset[];
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onPrepareDatasetJob: (request: CreateDerivedDatasetRequest) => boolean;
  onResultChange: (result: SqlResultDraft | null) => void;
}) {
  const [baseDatasetId, setBaseDatasetId] = useState<string | null>(dataset?.id ?? null);
  const baseDataset = useMemo(
    () => baseDatasetId ? datasets.find((item) => item.id === baseDatasetId) ?? (dataset?.id === baseDatasetId ? dataset : null) : null,
    [baseDatasetId, dataset, datasets],
  );
  const defaultQuery = useMemo(() => baseDataset ? buildDefaultQuery(baseDataset) : "", [baseDataset]);
  const [executed, setExecuted] = useState(false);
  const [contextCollapsed, setContextCollapsed] = useState(false);
  const [contextPanelTab, setContextPanelTab] = useState<"tables" | "queryAi">("tables");
  const [datasetSearch, setDatasetSearch] = useState("");
  const [contextPage, setContextPage] = useState(1);
  const [contextPageSize, setContextPageSize] = useState(() => Math.max(1, datasets.length));
  const [openSchemaDatasetId, setOpenSchemaDatasetId] = useState<string | null>(null);
  const [expandedDatasetId, setExpandedDatasetId] = useState<string | null>(null);
  const [referenceDatasetIds, setReferenceDatasetIds] = useState<string[]>([]);
  const [executionMs, setExecutionMs] = useState<number | null>(null);
  const [queryPending, setQueryPending] = useState(false);
  const [query, setQuery] = useState(defaultQuery);
  const [previewRowLimit, setPreviewRowLimit] = useState(PREVIEW_ROW_LIMIT);
  const [cursorIndex, setCursorIndex] = useState(defaultQuery.length);
  const [resultDraft, setResultDraft] = useState<SqlResultDraft | null>(null);
  const [preflightResult, setPreflightResult] = useState<SqlPreflightResult | null>(null);
  const [queryAiPrompt, setQueryAiPrompt] = useState("");
  const [queryAiSuggestion, setQueryAiSuggestion] = useState<QueryAiSuggestion | null>(null);
  const [queryAiPending, setQueryAiPending] = useState(false);
  const [queryAiError, setQueryAiError] = useState<string | null>(null);
  const [derivedDatasetName, setDerivedDatasetName] = useState(dataset ? buildDefaultDerivedDatasetName(dataset) : "");
  const [derivedDatasetDescription, setDerivedDatasetDescription] = useState(dataset ? buildDefaultDerivedDatasetDescription(dataset) : "");
  const [derivedDatasetTags, setDerivedDatasetTags] = useState(dataset ? buildDefaultDerivedDatasetTags(dataset) : "");
  const [derivedDatasetLayer, setDerivedDatasetLayer] = useState<DerivedDatasetLayer>("GOLD");
  const [derivedDatasetRag, setDerivedDatasetRag] = useState(dataset?.rag ?? false);
  const [materializeDialogOpen, setMaterializeDialogOpen] = useState(false);
  const [dashboardDialogOpen, setDashboardDialogOpen] = useState(false);
  const [dashboardDialogVersion, setDashboardDialogVersion] = useState(0);
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [dismissedAutocompleteKey, setDismissedAutocompleteKey] = useState<string | null>(null);
  const contextPanelRef = useRef<HTMLElement | null>(null);
  const contextListRef = useRef<HTMLDivElement | null>(null);
  const contextPaginationRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const queryAiPromptRef = useRef<HTMLTextAreaElement | null>(null);
  const lineNumberRef = useRef<HTMLPreElement | null>(null);
  const skipNextBaseDatasetResetRef = useRef(false);
  const referenceDatasetIdSet = useMemo(() => new Set(referenceDatasetIds), [referenceDatasetIds]);
  const queryValidationKey = useMemo(
    () => JSON.stringify({
      baseDatasetId: baseDataset?.id ?? null,
      previewRowLimit,
      query,
      referenceDatasetIds: [...referenceDatasetIds].sort(),
    }),
    [baseDataset?.id, previewRowLimit, query, referenceDatasetIds],
  );
  const derivedDatasetTagList = useMemo(() => parseDerivedDatasetTags(derivedDatasetTags), [derivedDatasetTags]);
  const selectedContextDatasets = useMemo(
    () => baseDataset
      ? [
          baseDataset,
          ...referenceDatasetIds
            .map((id) => datasets.find((item) => item.id === id))
            .filter((item): item is CatalogDataset => Boolean(item)),
        ]
      : [],
    [baseDataset, datasets, referenceDatasetIds],
  );
  const selectedDatasetIdSet = useMemo(
    () => new Set(selectedContextDatasets.map((item) => item.id)),
    [selectedContextDatasets],
  );
  const sqlCandidateDatasets = useMemo(
    () => datasets.filter(isSqlCandidateDataset),
    [datasets],
  );
  const schemaDataset = useMemo(
    () => selectedContextDatasets.find((item) => item.id === openSchemaDatasetId) ?? selectedContextDatasets[0] ?? null,
    [openSchemaDatasetId, selectedContextDatasets],
  );
  const dashboardDialogEntry = useMemo<DashboardEntry>(() => ({
    dashboardId: resultDraft && baseDataset ? `dash_${baseDataset.id}_${resultDraft.runId}` : "dash_sql_empty_draft",
    runtimeMode: "draft",
    source: "sql",
    view: "runtime",
    version: dashboardDialogVersion,
  }), [baseDataset, dashboardDialogVersion, resultDraft]);
  const canRunPreview = Boolean(baseDataset && preflightResult?.canExecute === true && preflightResult.key === queryValidationKey);
  const lineNumbers = useMemo(() => {
    if (!baseDataset) return "";
    const lineCount = Math.max(query.split("\n").length, 7);
    return Array.from({ length: lineCount }, (_, index) => index + 1).join("\n");
  }, [baseDataset, query]);
  const autocompleteContext = useMemo(() => getAutocompleteContext(query, cursorIndex), [cursorIndex, query]);
  const autocompleteCandidates = useMemo(() => {
    if (!baseDataset) return [];
    if (dismissedAutocompleteKey === autocompleteContext.key) return [];
    return buildAutocompleteCandidates({
      baseDataset,
      context: autocompleteContext,
      datasets: sqlCandidateDatasets,
      referenceDatasetIdSet,
    });
  }, [autocompleteContext, baseDataset, dismissedAutocompleteKey, referenceDatasetIdSet, sqlCandidateDatasets]);
  const filteredDatasets = useMemo(() => {
    const keyword = datasetSearch.trim().toLowerCase();
    const contextDatasets = sqlCandidateDatasets.filter((item) => !selectedDatasetIdSet.has(item.id));
    const searchableDatasets = keyword
      ? contextDatasets.filter((item) => {
          const searchableText = [
            item.name,
            item.description,
            item.source,
            item.owner,
            item.layer,
            ...item.tags,
            ...item.schema.map(([name, type]) => `${name} ${type}`),
          ].join(" ").toLowerCase();
          return searchableText.includes(keyword);
        })
      : contextDatasets;

    return searchableDatasets;
  }, [datasetSearch, selectedDatasetIdSet, sqlCandidateDatasets]);
  const totalContextPages = Math.max(1, Math.ceil(filteredDatasets.length / contextPageSize));
  const currentContextPage = Math.min(Math.max(contextPage, 1), totalContextPages);
  const contextPageStartIndex = (currentContextPage - 1) * contextPageSize;
  const paginatedContextDatasets = filteredDatasets.slice(contextPageStartIndex, contextPageStartIndex + contextPageSize);
  const cachedResultBaseDatasetId = cachedResult ? cachedResult.baseDatasetId ?? cachedResult.datasetId : null;
  const canRestoreCachedResult = Boolean(cachedResult && baseDataset && cachedResultBaseDatasetId === baseDataset.id);
  useEffect(() => {
    if (!dataset) {
      setBaseDatasetId(null);
      setReferenceDatasetIds([]);
      setOpenSchemaDatasetId(null);
      setExpandedDatasetId(null);
      return;
    }

    setBaseDatasetId(dataset.id);
    setReferenceDatasetIds([]);
    setOpenSchemaDatasetId(dataset.id);
    setExpandedDatasetId(null);
  }, [dataset?.id]);

  useEffect(() => {
    if (skipNextBaseDatasetResetRef.current) {
      skipNextBaseDatasetResetRef.current = false;
      return;
    }

    if (!baseDataset) {
      setExecuted(false);
      setQuery("");
      setCursorIndex(0);
      setResultDraft(null);
      setExecutionMs(null);
      setPreflightResult(null);
      setDerivedDatasetName("");
      setDerivedDatasetDescription("");
      setDerivedDatasetTags("");
      setDerivedDatasetRag(false);
      setMaterializeDialogOpen(false);
      setDashboardDialogOpen(false);
      setQueryAiPrompt("");
      setQueryAiSuggestion(null);
      setQueryAiError(null);
      setOpenSchemaDatasetId(null);
      setReferenceDatasetIds([]);
      onResultChange(null);
      return;
    }

    if (canRestoreCachedResult) return;

    setExecuted(false);
    setQuery(defaultQuery);
    setCursorIndex(defaultQuery.length);
    setResultDraft(null);
    setExecutionMs(null);
    setPreflightResult(null);
    setDerivedDatasetName(buildDefaultDerivedDatasetName(baseDataset));
    setDerivedDatasetDescription(buildDefaultDerivedDatasetDescription(baseDataset));
    setDerivedDatasetTags(buildDefaultDerivedDatasetTags(baseDataset));
    setDerivedDatasetRag(baseDataset.rag);
    setMaterializeDialogOpen(false);
    setDashboardDialogOpen(false);
    setQueryAiPrompt("");
    setQueryAiSuggestion(null);
    setQueryAiError(null);
    setOpenSchemaDatasetId(baseDataset.id);
    setReferenceDatasetIds((ids) => ids.filter((id) => id !== baseDataset.id));
    onResultChange(null);
  }, [baseDataset, canRestoreCachedResult, defaultQuery]);

  useEffect(() => {
    if (!baseDataset || !cachedResult || !canRestoreCachedResult) return;

    const cachedReferences = (cachedResult.referenceDatasetIds ?? []).filter((id) => id !== baseDataset.id);

    setExecuted(true);
    setQuery(cachedResult.query);
    setPreviewRowLimit(cachedResult.previewLimit ?? PREVIEW_ROW_LIMIT);
    setCursorIndex(cachedResult.query.length);
    setReferenceDatasetIds(cachedReferences);
    setResultDraft(cachedResult);
    setExecutionMs(null);
    setMaterializeDialogOpen(false);
    setDashboardDialogOpen(false);
    setQueryAiSuggestion(null);
    setQueryAiError(null);
    setOpenSchemaDatasetId(baseDataset.id);
  }, [baseDataset, cachedResult, canRestoreCachedResult]);

  const queryContextPath = (mode: "preflight" | "preview" = "preview") => {
    const params = new URLSearchParams({ baseDatasetId: baseDataset?.id ?? "" });
    referenceDatasetIds.forEach((id) => params.append("referenceDatasetIds", id));
    params.set("mode", mode);
    if (mode === "preview") params.set("previewLimit", String(previewRowLimit));
    return `/api/query/runs?${params.toString()}`;
  };

  useEffect(() => {
    setAutocompleteIndex(0);
  }, [autocompleteCandidates.length, autocompleteContext.key]);

  useEffect(() => {
    setContextPage(1);
  }, [baseDataset?.id, datasetSearch, selectedDatasetIdSet]);

  useEffect(() => {
    if (contextPage === currentContextPage) return;
    setContextPage(currentContextPage);
  }, [contextPage, currentContextPage]);

  useEffect(() => {
    if (contextCollapsed) return;
    let frameId = 0;

    const updateContextPageSize = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        const panel = contextPanelRef.current;
        const list = contextListRef.current;
        if (!panel || !list) return;

        const firstRow = list.querySelector<HTMLElement>(".sql-tree-table-row-shell");
        const rowHeight = Math.max(1, firstRow?.getBoundingClientRect().height ?? 56);
        const panelStyle = window.getComputedStyle(panel);
        const panelBottomPadding = Number.parseFloat(panelStyle.paddingBottom) || 0;
        const panelBottom = panel.getBoundingClientRect().bottom - panelBottomPadding;
        const listTop = list.getBoundingClientRect().top;
        const availableListHeight = Math.max(rowHeight, panelBottom - listTop);
        const rowsWithoutPagination = Math.max(1, Math.floor(availableListHeight / rowHeight));

        const paginationHeight = contextPaginationRef.current?.getBoundingClientRect().height ?? 38;
        const resultStyle = window.getComputedStyle(list.parentElement ?? list);
        const resultGap = Number.parseFloat(resultStyle.rowGap || resultStyle.gap) || 0;
        const rowsWithPagination = Math.max(
          1,
          Math.floor((availableListHeight - paginationHeight - resultGap) / rowHeight),
        );
        const nextPageSize = filteredDatasets.length > rowsWithoutPagination
          ? rowsWithPagination
          : rowsWithoutPagination;

        setContextPageSize((size) => (size === nextPageSize ? size : nextPageSize));
      });
    };

    updateContextPageSize();

    const resizeObserver = new ResizeObserver(updateContextPageSize);
    if (contextPanelRef.current) resizeObserver.observe(contextPanelRef.current);
    window.addEventListener("resize", updateContextPageSize);

    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateContextPageSize);
    };
  }, [contextCollapsed, datasetSearch, expandedDatasetId, filteredDatasets.length, selectedContextDatasets.length]);

  useEffect(() => {
    if (!baseDataset) {
      setPreflightResult(null);
      return;
    }
    const referenceDatasets = datasets.filter((item) => referenceDatasetIdSet.has(item.id));
    setPreflightResult(runSqlPreflight(query, baseDataset, referenceDatasets, queryValidationKey, previewRowLimit));
  }, [baseDataset, datasets, previewRowLimit, query, queryValidationKey, referenceDatasetIdSet]);

  const buildPreviewDraft = (): Promise<SqlResultDraft> => {
    if (!baseDataset) return Promise.reject(new Error("No dataset selected"));
    return executeQueryPreview(baseDataset, query, {
      limit: previewRowLimit,
      referenceDatasetIds: [...referenceDatasetIds].sort(),
      validationKey: queryValidationKey,
    });
  };

  const resetResultState = () => {
    setExecuted(false);
    setResultDraft(null);
    setExecutionMs(null);
    setPreflightResult(null);
    setMaterializeDialogOpen(false);
    setDashboardDialogOpen(false);
    onResultChange(null);
  };

  const updateQuery = (nextQuery: string) => {
    setQuery(nextQuery);
    setPreflightResult(null);
    setQueryAiSuggestion(null);
    setQueryAiError(null);
    resetResultState();
  };

  const updateCursorFromTextarea = (textarea: HTMLTextAreaElement) => {
    setCursorIndex(textarea.selectionStart);
    syncLineNumberScroll();
  };

  const syncLineNumberScroll = () => {
    if (!textareaRef.current || !lineNumberRef.current) return;
    lineNumberRef.current.scrollTop = textareaRef.current.scrollTop;
  };

  const applyAutocompleteCandidate = (candidate: AutocompleteCandidate) => {
    const nextQuery = `${query.slice(0, autocompleteContext.start)}${candidate.insertText}${query.slice(autocompleteContext.end)}`;
    const nextCursorIndex = autocompleteContext.start + candidate.insertText.length;
    updateQuery(nextQuery);
    setCursorIndex(nextCursorIndex);
    setDismissedAutocompleteKey(null);
    if (candidate.type === "table" && candidate.datasetId && candidate.datasetId !== baseDataset?.id) {
      const datasetId = candidate.datasetId;
      setReferenceDatasetIds((ids) => (ids.includes(datasetId) ? ids : [...ids, datasetId]));
    }
    onAction("analysis.autocomplete.inserted", `/api/query/autocomplete/${candidate.type}/${encodeURIComponent(candidate.label)}`, candidate.datasetId ?? baseDataset?.id ?? "sql-empty");
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursorIndex, nextCursorIndex);
      syncLineNumberScroll();
    });
  };

  const handleQueryKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (autocompleteCandidates.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setAutocompleteIndex((index) => (index + 1) % autocompleteCandidates.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setAutocompleteIndex((index) => (index - 1 + autocompleteCandidates.length) % autocompleteCandidates.length);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      applyAutocompleteCandidate(autocompleteCandidates[autocompleteIndex] ?? autocompleteCandidates[0]);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissedAutocompleteKey(autocompleteContext.key);
    }
  };

  const executePreview = async () => {
    if (!baseDataset || !canRunPreview) {
      onAction("analysis.query.preview_blocked", queryContextPath("preview"), baseDataset?.id ?? "sql-empty", "failed");
      return;
    }
    const startedAt = performance.now();
    setQueryPending(true);
    try {
      const resultDraft = await buildPreviewDraft();
      setExecuted(true);
      setExecutionMs(Math.round(performance.now() - startedAt));
      setResultDraft(resultDraft);
      onResultChange(resultDraft);
      onAction("analysis.query.preview_executed", queryContextPath("preview"), baseDataset.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "실행에 실패했습니다. 쿼리 또는 데이터셋 상태를 확인해 주세요.";
      setPreflightResult({
        key: queryValidationKey,
        canExecute: false,
        messages: [{ tone: "error", text: message }],
      });
      onAction("analysis.query.preview_failed", queryContextPath("preview"), baseDataset.id, "failed");
    } finally {
      setQueryPending(false);
    }
  };

  const preflightSummary = getPreflightSummary(preflightResult);

  const requestQueryAiSuggestion = async () => {
    if (queryAiPending) return;

    if (!baseDataset) {
      setQueryAiSuggestion(null);
      setQueryAiError("왼쪽에서 분석 테이블을 먼저 추가해 주세요.");
      queryAiPromptRef.current?.focus();
      return;
    }

    if (queryAiPrompt.trim().length === 0) {
      setQueryAiSuggestion(null);
      setQueryAiError("만들고 싶은 분석을 자연어로 입력해 주세요.");
      queryAiPromptRef.current?.focus();
      return;
    }

    setQueryAiPending(true);
    setQueryAiError(null);
    try {
      const suggestion = await generateQueryAiSuggestion({
        baseDataset,
        mode: "draft_sql",
        preflightMessages: preflightResult?.messages ?? [],
        prompt: queryAiPrompt,
        query,
        selectedDatasets: selectedContextDatasets,
      });
      setQueryAiSuggestion(suggestion);
      onAction("analysis.ai.suggestion_created", "/api/query/ai-suggestions?mode=draft_sql", baseDataset.id);
    } catch {
      setQueryAiError("AI 제안을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.");
      onAction("analysis.ai.suggestion_failed", "/api/query/ai-suggestions?mode=draft_sql", baseDataset.id, "failed");
    } finally {
      setQueryAiPending(false);
    }
  };

  const applyQueryAiSuggestion = () => {
    if (!baseDataset || !queryAiSuggestion?.sql) return;
    const nextQuery = queryAiSuggestion.sql;
    updateQuery(nextQuery);
    setCursorIndex(nextQuery.length);
    onAction("analysis.ai.suggestion_applied", `/api/query/ai-suggestions?mode=${queryAiSuggestion.mode}/apply`, baseDataset.id);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextQuery.length, nextQuery.length);
      syncLineNumberScroll();
    });
  };

  const resetQuery = () => {
    updateQuery(defaultQuery);
    setCursorIndex(defaultQuery.length);
    onAction("analysis.query.reset", "/api/query/reset", baseDataset?.id ?? "sql-empty");
  };

  const toggleContext = () => {
    const nextCollapsed = !contextCollapsed;
    setContextCollapsed(nextCollapsed);
    onAction(nextCollapsed ? "analysis.context.collapsed" : "analysis.context.expanded", "/api/query/context", baseDataset?.id ?? "sql-empty");
  };

  const insertSqlText = (text: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      updateQuery(`${query.replace(/;$/, "")} ${text};`);
      return;
    }
    const shouldUseRememberedCursor = document.activeElement !== textarea
      && textarea.selectionStart === 0
      && textarea.selectionEnd === 0
      && cursorIndex > 0;
    const selectionStart = shouldUseRememberedCursor ? Math.min(cursorIndex, query.length) : textarea.selectionStart;
    const selectionEnd = shouldUseRememberedCursor ? selectionStart : textarea.selectionEnd;
    const nextQuery = `${query.slice(0, selectionStart)}${text}${query.slice(selectionEnd)}`;
    const caret = selectionStart + text.length;
    updateQuery(nextQuery);
    setCursorIndex(caret);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
  };

  const addSelectedDataset = (targetDataset: CatalogDataset) => {
    if (selectedDatasetIdSet.has(targetDataset.id)) {
      selectSchemaDataset(targetDataset);
      return;
    }
    if (!baseDataset) {
      setBaseDatasetId(targetDataset.id);
      setReferenceDatasetIds([]);
      setOpenSchemaDatasetId(targetDataset.id);
      setExpandedDatasetId(null);
      resetResultState();
      onAction(
        "analysis.context.dataset_selected",
        `/api/query/context/datasets/${targetDataset.id}/select`,
        targetDataset.id,
      );
      return;
    }
    setReferenceDatasetIds((ids) => (ids.includes(targetDataset.id) ? ids : [...ids, targetDataset.id]));
    setOpenSchemaDatasetId(targetDataset.id);
    setExpandedDatasetId(null);
    resetResultState();
    onAction(
      "analysis.context.dataset_selected",
      `/api/query/context/datasets/${targetDataset.id}/select`,
      targetDataset.id,
    );
  };

  const joinSelectedDataset = (targetDataset: CatalogDataset) => {
    if (!baseDataset || targetDataset.id === baseDataset.id) {
      selectSchemaDataset(targetDataset);
      return;
    }
    const joinDraft = buildJoinDraftQuery({
      allDatasets: sqlCandidateDatasets,
      query,
      selectedDatasets: selectedContextDatasets.filter((item) => item.id !== targetDataset.id),
      targetDataset,
    });
    setReferenceDatasetIds((ids) => {
      const nextIds = new Set(ids);
      nextIds.add(targetDataset.id);
      joinDraft.addedDatasetIds.forEach((id) => {
        if (id !== baseDataset.id) nextIds.add(id);
      });
      return Array.from(nextIds);
    });
    updateQuery(joinDraft.query);
    setCursorIndex(joinDraft.query.length);
    setOpenSchemaDatasetId(targetDataset.id);
    setExpandedDatasetId(null);
    onAction(
      joinDraft.joined ? "analysis.context.dataset_joined" : "analysis.context.dataset_selected",
      `/api/query/context/datasets/${targetDataset.id}/join`,
      targetDataset.id,
    );
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(joinDraft.query.length, joinDraft.query.length);
      syncLineNumberScroll();
    });
  };

  const removeSelectedDataset = (targetDataset: CatalogDataset) => {
    const selectedIds = selectedContextDatasets.map((item) => item.id);
    const nextSelectedIds = selectedIds.filter((id) => id !== targetDataset.id);
    const nextBaseDatasetId = targetDataset.id === baseDataset?.id ? nextSelectedIds[0] ?? null : baseDataset?.id ?? null;
    const nextReferenceDatasetIds = nextSelectedIds.filter((id) => id !== nextBaseDatasetId);

    if (targetDataset.id === baseDataset?.id) {
      skipNextBaseDatasetResetRef.current = true;
      setBaseDatasetId(nextBaseDatasetId);
    }

    setReferenceDatasetIds(nextReferenceDatasetIds);
    setOpenSchemaDatasetId(
      openSchemaDatasetId && nextSelectedIds.includes(openSchemaDatasetId) ? openSchemaDatasetId : nextBaseDatasetId,
    );
    if (nextSelectedIds.length === 0) {
      setQuery("");
      setCursorIndex(0);
      setPreflightResult(null);
      setQueryAiPrompt("");
      setQueryAiSuggestion(null);
      setQueryAiError(null);
    }
    resetResultState();
    onAction(
      "analysis.context.dataset_removed",
      `/api/query/context/datasets/${targetDataset.id}/remove`,
      targetDataset.id,
    );
  };

  const selectSchemaDataset = (targetDataset: CatalogDataset) => {
    setOpenSchemaDatasetId(targetDataset.id);
    onAction(
      "analysis.context.schema_opened",
      `/api/query/context/datasets/${targetDataset.id}/schema`,
      targetDataset.id,
    );
  };

  const toggleDatasetPreview = (targetDataset: CatalogDataset) => {
    setExpandedDatasetId((id) => (id === targetDataset.id ? null : targetDataset.id));
    onAction(
      "analysis.context.dataset_schema_previewed",
      `/api/query/context/datasets/${targetDataset.id}/schema-preview`,
      targetDataset.id,
    );
  };

  const insertColumnName = (targetDataset: CatalogDataset, columnName: string) => {
    const insertText = getColumnInsertText(targetDataset, columnName, selectedContextDatasets);
    insertSqlText(insertText);
    onAction("analysis.context.column_inserted", `/api/query/context/datasets/${targetDataset.id}/columns/${columnName}`, targetDataset.id);
  };

  const downloadCsv = () => {
    if (!resultDraft) return;
    const csv = [
      resultDraft.columns.map(escapeCsvCell).join(","),
      ...resultDraft.rows.map((row) => resultDraft.columns.map((_, index) => escapeCsvCell(row[index] ?? "")).join(",")),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${resultDraft.datasetName}_${resultDraft.runId}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    onAction("analysis.result.downloaded", `/api/query/runs/${resultDraft.runId}/download`, resultDraft.datasetId);
  };

  const prepareDerivedDatasetJob = () => {
    if (!baseDataset || !resultDraft) return;
    const request: CreateDerivedDatasetRequest = {
      dataset: {
        description: derivedDatasetDescription.trim() || buildDefaultDerivedDatasetDescription(baseDataset),
        layer: derivedDatasetLayer,
        name: derivedDatasetName.trim(),
        rag: derivedDatasetRag,
        refreshPolicy: "manual",
        tags: derivedDatasetTagList,
      },
      previewLimit: resultDraft.previewLimit,
      query: resultDraft.query,
      referenceDatasetIds: resultDraft.referenceDatasetIds ?? [],
      sourceDatasetId: baseDataset.id,
      sourceRunId: resultDraft.runId,
      validationKey: resultDraft.validationKey,
    };

    const prepared = onPrepareDatasetJob(request);
    if (prepared) {
      setMaterializeDialogOpen(false);
    }
  };

  const openDashboardBuilder = () => {
    if (!baseDataset || !resultDraft) return;
    setDashboardDialogVersion((version) => version + 1);
    setDashboardDialogOpen(true);
    onAction("dashboard.builder.modal_opened_from_sql", `/api/dashboards/${baseDataset.id}/draft/ensure`, resultDraft.runId);
  };

  const updatePreviewRowLimit = (values: number[]) => {
    setPreviewRowLimit(values[0] ?? PREVIEW_ROW_LIMIT);
  };

  const commitPreviewRowLimit = (values: number[]) => {
    setPreviewRowLimit(values[0] ?? PREVIEW_ROW_LIMIT);
    resetResultState();
  };

  return (
    <div className={cn("sql-page", contextCollapsed && "context-collapsed")}>
      <PageHeader
        className="sql-page-header"
        description="선택한 데이터셋을 기준으로 SQL을 작성하고 Preview 결과를 처리 Job으로 전환합니다."
        icon={<Table2 size={18} />}
        title="SQL 분석"
      />
      {contextCollapsed && (
        <Button className="sql-context-rail-button" type="button" onClick={toggleContext} aria-label="분석 테이블 열기" title="분석 테이블 열기" size="icon" variant="outline">
          <PanelLeftOpen data-icon="inline-start" />
        </Button>
      )}
      {!contextCollapsed && (
        <Panel asChild>
          <aside className="sql-dataset-panel" ref={contextPanelRef}>
            <Tabs
              className="grid min-h-0 grid-rows-[max-content_minmax(0,1fr)] gap-4"
              onValueChange={(value) => setContextPanelTab(value as "tables" | "queryAi")}
              value={contextPanelTab}
            >
            <div className="sql-panel-header">
              <div className="sql-panel-title-row">
                <strong>SQL 도구</strong>
                <span className="sql-panel-header-actions">
                  <Badge size="sm" variant="default">
                    {contextPanelTab === "tables" ? `${Math.max(0, datasets.length - selectedContextDatasets.length)}개 후보` : queryAiSuggestion ? "초안 생성됨" : "보조 기능"}
                  </Badge>
                  <Button type="button" onClick={toggleContext} aria-label="분석 테이블 접기" title="분석 테이블 접기" size="icon" variant="ghost">
                    <PanelLeftClose data-icon="inline-start" />
                  </Button>
                </span>
              </div>
              <TabsList className="sql-sidebar-tabs grid w-full grid-cols-2" aria-label="SQL 도구 선택">
                <TabsTrigger value="tables">
                  <Table2 /> 분석 테이블
                </TabsTrigger>
                <TabsTrigger value="queryAi">
                  <Sparkles /> Query AI
                </TabsTrigger>
              </TabsList>
            </div>
            <TabsContent className="sql-sidebar-tab-panel tables mt-0" value="tables">
              <FilterToolbarSearch icon={<Search size={15} />} size="compact">
                <FilterToolbarInput
                  aria-label="분석 테이블 검색"
                  className="text-xs font-bold"
                  value={datasetSearch}
                  onChange={(event) => setDatasetSearch(event.target.value)}
                  placeholder="데이터셋, 컬럼, 태그 검색"
                  type="search"
                />
              </FilterToolbarSearch>
              <section className="sql-dataset-search-results">
                <div className="sql-section-heading">
                  <h2>데이터셋</h2>
                  <Badge size="sm" variant="muted">{filteredDatasets.length}개</Badge>
                </div>
                <div className="sql-context-result-list" ref={contextListRef}>
                  <SqlDatasetTree
                    datasets={paginatedContextDatasets}
                    expandedDatasetId={expandedDatasetId}
                    onSelect={addSelectedDataset}
                    onToggle={toggleDatasetPreview}
                  />
                  {filteredDatasets.length === 0 && (
                    <Empty size="sm" variant="bordered">
                      <EmptyHeader>
                        <EmptyTitle>{datasetSearch.trim() ? "검색 결과가 없습니다." : "선택 가능한 테이블이 없습니다."}</EmptyTitle>
                        <EmptyDescription>{datasetSearch.trim() ? "다른 검색어를 입력해 주세요." : "선택된 테이블을 해제하면 다시 표시됩니다."}</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  )}
                </div>
                {filteredDatasets.length > contextPageSize && (
                  <PaginationBar
                    aria-label="테이블 검색 결과 페이지"
                    buttonSize="sm"
                    currentPage={currentContextPage}
                    onNext={() => setContextPage((page) => Math.min(totalContextPages, page + 1))}
                    onPrevious={() => setContextPage((page) => Math.max(1, page - 1))}
                    rangeLabel={`${contextPageStartIndex + 1}-${contextPageStartIndex + paginatedContextDatasets.length} / ${filteredDatasets.length}`}
                    ref={contextPaginationRef}
                    totalPages={totalContextPages}
                  />
                )}
              </section>
            </TabsContent>
            <TabsContent className="sql-sidebar-tab-panel ai mt-0" value="queryAi">
              <Panel className="sql-ai-assistant sidebar" variant="muted">
                <div className="sql-ai-heading">
                  <div className="sql-ai-title-block">
                    <div className="sql-ai-title">
                      <Sparkles size={16} />
                      <strong>Query AI 생성</strong>
                    </div>
                    <span className="sql-ai-context">{baseDataset ? baseDataset.name : "테이블 선택 필요"}</span>
                  </div>
                </div>
                <div className="sql-ai-content">
                  <div className="sql-ai-compose">
                    <div className="sql-ai-input-row">
                      <Field className="sql-ai-prompt">
                        <FieldLabel htmlFor="sql-query-ai-prompt">요청</FieldLabel>
                        <Textarea
                          id="sql-query-ai-prompt"
                          ref={queryAiPromptRef}
                          onChange={(event) => {
                            setQueryAiPrompt(event.target.value);
                            setQueryAiError(null);
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" || event.shiftKey) return;
                            event.preventDefault();
                            void requestQueryAiSuggestion();
                          }}
                          placeholder={QUERY_AI_PROMPT_PLACEHOLDER}
                          rows={3}
                          value={queryAiPrompt}
                        />
                      </Field>
                      <ActionGroup className="sql-ai-actions" density="compact">
                        <Button disabled={queryAiPending} onClick={requestQueryAiSuggestion} type="button" size="sm" variant="outline">
                          <Sparkles data-icon="inline-start" /> {queryAiPending ? "생성 중" : "제안"}
                        </Button>
                      </ActionGroup>
                    </div>
                  </div>
                  <Bubble
                    aria-live="polite"
                    className={cn("sql-ai-suggestion w-full max-w-full", queryAiSuggestion ? "result" : queryAiError ? "error" : "empty")}
                    role={queryAiError ? "alert" : "status"}
                    variant={queryAiSuggestion ? "outline" : queryAiError ? "destructive" : "muted"}
                  >
                    <BubbleContent className="grid w-full gap-2">
                      {queryAiSuggestion ? (
                        <>
                          {queryAiSuggestion.sql && <pre>{queryAiSuggestion.sql}</pre>}
                          {queryAiSuggestion.sql && (
                            <Button onClick={applyQueryAiSuggestion} type="button" size="sm" variant="primary">
                              SQL에 적용
                            </Button>
                          )}
                        </>
                      ) : (
                        <span>{queryAiError ?? (baseDataset ? "자동 실행 없이 초안만 만듭니다." : "분석 테이블을 추가하면 AI 제안을 만들 수 있습니다.")}</span>
                      )}
                    </BubbleContent>
                  </Bubble>
                </div>
              </Panel>
            </TabsContent>
            </Tabs>
          </aside>
        </Panel>
      )}

      <main className="sql-workspace">
        <Panel asChild>
          <section className="sql-editor-card">
          <div className="sql-editor-header">
            <div>
              <h2>선택 데이터셋 기준 SQL</h2>
            </div>
            <ActionGroup className="sql-editor-actions" density="compact">
              <Button type="button" onClick={executePreview} disabled={!canRunPreview || queryPending} size="sm" variant="primary">
                <PlayCircle data-icon="inline-start" /> {queryPending ? "실행 중" : "실행"}
              </Button>
            </ActionGroup>
          </div>
          <div className="sql-editor-layout">
            <div className={baseDataset ? "sql-editor-surface" : "sql-editor-surface empty"}>
              <pre ref={lineNumberRef} aria-hidden="true">{lineNumbers}</pre>
              <div className="sql-editor-input-wrap">
                <FieldLabel className="sr-only" htmlFor="sql-query-editor">SQL editor</FieldLabel>
                <Textarea
                  id="sql-query-editor"
                  ref={textareaRef}
                  disabled={!baseDataset}
                  placeholder={baseDataset ? "SQL을 입력하세요." : "왼쪽 분석 테이블에서 데이터셋을 선택하면 SQL을 작성할 수 있습니다."}
                  value={query}
                  onChange={(event) => {
                    updateQuery(event.target.value);
                    setCursorIndex(event.target.selectionStart);
                    setDismissedAutocompleteKey(null);
                  }}
                  onClick={(event) => updateCursorFromTextarea(event.currentTarget)}
                  onBlur={() => setDismissedAutocompleteKey(autocompleteContext.key)}
                  onKeyDown={handleQueryKeyDown}
                  onKeyUp={(event) => {
                    if (["ArrowDown", "ArrowUp", "Tab", "Escape"].includes(event.key)) return;
                    updateCursorFromTextarea(event.currentTarget);
                  }}
                  onScroll={syncLineNumberScroll}
                  spellCheck={false}
                />
                {autocompleteCandidates.length > 0 && (
                  <div className="sql-autocomplete-popover">
                    {autocompleteCandidates.map((candidate, index) => (
                      <Button
                        className={cn("sql-autocomplete-option", index === autocompleteIndex && "active")}
                        key={candidate.id}
                        type="button"
                        size="sm"
                        variant="ghost"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => applyAutocompleteCandidate(candidate)}
                      >
                        <strong>{candidate.label}</strong>
                        <span>{candidate.detail}</span>
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="sql-editor-footer">
            <div className="sql-editor-status-line">
              {preflightSummary && (
                <Badge
                  size="sm"
                  variant={preflightSummary.tone === "success" ? "success" : preflightSummary.tone === "warning" ? "warning" : "destructive"}
                >
                  {preflightSummary.label}
                </Badge>
              )}
              {preflightSummary?.detail && <span className={`sql-check-detail ${preflightSummary.tone}`}>{preflightSummary.detail}</span>}
            </div>
            <div className="sql-editor-footer-controls">
              <Field className="sql-preview-limit-field">
                <FieldLabel htmlFor="sql-preview-row-limit">Preview {previewRowLimit}행</FieldLabel>
                <Slider
                  aria-label={`SQL Preview 최대 ${previewRowLimit}행`}
                  aria-valuetext={`${previewRowLimit}행`}
                  disabled={!baseDataset || queryPending}
                  id="sql-preview-row-limit"
                  max={PREVIEW_ROW_LIMIT}
                  min={PREVIEW_ROW_LIMIT_MIN}
                  onValueChange={updatePreviewRowLimit}
                  onValueCommit={commitPreviewRowLimit}
                  step={PREVIEW_ROW_LIMIT_STEP}
                  value={[previewRowLimit]}
                />
              </Field>
              <Button type="button" onClick={resetQuery} size="sm" variant="outline">
                <RotateCcw data-icon="inline-start" /> SQL 초기화
              </Button>
            </div>
          </div>
          </section>
        </Panel>

        <Panel asChild>
          <ResultPanel
            className={resultDraft ? "sql-result-card result-ready" : "sql-result-card"}
            eyebrow="실행 결과"
            headerClassName="sql-result-header"
            isEmpty={!resultDraft}
            status={(
              <>
                <Badge size="sm" variant={queryPending ? "default" : executed ? "success" : "muted"}>
                  {queryPending ? "실행 중" : executed ? "완료" : "대기 중"}
                </Badge>
                {executionMs !== null && <Badge size="sm" variant="secondary">{formatDuration(executionMs)}</Badge>}
              </>
            )}
            statusClassName="sql-result-status"
            title={resultDraft ? `${resultDraft.rowCount}행 조회됨` : "결과 대기 중"}
          >
          {resultDraft ? (
            <>
              <Panel className="sql-result-toolbar" variant="muted">
                <span>
                  실행 ID {resultDraft.runId}
                  {resultDraft.previewLimit ? ` · 최대 ${resultDraft.previewLimit}행 표시` : ""}
                  {` · ${resultDraft.rows.length}/${resultDraft.rowCount}행 표시 · ${resultDraft.columns.length}컬럼`}
                  {` · ${formatResultTimestamp(resultDraft.executedAt)}`}
                </span>
                <ActionGroup className="sql-result-actions" density="compact">
                  <Button type="button" onClick={downloadCsv} size="sm" variant="outline"><Download data-icon="inline-start" /> CSV 다운로드</Button>
                  <Button type="button" onClick={() => setMaterializeDialogOpen(true)} size="sm" variant="outline"><Database data-icon="inline-start" /> 처리 Job 생성</Button>
                  <Button type="button" onClick={openDashboardBuilder} size="sm" variant="outline"><BarChart3 data-icon="inline-start" /> 대시보드 만들기</Button>
                </ActionGroup>
              </Panel>
              <div className="sql-result-scroll">
                <SqlPreviewTable resultDraft={resultDraft} />
              </div>
            </>
          ) : (
            <Empty className="sql-result-empty" size="sm" variant="bordered">
              <EmptyHeader>
                <EmptyTitle>아직 결과가 없습니다.</EmptyTitle>
                <EmptyDescription>{baseDataset ? "SQL을 실행하면 Preview 결과가 여기에 표시됩니다." : "먼저 분석 테이블에서 데이터셋을 선택해 주세요."}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          </ResultPanel>
        </Panel>
      </main>
      {resultDraft && materializeDialogOpen && (
        <DialogShell
          bodyClassName="sql-materialize-form"
          contentClassName="sql-materialize-dialog"
          eyebrow="처리 작업"
          footer={(
            <span>실행 {resultDraft.runId} · 태그 {derivedDatasetTagList.length}개 · 컬럼 {resultDraft.columns.length}개 · 검토 단계에서 생성 요청</span>
          )}
          footerClassName="sql-materialize-summary"
          headerActions={(
            <Button type="button" onClick={() => setMaterializeDialogOpen(false)} aria-label="저장 설정 닫기" size="sm" variant="outline">닫기</Button>
          )}
          headerClassName="sql-materialize-dialog-header"
          onClose={() => setMaterializeDialogOpen(false)}
          title="SQL 결과 처리 Job 생성"
        >
              <FormFieldGroup label="데이터셋 이름">
                <Input
                  onChange={(event) => {
                    setDerivedDatasetName(event.target.value);
                  }}
                  value={derivedDatasetName}
                />
              </FormFieldGroup>
              <FormFieldGroup className="wide" label="설명">
                <Textarea
                  onChange={(event) => {
                    setDerivedDatasetDescription(event.target.value);
                  }}
                  rows={2}
                  value={derivedDatasetDescription}
                />
              </FormFieldGroup>
              <FormFieldGroup className="wide" label="태그">
                <Input
                  onChange={(event) => {
                    setDerivedDatasetTags(event.target.value);
                  }}
                  placeholder="#sql-derived #analysis"
                  value={derivedDatasetTags}
                />
              </FormFieldGroup>
              <NativeSelectField
                label="레이어"
                value={derivedDatasetLayer}
                onChange={(event) => {
                  setDerivedDatasetLayer(event.target.value as DerivedDatasetLayer);
                }}
              >
                <option value="SILVER">SILVER</option>
                <option value="GOLD">GOLD</option>
              </NativeSelectField>
              <Field className="sql-materialize-checkbox">
                <Checkbox
                  id="sql-materialize-rag"
                  checked={derivedDatasetRag}
                  onCheckedChange={(checked) => {
                    setDerivedDatasetRag(checked === true);
                  }}
                />
                <FieldLabel htmlFor="sql-materialize-rag">RAG 사용 가능</FieldLabel>
              </Field>
              <Button
                className="sql-materialize-submit"
                disabled={derivedDatasetName.trim().length === 0 || derivedDatasetTagList.length === 0}
                onClick={prepareDerivedDatasetJob}
                type="button"
                size="sm"
                variant="primary"
              >
                <Database data-icon="inline-start" /> Job 생성 검토로 이동
              </Button>
        </DialogShell>
      )}
      {resultDraft && baseDataset && (
        <Dialog onOpenChange={setDashboardDialogOpen} open={dashboardDialogOpen}>
          <DialogContent
            aria-describedby={undefined}
            className="sql-dashboard-builder-dialog"
            showCloseButton={false}
          >
            <DialogTitle className="sr-only">SQL 결과 대시보드 만들기</DialogTitle>
            <Button className="sql-dashboard-builder-close" type="button" onClick={() => setDashboardDialogOpen(false)} size="sm" variant="outline">
              닫기
            </Button>
            <DashboardPage
              dataset={baseDataset}
              datasets={selectedContextDatasets}
              entry={dashboardDialogEntry}
              sqlResult={resultDraft}
              onAction={onAction}
            />
          </DialogContent>
        </Dialog>
      )}
      <SchemaDetailsPanel
        dataset={schemaDataset}
        selectedDatasets={selectedContextDatasets}
        onColumnClick={insertColumnName}
        onJoinDataset={joinSelectedDataset}
        onSelectedDatasetRemove={removeSelectedDataset}
        onSchemaSelect={selectSchemaDataset}
      />
    </div>
  );
}
