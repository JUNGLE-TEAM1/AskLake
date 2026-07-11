import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
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
import { Field, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { FilterToolbarInput, FilterToolbarSearch } from "@/components/ui/filter-toolbar";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { PageHeader } from "@/components/ui/page-header";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Slider } from "@/components/ui/slider";
import { StatusBadge } from "@/components/ui/status-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { executeQueryPreview } from "../../services/mockApi";
import {
  generateQueryAiSuggestion,
  type QueryAiSuggestion,
} from "../../services/queryAiService";
import { ApiError } from "../../types";
import type { AuditResult, CatalogDataset, CreateDerivedDatasetRequest, CurrentUserResponse, DashboardEntry, DerivedDatasetLayer, SqlResultDraft } from "../../types";
import { canQueryDatasetAs, permissionDeniedMessage } from "../../utils/permissions";
import { DashboardPage } from "../dashboard/DashboardPage";
import { SqlDatasetTree } from "./SqlDatasetRow";
import { SqlPreviewTable } from "./SqlPreviewTable";
import {
  PREVIEW_ROW_LIMIT,
  buildAutocompleteCandidates,
  buildDefaultDerivedDatasetDescription,
  buildDefaultDerivedDatasetName,
  buildDefaultDerivedDatasetTags,
  buildDefaultQuery,
  escapeCsvCell,
  formatDuration,
  formatResultTimestamp,
  getAutocompleteContext,
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
  currentUser,
  dataset,
  datasets,
  onAction,
  onPrepareDatasetJob,
  onResultChange,
}: {
  cachedResult?: SqlResultDraft | null;
  currentUser?: CurrentUserResponse | null;
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
  const dashboardBaseDataset = useMemo(() => {
    if (baseDataset) return baseDataset;
    if (!resultDraft) return null;
    const candidateIds = [resultDraft.baseDatasetId, resultDraft.datasetId].filter((id): id is string => Boolean(id));
    return candidateIds
      .map((id) => datasets.find((item) => item.id === id) ?? (dataset?.id === id ? dataset : null))
      .find((item): item is CatalogDataset => Boolean(item)) ?? null;
  }, [baseDataset, dataset, datasets, resultDraft]);
  const dashboardDialogEntry = useMemo<DashboardEntry>(() => ({
    baseDatasetId: dashboardBaseDataset?.id,
    dashboardId: resultDraft && dashboardBaseDataset ? `dash_${dashboardBaseDataset.id}_${resultDraft.runId}` : "dash_sql_empty_draft",
    runtimeMode: "draft",
    sqlResultDatasetId: resultDraft?.datasetId,
    sqlRunId: resultDraft?.runId,
    source: "sql",
    view: "runtime",
    version: dashboardDialogVersion,
  }), [dashboardBaseDataset, dashboardDialogVersion, resultDraft]);
  const selectedReferenceDatasets = useMemo(
    () => datasets.filter((item) => referenceDatasetIdSet.has(item.id)),
    [datasets, referenceDatasetIdSet],
  );
  const hasQueryPermission = Boolean(baseDataset && canQueryDatasetAs(baseDataset, currentUser) && selectedReferenceDatasets.every((item) => canQueryDatasetAs(item, currentUser)));
  const queryPermissionMessage = hasQueryPermission ? "" : permissionDeniedMessage("선택 데이터셋", "SQL 실행");
  const canRunPreview = Boolean(baseDataset && hasQueryPermission && preflightResult?.canExecute === true && preflightResult.key === queryValidationKey);
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
    const contextDatasets = sqlCandidateDatasets;
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
      setExpandedDatasetId(null);
      return;
    }

    setBaseDatasetId(dataset.id);
    setReferenceDatasetIds([]);
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

        const firstRow = list.querySelector<HTMLElement>("[data-sql-dataset-row]");
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
    if (!hasQueryPermission) {
      setPreflightResult({
        key: queryValidationKey,
        canExecute: false,
        messages: [{ tone: "error", text: queryPermissionMessage }],
      });
      return;
    }
    setPreflightResult(runSqlPreflight(query, baseDataset, selectedReferenceDatasets, queryValidationKey));
  }, [baseDataset, hasQueryPermission, query, queryPermissionMessage, queryValidationKey, selectedReferenceDatasets]);

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

    if (!hasQueryPermission) {
      setQueryAiSuggestion(null);
      setQueryAiError(queryPermissionMessage);
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
    } catch (error) {
      setQueryAiError(error instanceof ApiError && error.status === 403 ? queryPermissionMessage : "AI 제안을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.");
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
      removeSelectedDataset(targetDataset);
      return;
    }
    if (!baseDataset) {
      setBaseDatasetId(targetDataset.id);
      setReferenceDatasetIds([]);
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
    setExpandedDatasetId(null);
    resetResultState();
    onAction(
      "analysis.context.dataset_selected",
      `/api/query/context/datasets/${targetDataset.id}/select`,
      targetDataset.id,
    );
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

  const toggleDatasetPreview = (targetDataset: CatalogDataset) => {
    setExpandedDatasetId((id) => (id === targetDataset.id ? null : targetDataset.id));
    onAction(
      "analysis.context.dataset_schema_previewed",
      `/api/query/context/datasets/${targetDataset.id}/schema-preview`,
      targetDataset.id,
    );
  };

  const applyPreflightAutoFix = () => {
    if (!preflightResult?.autoFixQuery) return;
    const nextQuery = preflightResult.autoFixQuery;
    updateQuery(nextQuery);
    setCursorIndex(nextQuery.length);
    onAction("analysis.query.identifier_autofixed", queryContextPath("preflight"), baseDataset?.id ?? "sql-empty");
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextQuery.length, nextQuery.length);
      syncLineNumberScroll();
    });
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
    if (!dashboardBaseDataset || !resultDraft) return;
    setDashboardDialogVersion((version) => version + 1);
    setDashboardDialogOpen(true);
    onAction("dashboard.builder.modal_opened_from_sql", `/api/dashboards/${dashboardBaseDataset.id}/draft/ensure`, resultDraft.runId);
  };

  const handleDashboardBuilderMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    openDashboardBuilder();
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
        description="데이터셋을 탐색하고 SQL 쿼리를 실행해 결과를 분석합니다."
        descriptionClassName="text-xl leading-8"
        icon={<Table2 size={30} />}
        iconClassName="mt-0 size-16 rounded-xl"
        size="lg"
        title="SQL 분석"
        titleClassName="text-4xl"
      />
      {!contextCollapsed && (
        <Panel asChild>
          <aside className="sql-dataset-panel" ref={contextPanelRef}>
            <Tabs
              className="grid h-full min-h-0 grid-rows-[max-content_minmax(0,1fr)] gap-4"
              onValueChange={(value) => setContextPanelTab(value as "tables" | "queryAi")}
              value={contextPanelTab}
            >
                <div className="grid gap-4">
                  <PanelHeader
                    actions={(
                      <Button type="button" onClick={toggleContext} aria-label="분석 테이블 접기" title="분석 테이블 접기" size="icon" variant="ghost">
                        <PanelLeftClose data-icon="inline-start" />
                      </Button>
                    )}
                    className="min-h-0 p-0 pb-4"
                    icon={<Table2 size={16} />}
                    title="SQL 도구"
                  />
                  <TabsList className="grid w-full grid-cols-2" aria-label="SQL 도구 선택">
                    <TabsTrigger
                      className="relative isolate overflow-hidden data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                      value="tables"
                    >
                      {contextPanelTab === "tables" && (
                        <motion.span
                          aria-hidden="true"
                          className="absolute inset-0 z-0 rounded-md bg-white shadow-sm"
                          data-sql-tab-indicator=""
                          layoutId="sql-tools-active-tab"
                          transition={{ type: "spring", stiffness: 420, damping: 32 }}
                        />
                      )}
                      <span className="relative z-10 inline-flex items-center gap-1.5"><Table2 /> 분석 테이블</span>
                    </TabsTrigger>
                    <TabsTrigger
                      className="relative isolate overflow-hidden data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                      value="queryAi"
                    >
                      {contextPanelTab === "queryAi" && (
                        <motion.span
                          aria-hidden="true"
                          className="absolute inset-0 z-0 rounded-md bg-white shadow-sm"
                          data-sql-tab-indicator=""
                          layoutId="sql-tools-active-tab"
                          transition={{ type: "spring", stiffness: 420, damping: 32 }}
                        />
                      )}
                      <span className="relative z-10 inline-flex items-center gap-1.5"><Sparkles /> Query AI</span>
                    </TabsTrigger>
                  </TabsList>
                </div>
                <TabsContent className="mt-0 grid min-h-0 min-w-0 grid-rows-[max-content_minmax(0,1fr)] gap-3 overflow-hidden" value="tables">
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
                  <section className="grid min-h-0 grid-rows-[max-content_minmax(0,1fr)_max-content] gap-2">
                    <FieldTitle>데이터셋</FieldTitle>
                    <Panel asChild>
                      <ScrollArea className="h-[300px] min-h-0" type="always">
                        <div className="grid min-w-0 gap-0 pr-3" ref={contextListRef}>
                          <SqlDatasetTree
                            datasets={paginatedContextDatasets}
                            expandedDatasetId={expandedDatasetId}
                            onSelect={addSelectedDataset}
                            onToggle={toggleDatasetPreview}
                            selectedDatasetIds={selectedDatasetIdSet}
                          />
                          {filteredDatasets.length === 0 && (
                            <Empty size="sm" variant="bordered">
                              <EmptyHeader>
                                <EmptyTitle>{datasetSearch.trim() ? "검색 결과가 없습니다." : "선택 가능한 테이블이 없습니다."}</EmptyTitle>
                                <EmptyDescription>{datasetSearch.trim() ? "다른 검색어를 입력해 주세요." : "SQL에 사용할 테이블이 없습니다."}</EmptyDescription>
                              </EmptyHeader>
                            </Empty>
                          )}
                        </div>
                      </ScrollArea>
                    </Panel>
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
                <TabsContent className="mt-0 min-h-0 min-w-0 overflow-hidden" value="queryAi">
                  <ScrollArea className="h-full" type="always">
                    <Panel className="mr-3 grid gap-3 p-3.5" variant="muted">
                      <div className="grid min-w-0 gap-2.5">
                        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-stretch gap-2.5 max-[860px]:grid-cols-1">
                          <Field>
                            <FieldLabel htmlFor="sql-query-ai-prompt">요청</FieldLabel>
                            <Textarea
                              className="min-h-[66px]"
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
                          <ActionGroup align="end" className="self-end" density="compact">
                            <Button
                              disabled={queryAiPending || !hasQueryPermission}
                              onClick={requestQueryAiSuggestion}
                              size="sm"
                              title={hasQueryPermission ? "Query AI 초안을 생성합니다." : queryPermissionMessage}
                              type="button"
                              variant="outline"
                            >
                              <Sparkles data-icon="inline-start" /> {queryAiPending ? "생성 중" : "제안"}
                            </Button>
                          </ActionGroup>
                        </div>
                        <Bubble
                          aria-live="polite"
                          className="sql-ai-suggestion w-full max-w-full"
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
                              <span>{queryAiError ?? (!hasQueryPermission ? queryPermissionMessage : baseDataset ? "자동 실행 없이 초안만 만듭니다." : "분석 테이블을 추가하면 AI 제안을 만들 수 있습니다.")}</span>
                            )}
                          </BubbleContent>
                        </Bubble>
                      </div>
                    </Panel>
                  </ScrollArea>
                </TabsContent>
            </Tabs>
          </aside>
        </Panel>
      )}

      <main className="sql-workspace grid min-w-0 auto-rows-max content-start gap-3">
        {contextCollapsed && (
          <Button className="sql-context-rail-button" type="button" onClick={toggleContext} aria-label="분석 테이블 열기" title="분석 테이블 열기" size="icon" variant="outline">
            <PanelLeftOpen data-icon="inline-start" />
          </Button>
        )}
        <Panel className="grid gap-4 p-5">
          <PanelHeader
            actions={(
              <Button
                disabled={!canRunPreview || queryPending}
                onClick={executePreview}
                size="sm"
                title={hasQueryPermission ? "SQL Preview를 실행합니다." : queryPermissionMessage}
                type="button"
                variant="primary"
              >
                <PlayCircle data-icon="inline-start" /> {queryPending ? "실행 중" : "실행"}
              </Button>
            )}
            bordered={false}
            className="min-h-0 p-0"
            icon={<Table2 size={16} />}
            title="선택 데이터셋 기준 SQL"
          />
          <div className="grid grid-cols-1 gap-4">
            <div className={baseDataset ? "sql-editor-surface" : "sql-editor-surface empty"}>
              <pre ref={lineNumberRef} aria-hidden="true">{lineNumbers}</pre>
              <div className="sql-editor-input-wrap">
                <FieldLabel className="sr-only" htmlFor="sql-query-editor">SQL editor</FieldLabel>
                <Textarea
                  className="focus-visible:ring-0 focus-visible:ring-offset-0"
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
                  <Panel className="sql-autocomplete-popover">
                    <ScrollArea className="h-[220px]" type="always">
                      <div className="grid gap-1 p-1.5 pr-3">
                        {autocompleteCandidates.map((candidate, index) => (
                          <Button
                            className="grid min-h-8 w-full grid-cols-[minmax(0,1fr)_auto] gap-2.5 px-2 text-left"
                            key={candidate.id}
                            type="button"
                            size="sm"
                            variant={index === autocompleteIndex ? "subtle" : "ghost"}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => applyAutocompleteCandidate(candidate)}
                          >
                            <strong>{candidate.label}</strong>
                            <Badge size="sm" variant="secondary">{candidate.detail}</Badge>
                          </Button>
                        ))}
                      </div>
                    </ScrollArea>
                  </Panel>
                )}
              </div>
            </div>
          </div>
          <div className="sql-editor-footer">
            <div className="sql-editor-status-line">
              {preflightSummary && (
                <StatusBadge
                  size="sm"
                  tone={preflightSummary.tone === "success" ? "success" : preflightSummary.tone === "warning" ? "warning" : "danger"}
                >
                  {preflightSummary.label}
                </StatusBadge>
              )}
              {preflightSummary?.detail && (
                <Badge
                  size="sm"
                  variant={preflightSummary.tone === "error" ? "destructive" : preflightSummary.tone === "warning" ? "warning" : "outline"}
                >
                  {preflightSummary.detail}
                </Badge>
              )}
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
              {preflightResult?.autoFixQuery && (
                <Button type="button" onClick={applyPreflightAutoFix} size="sm" variant="outline">
                  식별자 자동 보정
                </Button>
              )}
            </div>
          </div>
        </Panel>

        <Panel className="grid gap-4 p-5">
          <PanelHeader
            actions={(
              <ActionGroup density="compact">
                <StatusBadge size="sm" tone={queryPending ? "default" : executed ? "success" : "muted"}>
                  {queryPending ? "실행 중" : executed ? "완료" : "대기 중"}
                </StatusBadge>
                {executionMs !== null && <Badge size="sm" variant="secondary">{formatDuration(executionMs)}</Badge>}
              </ActionGroup>
            )}
            bordered={false}
            className="min-h-0 p-0"
            icon={<Table2 size={16} />}
            title={resultDraft ? `${resultDraft.rowCount}행 조회됨` : "결과 대기 중"}
          />
          {resultDraft ? (
            <>
              <Panel className="grid min-h-9 items-start gap-3 p-3" variant="muted">
                <Badge className="w-fit max-w-full" size="sm" variant="secondary">
                  실행 ID {resultDraft.runId}
                  {resultDraft.previewLimit ? ` · 최대 ${resultDraft.previewLimit}행 표시` : ""}
                  {` · ${resultDraft.rows.length}/${resultDraft.rowCount}행 표시 · ${resultDraft.columns.length}컬럼`}
                  {` · ${formatResultTimestamp(resultDraft.executedAt)}`}
                </Badge>
                <ActionGroup align="start" className="w-full" density="compact">
                  <Button type="button" onClick={downloadCsv} size="sm" variant="outline"><Download data-icon="inline-start" /> CSV 다운로드</Button>
                  <Button type="button" onClick={() => setMaterializeDialogOpen(true)} size="sm" variant="outline"><Database data-icon="inline-start" /> 처리 Job 생성</Button>
                  <Button
                    disabled={!dashboardBaseDataset}
                    onClick={openDashboardBuilder}
                    onMouseDown={handleDashboardBuilderMouseDown}
                    size="sm"
                    title={dashboardBaseDataset ? "현재 SQL 실행 결과로 대시보드 초안을 엽니다." : "SQL 실행 결과의 기준 데이터셋을 찾을 수 없습니다."}
                    type="button"
                    variant="outline"
                  >
                    <BarChart3 data-icon="inline-start" /> 대시보드 만들기
                  </Button>
                </ActionGroup>
              </Panel>
              <ScrollArea className="sql-result-scroll" scrollbars="both" type="always">
                <SqlPreviewTable resultDraft={resultDraft} />
              </ScrollArea>
            </>
          ) : (
            <Empty className="sql-result-empty" size="sm" variant="bordered">
              <EmptyHeader>
                <EmptyTitle>아직 결과가 없습니다.</EmptyTitle>
                <EmptyDescription>{baseDataset ? "SQL을 실행하면 Preview 결과가 여기에 표시됩니다." : "먼저 분석 테이블에서 데이터셋을 선택해 주세요."}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </Panel>
      </main>
      {resultDraft && materializeDialogOpen && (
        <DialogShell
          contentClassName="sql-materialize-dialog"
          eyebrow="처리 작업"
          footer={(
            <Badge size="sm" variant="secondary">
              실행 {resultDraft.runId} · 태그 {derivedDatasetTagList.length}개 · 컬럼 {resultDraft.columns.length}개 · 검토 단계에서 생성 요청
            </Badge>
          )}
          onClose={() => setMaterializeDialogOpen(false)}
          size="lg"
          title="SQL 결과 처리 Job 생성"
        >
          <FieldGroup className="grid-cols-12 gap-3 max-[860px]:grid-cols-1">
            <Field className="col-span-8 max-[860px]:col-span-1">
              <FieldLabel htmlFor="sql-materialize-name">데이터셋 이름</FieldLabel>
              <Input
                id="sql-materialize-name"
                onChange={(event) => {
                  setDerivedDatasetName(event.target.value);
                }}
                value={derivedDatasetName}
              />
            </Field>
            <Field className="col-span-4 max-[860px]:col-span-1">
              <FieldLabel htmlFor="sql-materialize-layer">레이어</FieldLabel>
              <NativeSelect
                id="sql-materialize-layer"
                size="sm"
                value={derivedDatasetLayer}
                onChange={(event) => {
                  setDerivedDatasetLayer(event.target.value as DerivedDatasetLayer);
                }}
              >
                <option value="SILVER">SILVER</option>
                <option value="GOLD">GOLD</option>
              </NativeSelect>
            </Field>
            <Field className="col-span-12 max-[860px]:col-span-1">
              <FieldLabel htmlFor="sql-materialize-description">설명</FieldLabel>
              <Textarea
                id="sql-materialize-description"
                onChange={(event) => {
                  setDerivedDatasetDescription(event.target.value);
                }}
                rows={2}
                value={derivedDatasetDescription}
              />
            </Field>
            <Field className="col-span-7 max-[860px]:col-span-1">
              <FieldLabel htmlFor="sql-materialize-tags">태그</FieldLabel>
              <Input
                id="sql-materialize-tags"
                onChange={(event) => {
                  setDerivedDatasetTags(event.target.value);
                }}
                placeholder="#sql-derived #analysis"
                value={derivedDatasetTags}
              />
            </Field>
            <Field className="col-span-2 min-h-9 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 self-end max-[860px]:col-span-1">
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
              className="col-span-3 self-end max-[860px]:col-span-1"
              disabled={!hasQueryPermission || derivedDatasetName.trim().length === 0 || derivedDatasetTagList.length === 0}
              onClick={prepareDerivedDatasetJob}
              title={hasQueryPermission ? "처리 Job 생성 검토로 이동합니다." : queryPermissionMessage}
              type="button"
              size="sm"
              variant="primary"
            >
              <Database data-icon="inline-start" /> Job 생성 검토로 이동
            </Button>
          </FieldGroup>
        </DialogShell>
      )}
      {resultDraft && dashboardBaseDataset && (
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
              dataset={dashboardBaseDataset}
              datasets={selectedContextDatasets}
              entry={dashboardDialogEntry}
              sqlResult={resultDraft}
              onAction={onAction}
              onMissingSqlResult={() => setDashboardDialogOpen(false)}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
