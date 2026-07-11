import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  Database,
  Download,
  Maximize2,
  PanelLeftClose,
  PanelLeftOpen,
  PlayCircle,
  RotateCcw,
  Search,
  Table2,
} from "lucide-react";
import { ActionGroup } from "@/components/ui/action-group";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { FieldLabel, FieldTitle } from "@/components/ui/field";
import { FilterToolbarInput, FilterToolbarSearch } from "@/components/ui/filter-toolbar";
import { PageHeader } from "@/components/ui/page-header";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { executeQueryPreview } from "../../services/mockApi";
import {
  generateQueryAiSuggestion,
  type QueryAiSuggestion,
} from "../../services/queryAiService";
import type { AuditResult, CatalogDataset, CreateDerivedDatasetRequest, SqlResultDraft } from "../../types";
import { SqlAiWriterDialog } from "./SqlAiWriterDialog";
import { SqlChartConfigurator } from "./SqlChartConfigurator";
import { SqlDatasetTree } from "./SqlDatasetRow";
import {
  formatSqlJobWizardScheduleLabel,
  formatSqlJobWizardScheduleSummary,
  SqlJobWizardDialog,
  type SqlJobWizardCreateRequest,
} from "./SqlJobWizardDialog";
import { NessieMark } from "./NessieMark";
import { SqlPreviewTable } from "./SqlPreviewTable";
import {
  buildSqlChartSources,
  SqlResultChart,
  type SqlChartConfig,
} from "./SqlResultChart";
import {
  PREVIEW_ROW_LIMIT,
  buildAutocompleteCandidates,
  buildDefaultDerivedDatasetDescription,
  buildDefaultDerivedDatasetName,
  buildDefaultQuery,
  escapeCsvCell,
  getAutocompleteContext,
  getPreflightSummary,
  runSqlPreflight,
  type AutocompleteCandidate,
  type SqlPreflightResult,
} from "./sqlLogic";

function isSqlCandidateDataset(dataset: CatalogDataset) {
  const normalizedName = dataset.name.toLowerCase();
  const normalizedTags = dataset.tags.map((tag) => tag.toLowerCase());

  return !normalizedName.includes("legacy") && !normalizedTags.includes("#legacy");
}

