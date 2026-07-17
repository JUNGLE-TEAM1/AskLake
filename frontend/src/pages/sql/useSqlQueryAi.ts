import { useEffect, useMemo, useRef, useState } from "react";

import {
  generateQueryAiSuggestion,
  type QueryAiSuggestion,
} from "../../services/queryAiService";
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
  const contextFingerprint = useMemo(() => JSON.stringify({
    baseDatasetId: baseDataset?.id ?? null,
    query,
    selectedDatasetIds: selectedDatasets.map((dataset) => dataset.id).sort(),
  }), [baseDataset?.id, query, selectedDatasets]);
  const contextFingerprintRef = useRef(contextFingerprint);

  useEffect(() => {
    contextFingerprintRef.current = contextFingerprint;
    setPrompt("");
    setSuggestion(null);
    setError(null);
    setOpen(false);
  }, [contextFingerprint]);

  const changePrompt = (nextPrompt: string) => {
    setPrompt(nextPrompt);
    setSuggestion(null);
    setError(null);
  };

  const changeOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) return;
    setError(null);
    onAction("analysis.ai.opened", "/api/query/ai-suggestions", baseDataset?.id ?? "sql-empty");
  };

  const generate = async () => {
    if (pending) return;
    const normalizedPrompt = prompt.trim();

    if (!baseDataset) {
      setSuggestion(null);
      setError("왼쪽에서 분석 테이블을 먼저 추가해 주세요.");
      promptRef.current?.focus();
      return;
    }
    if (!normalizedPrompt) {
      setSuggestion(null);
      setError("만들고 싶은 분석을 자연어로 입력해 주세요.");
      promptRef.current?.focus();
      return;
    }

    setSuggestion(null);
    setError(null);
    setPending(true);
    const requestedContextFingerprint = contextFingerprint;
    try {
      const nextSuggestion = await generateQueryAiSuggestion({
        baseDataset,
        mode: "draft_sql",
        preflightMessages: preflightResult?.messages ?? [],
        prompt: normalizedPrompt,
        query,
        selectedDatasets,
      });
      if (contextFingerprintRef.current !== requestedContextFingerprint) return;
      setSuggestion(nextSuggestion);
      onAction("analysis.ai.suggestion_created", "/api/query/ai-suggestions?mode=draft_sql", baseDataset.id);
    } catch {
      setSuggestion(null);
      setError("SQL 제안을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.");
      onAction("analysis.ai.suggestion_failed", "/api/query/ai-suggestions?mode=draft_sql", baseDataset.id, "failed");
    } finally {
      setPending(false);
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
