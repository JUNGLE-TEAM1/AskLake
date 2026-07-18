import { useEffect, useRef, useState } from "react";

import {
  generateQueryAiSuggestion,
  getQueryAiErrorMessage,
  type QueryAiSuggestion,
} from "../../services/queryAiService";
import { LatestRequestGate, type RequestLease } from "../../state/requestOwnership";
import type { AuditResult, CatalogDataset } from "../../types";
import type { SqlPreflightResult } from "./sqlLogic";

type SqlQueryAiOptions = {
  baseDataset: CatalogDataset | null;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onApplyQuery: (query: string) => void;
  preflightResult: SqlPreflightResult | null;
  query: string;
  selectedDatasets: CatalogDataset[];
};

function sqlQueryContextFingerprint(
  baseDataset: CatalogDataset | null,
  query: string,
  selectedDatasets: CatalogDataset[],
) {
  return JSON.stringify({
    baseDatasetId: baseDataset?.id ?? null,
    query,
    selectedDatasetIds: selectedDatasets.map((dataset) => dataset.id).sort(),
  });
}

function sqlQueryAiValidationError(baseDataset: CatalogDataset | null, prompt: string) {
  if (!baseDataset) return "왼쪽에서 분석 테이블을 먼저 추가해 주세요.";
  if (!prompt) return "만들고 싶은 분석을 자연어로 입력해 주세요.";
  return null;
}

function requestSqlQueryAiSuggestion(
  baseDataset: CatalogDataset,
  preflightResult: SqlPreflightResult | null,
  prompt: string,
  query: string,
  selectedDatasets: CatalogDataset[],
  lease: RequestLease,
) {
  return generateQueryAiSuggestion({
    baseDataset,
    mode: "draft_sql",
    preflightMessages: preflightResult?.messages ?? [],
    prompt,
    query,
    selectedDatasets,
  }, { signal: lease.signal });
}

export function useSqlQueryAi({
  baseDataset,
  onAction,
  onApplyQuery,
  preflightResult,
  query,
  selectedDatasets,
}: SqlQueryAiOptions) {
  const [prompt, setPrompt] = useState("");
  const [suggestion, setSuggestion] = useState<QueryAiSuggestion | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const requests = useRef(new LatestRequestGate());
  const contextFingerprint = sqlQueryContextFingerprint(baseDataset, query, selectedDatasets);
  const contextFingerprintRef = useRef(contextFingerprint);
  contextFingerprintRef.current = contextFingerprint;

  useEffect(() => {
    requests.current.invalidate();
    setPending(false);
    setPrompt("");
    setSuggestion(null);
    setError(null);
    setOpen(false);
  }, [contextFingerprint]);

  useEffect(() => () => requests.current.invalidate(), []);

  const changePrompt = (nextPrompt: string) => {
    requests.current.invalidate();
    setPending(false);
    setPrompt(nextPrompt);
    setSuggestion(null);
    setError(null);
  };

  const changeOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      requests.current.invalidate();
      setPending(false);
      return;
    }
    setError(null);
    onAction("analysis.ai.opened", "/api/query/ai-suggestions", baseDataset?.id ?? "sql-empty");
  };

  const generate = async () => {
    if (pending) return;
    const normalizedPrompt = prompt.trim();
    const validationError = sqlQueryAiValidationError(baseDataset, normalizedPrompt);
    if (!baseDataset || validationError) {
      setSuggestion(null);
      setError(validationError);
      promptRef.current?.focus();
      return;
    }

    setSuggestion(null);
    setError(null);
    setPending(true);
    const lease = requests.current.begin(contextFingerprint);
    try {
      const nextSuggestion = await requestSqlQueryAiSuggestion(
        baseDataset, preflightResult, normalizedPrompt, query, selectedDatasets, lease,
      );
      if (!requests.current.isCurrent(lease) || contextFingerprintRef.current !== lease.key) return;
      setSuggestion(nextSuggestion);
      onAction("analysis.ai.suggestion_created", "/api/query/ai-suggestions?mode=draft_sql", baseDataset.id);
    } catch (requestError) {
      if (!requests.current.isCurrent(lease) || contextFingerprintRef.current !== lease.key) return;
      setSuggestion(null);
      setError(getQueryAiErrorMessage(requestError));
      onAction("analysis.ai.suggestion_failed", "/api/query/ai-suggestions?mode=draft_sql", baseDataset.id, "failed");
    } finally {
      if (requests.current.complete(lease) && contextFingerprintRef.current === lease.key) {
        setPending(false);
      }
    }
  };

  const apply = (suggestedSql = suggestion?.sql ?? "") => {
    if (!baseDataset || !suggestedSql) return;
    onApplyQuery(suggestedSql);
    setOpen(false);
    setPrompt("");
    setSuggestion(null);
    onAction("analysis.ai.suggestion_applied", "/api/query/ai-suggestions?mode=draft_sql/apply", baseDataset.id);
  };

  return {
    apply,
    changeOpen,
    changePrompt,
    error,
    generate,
    open,
    pending,
    prompt,
    promptRef,
    suggestion,
  };
}