function SqlChartEmptyState() {
  return (
    <Empty className="sql-result-view-empty" size="sm" variant="bordered">
      <EmptyHeader>
        <EmptyTitle>아직 생성된 차트가 없습니다.</EmptyTitle>
        <EmptyDescription>왼쪽 차트 생성하기에서 위젯을 설정하고 차트를 생성해 주세요.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function SqlAnalysisPage({
  cachedResult,
  createPending,
  dataset,
  datasets,
  onAction,
  onCreateDatasetJob,
  onResultChange,
}: {
  cachedResult?: SqlResultDraft | null;
  createPending: boolean;
  dataset: CatalogDataset | null;
  datasets: CatalogDataset[];
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onCreateDatasetJob: (request: CreateDerivedDatasetRequest) => Promise<boolean>;
  onResultChange: (result: SqlResultDraft | null) => void;
}) {
  const [baseDatasetId, setBaseDatasetId] = useState<string | null>(dataset?.id ?? null);
  const baseDataset = useMemo(
    () => baseDatasetId ? datasets.find((item) => item.id === baseDatasetId) ?? (dataset?.id === baseDatasetId ? dataset : null) : null,
    [baseDatasetId, dataset, datasets],
  );
  const defaultQuery = useMemo(() => baseDataset ? buildDefaultQuery(baseDataset) : "", [baseDataset]);
  const [contextCollapsed, setContextCollapsed] = useState(false);
  const [contextPanelTab, setContextPanelTab] = useState<"chart" | "tables">("tables");
  const [datasetSearch, setDatasetSearch] = useState("");
  const [contextPage, setContextPage] = useState(1);
  const [contextPageSize, setContextPageSize] = useState(() => Math.max(1, datasets.length));
  const [expandedDatasetId, setExpandedDatasetId] = useState<string | null>(null);
  const [referenceDatasetIds, setReferenceDatasetIds] = useState<string[]>([]);
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
  const [queryAiDialogOpen, setQueryAiDialogOpen] = useState(false);
  const [chartConfig, setChartConfig] = useState<SqlChartConfig | null>(null);
  const [resultView, setResultView] = useState<"chart" | "table">("table");
  const [resultDialogOpen, setResultDialogOpen] = useState(false);
  const [materializeDialogOpen, setMaterializeDialogOpen] = useState(false);
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
  const chartSources = useMemo(
    () => resultDraft ? buildSqlChartSources(resultDraft, selectedContextDatasets) : [],
    [resultDraft, selectedContextDatasets],
  );
  const activeChartSource = useMemo(
    () => chartConfig ? chartSources.find((source) => source.id === chartConfig.sourceId) : undefined,
    [chartConfig, chartSources],
  );
  const selectedDatasetIdSet = useMemo(
    () => new Set(selectedContextDatasets.map((item) => item.id)),
    [selectedContextDatasets],
  );
  const sqlCandidateDatasets = useMemo(
    () => datasets.filter(isSqlCandidateDataset),
    [datasets],
  );
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
      setQuery("");
      setCursorIndex(0);
      setResultDraft(null);
      setPreflightResult(null);
      setMaterializeDialogOpen(false);
      setQueryAiPrompt("");
      setQueryAiSuggestion(null);
      setQueryAiError(null);
      setQueryAiDialogOpen(false);
      setChartConfig(null);
      setResultView("table");
      setResultDialogOpen(false);
      setReferenceDatasetIds([]);
      onResultChange(null);
      return;
    }

    if (canRestoreCachedResult) return;

    setQuery(defaultQuery);
    setCursorIndex(defaultQuery.length);
    setResultDraft(null);
    setPreflightResult(null);
    setMaterializeDialogOpen(false);
    setQueryAiPrompt("");
    setQueryAiSuggestion(null);
    setQueryAiError(null);
    setQueryAiDialogOpen(false);
    setChartConfig(null);
    setResultView("table");
    setResultDialogOpen(false);
    setReferenceDatasetIds((ids) => ids.filter((id) => id !== baseDataset.id));
    onResultChange(null);
  }, [baseDataset, canRestoreCachedResult, defaultQuery]);

  useEffect(() => {
    if (!baseDataset || !cachedResult || !canRestoreCachedResult) return;

    const cachedReferences = (cachedResult.referenceDatasetIds ?? []).filter((id) => id !== baseDataset.id);

    setQuery(cachedResult.query);
    setPreviewRowLimit(cachedResult.previewLimit ?? PREVIEW_ROW_LIMIT);
    setCursorIndex(cachedResult.query.length);
    setReferenceDatasetIds(cachedReferences);
    setResultDraft(cachedResult);
    setMaterializeDialogOpen(false);
    setQueryAiSuggestion(null);
    setQueryAiError(null);
    setQueryAiDialogOpen(false);
    setChartConfig(null);
    setResultView("table");
    setResultDialogOpen(false);
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
    if (contextCollapsed || contextPanelTab !== "tables") return;
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
  }, [contextCollapsed, contextPanelTab, datasetSearch, expandedDatasetId, filteredDatasets.length, selectedContextDatasets.length]);

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
    setResultDraft(null);
    setPreflightResult(null);
    setChartConfig(null);
    setResultView("table");
    setResultDialogOpen(false);
    setMaterializeDialogOpen(false);
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
    setQueryPending(true);
    try {
      const resultDraft = await buildPreviewDraft();
      setResultDraft(resultDraft);
      setChartConfig(null);
      setResultView("table");
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
  const visiblePreflightSummary = preflightSummary?.tone === "success" ? null : preflightSummary;

  const requestQueryAiSuggestion = async () => {
    if (queryAiPending) return;

    const prompt = queryAiPrompt.trim();

    if (!baseDataset) {
      setQueryAiSuggestion(null);
      setQueryAiError("왼쪽에서 분석 테이블을 먼저 추가해 주세요.");
      queryAiPromptRef.current?.focus();
      return;
    }

    if (prompt.length === 0) {
      setQueryAiSuggestion(null);
      setQueryAiError("만들고 싶은 분석을 자연어로 입력해 주세요.");
      queryAiPromptRef.current?.focus();
      return;
    }

    setQueryAiSuggestion(null);
    setQueryAiError(null);

    setQueryAiPending(true);
    try {
      const suggestion = await generateQueryAiSuggestion({
        baseDataset,
        mode: "draft_sql",
        preflightMessages: preflightResult?.messages ?? [],
        prompt,
        query,
        selectedDatasets: selectedContextDatasets,
      });
      setQueryAiSuggestion(suggestion);
      onAction("analysis.ai.suggestion_created", "/api/query/ai-suggestions?mode=draft_sql", baseDataset.id);
    } catch {
      const message = "SQL 제안을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.";
      setQueryAiSuggestion(null);
      setQueryAiError(message);
      onAction("analysis.ai.suggestion_failed", "/api/query/ai-suggestions?mode=draft_sql", baseDataset.id, "failed");
    } finally {
      setQueryAiPending(false);
    }
  };

  const applyQueryAiSuggestion = (suggestedSql = queryAiSuggestion?.sql ?? "") => {
    if (!baseDataset || !suggestedSql) return;
    const nextQuery = suggestedSql;
    updateQuery(nextQuery);
    setCursorIndex(nextQuery.length);
    setQueryAiDialogOpen(false);
    setQueryAiPrompt("");
    onAction("analysis.ai.suggestion_applied", "/api/query/ai-suggestions?mode=draft_sql/apply", baseDataset.id);
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

  const openSqlAssistant = () => {
    setQueryAiDialogOpen(true);
    setQueryAiError(null);
    onAction("analysis.ai.opened", "/api/query/ai-suggestions", baseDataset?.id ?? "sql-empty");
    requestAnimationFrame(() => queryAiPromptRef.current?.focus());
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

  const createDerivedDatasetJob = async ({ configuration, context }: SqlJobWizardCreateRequest) => {
    const request: CreateDerivedDatasetRequest = {
      dataset: {
        description: configuration.dataset.description.trim(),
        layer: configuration.dataset.layer,
        name: configuration.dataset.name.trim(),
        rag: false,
        refreshPolicy: "manual",
        tags: [],
      },
      job: {
        accessScope: configuration.governance.accessScope,
        compression: configuration.target.compression,
        owner: configuration.governance.owner.trim(),
        overlapPolicy: configuration.schedule.overlapPolicy,
        partitionColumn: configuration.target.partitionColumn || undefined,
        permissionSummary: configuration.governance.permissionSummary.trim(),
        scheduleLabel: formatSqlJobWizardScheduleLabel(configuration.schedule),
        scheduleMode: configuration.schedule.mode === "manual" ? "manual" : "repeat",
        scheduleSummary: formatSqlJobWizardScheduleSummary(configuration.schedule),
        storagePath: configuration.target.storagePath.trim(),
        timezone: configuration.schedule.timezone,
      },
      previewLimit: context.previewLimit,
      query: context.query,
      referenceDatasetIds: context.referenceDatasetIds,
      sourceDatasetId: context.baseDatasetId,
      sourceRunId: context.sourceRunId,
      validationKey: context.validationKey,
    };

    const created = await onCreateDatasetJob(request);
    if (created) setMaterializeDialogOpen(false);
    return created;
  };

  const applyChartConfig = (nextConfig: SqlChartConfig) => {
    if (!resultDraft) return;
    setChartConfig(nextConfig);
    setResultView("chart");
    onAction("analysis.chart.configured", `/api/query/runs/${resultDraft.runId}/visualization`, resultDraft.datasetId);
  };

  return (
    <div className={cn("sql-page", contextCollapsed && "context-collapsed")}>
      <PageHeader
        className="sql-page-header"
        icon={<Table2 size={18} />}
        title="SQL 분석"
      />
      {!contextCollapsed && (
        <Panel asChild>
          <aside className="sql-dataset-panel" ref={contextPanelRef}>
            <Tabs
              className="grid h-full min-h-0 grid-rows-[max-content_minmax(0,1fr)] gap-4"
              onValueChange={(value) => setContextPanelTab(value as "chart" | "tables")}
              value={contextPanelTab}
            >
              <div className="grid gap-4">
                <PanelHeader
                  actions={(
                    <Button type="button" onClick={toggleContext} aria-label="SQL 도구 접기" title="SQL 도구 접기" size="icon" variant="ghost">
                      <PanelLeftClose data-icon="inline-start" />
                    </Button>
                  )}
                  className="min-h-0 p-0"
                  icon={<Table2 size={16} />}
                  title="SQL 도구"
                />
                <TabsList className="grid w-full grid-cols-2" aria-label="SQL 도구 선택">
                  <TabsTrigger value="tables"><Table2 /> 분석 테이블</TabsTrigger>
                  <TabsTrigger value="chart"><BarChart3 /> 차트 생성하기</TabsTrigger>
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
                  <div className="relative min-h-0 overflow-hidden">
                    <Panel asChild>
                      <ScrollArea className="sql-dataset-scroll min-h-0" style={{ inset: 0, position: "absolute" }} type="always">
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
              <TabsContent className="sql-chart-configurator mt-0 min-w-0" value="chart">
                <SqlChartConfigurator
                  initialConfig={chartConfig}
                  onApply={applyChartConfig}
                  sources={chartSources}
                />
              </TabsContent>
            </Tabs>
          </aside>
        </Panel>
      )}

      <main className="sql-workspace grid min-w-0 content-start gap-3">
        {contextCollapsed && (
          <Button className="sql-context-rail-button" type="button" onClick={toggleContext} aria-label="분석 테이블 열기" title="분석 테이블 열기" size="icon" variant="outline">
            <PanelLeftOpen data-icon="inline-start" />
          </Button>
        )}
        <Panel className="sql-query-panel grid gap-4 p-5">
          <PanelHeader
            actions={(
              <ActionGroup density="compact" wrap="wrap">
                <Button type="button" onClick={resetQuery} size="sm" variant="outline">
                  <RotateCcw data-icon="inline-start" /> SQL 초기화
                </Button>
                <Button type="button" onClick={openSqlAssistant} disabled={!baseDataset} size="sm" variant="outline">
                  <NessieMark className="size-5" /> Nessie로 SQL 작성
                </Button>
                <Button type="button" onClick={executePreview} disabled={!canRunPreview || queryPending} size="sm" variant="primary">
                  <PlayCircle data-icon="inline-start" /> {queryPending ? "실행 중" : "실행"}
                </Button>
              </ActionGroup>
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
          {visiblePreflightSummary && <div className="sql-editor-footer">
            <div className="sql-editor-status-line">
              <Badge
                size="sm"
                variant={visiblePreflightSummary.tone === "error" ? "destructive" : "warning"}
              >
                {visiblePreflightSummary.label}
              </Badge>
              {visiblePreflightSummary.detail && (
                <Badge
                  size="sm"
                  variant={visiblePreflightSummary.tone === "error" ? "destructive" : "warning"}
                >
                  {visiblePreflightSummary.detail}
                </Badge>
              )}
            </div>
          </div>}
        </Panel>

        <Panel className={cn("sql-result-panel grid gap-4 p-5", resultDraft && "has-result")}>
          <PanelHeader
            bordered={false}
            className="min-h-0 p-0"
            icon={<Table2 size={16} />}
            title={resultDraft ? `${resultDraft.rowCount}행 조회됨` : "결과 대기 중"}
          />
          {resultDraft ? (
            <>
              <div className="sql-result-toolbar">
                <ToggleGroup
                  aria-label="SQL 결과 보기"
                  onValueChange={(value) => value && setResultView(value as "chart" | "table")}
                  type="single"
                  value={resultView}
                >
                  <ToggleGroupItem aria-label="차트 보기" size="sm" value="chart">
                    <BarChart3 /> 차트 보기
                  </ToggleGroupItem>
                  <ToggleGroupItem aria-label="데이터 미리보기" size="sm" value="table">
                    <Table2 /> 데이터 미리보기
                  </ToggleGroupItem>
                </ToggleGroup>
                <ActionGroup density="compact" wrap="wrap">
                  <Button type="button" onClick={downloadCsv} size="sm" variant="outline"><Download data-icon="inline-start" /> CSV 다운로드</Button>
                  <Button type="button" onClick={() => setMaterializeDialogOpen(true)} size="sm" variant="outline"><Database data-icon="inline-start" /> 처리 Job 생성</Button>
                  <Button type="button" onClick={() => setResultDialogOpen(true)} size="sm" variant="outline">
                    <Maximize2 data-icon="inline-start" /> 전체 보기
                  </Button>
                </ActionGroup>
              </div>
              <ScrollArea className="sql-result-scroll" scrollbars="both" type="always">
                {resultView === "chart"
                  ? chartConfig && activeChartSource
                    ? <SqlResultChart chartConfig={chartConfig} source={activeChartSource} />
                    : <SqlChartEmptyState />
                  : <SqlPreviewTable resultDraft={resultDraft} />}
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
      {resultDraft && (
        <Dialog onOpenChange={setResultDialogOpen} open={resultDialogOpen}>
          <DialogContent className="grid h-[min(900px,calc(100vh-2rem))] w-[min(1440px,calc(100vw-2rem))] max-w-none grid-rows-[max-content_minmax(0,1fr)] overflow-hidden">
            <DialogHeader>
              <DialogTitle>SQL 결과 전체 보기</DialogTitle>
              <DialogDescription>
                {resultDraft.rows.length}/{resultDraft.rowCount}행 · {resultDraft.columns.length}컬럼 · {resultView === "chart" ? "차트" : "표"} 보기
              </DialogDescription>
            </DialogHeader>
            <ScrollArea className="min-h-0" scrollbars="both" type="always">
              {resultView === "chart"
                ? chartConfig && activeChartSource
                  ? <SqlResultChart chartConfig={chartConfig} source={activeChartSource} />
                  : <SqlChartEmptyState />
                : (
                  <div className="min-w-0 px-4 pb-4 pt-6">
                    <SqlPreviewTable resultDraft={resultDraft} />
                  </div>
                )}
            </ScrollArea>
          </DialogContent>
        </Dialog>
      )}
      <SqlAiWriterDialog
        disabled={!baseDataset}
        error={queryAiError}
        onApply={applyQueryAiSuggestion}
        onGenerate={requestQueryAiSuggestion}
        onOpenChange={setQueryAiDialogOpen}
        onPromptChange={(nextPrompt) => {
          setQueryAiPrompt(nextPrompt);
          setQueryAiSuggestion(null);
          setQueryAiError(null);
        }}
        open={queryAiDialogOpen}
        pending={queryAiPending}
        prompt={queryAiPrompt}
        promptRef={queryAiPromptRef}
        suggestion={queryAiSuggestion}
      />
      {resultDraft && baseDataset && materializeDialogOpen && (
        <SqlJobWizardDialog
          baseDataset={baseDataset}
          defaultMetadata={{
            description: buildDefaultDerivedDatasetDescription(baseDataset),
            name: buildDefaultDerivedDatasetName(baseDataset),
          }}
          onClose={() => setMaterializeDialogOpen(false)}
          onCreate={createDerivedDatasetJob}
          open={materializeDialogOpen}
          pending={createPending}
          resultDraft={resultDraft}
        />
      )}
    </div>
  );
}
