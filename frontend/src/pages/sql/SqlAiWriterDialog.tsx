import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import { Check, Send, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent, BubbleGroup } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { QueryAiSuggestion } from "../../services/queryAiService";
import styles from "./SqlAiWriterDialog.module.css";

export type SqlAiWriterDialogProps = {
  disabled?: boolean;
  error: string | null;
  onApply: (sql: string) => void;
  onGenerate: () => void | Promise<void>;
  onOpenChange: (open: boolean) => void;
  onPromptChange: (prompt: string) => void;
  open: boolean;
  pending: boolean;
  prompt: string;
  promptRef: RefObject<HTMLTextAreaElement | null>;
  suggestion: QueryAiSuggestion | null;
};

function SqlAiSuggestionSummary({ suggestion }: { suggestion: QueryAiSuggestion }) {
  return (
    <Bubble className="max-w-full" variant="secondary">
      <BubbleContent className="max-w-full">
        <span className="flex min-w-0 items-center justify-between gap-3">
          <strong className="truncate">{suggestion.title}</strong>
          <span className="flex shrink-0 items-center gap-2">
            {(suggestion.provider || suggestion.model) && (
              <span className="text-xs text-muted-foreground">
                {[suggestion.provider, suggestion.model].filter(Boolean).join(" · ")}
              </span>
            )}
            <Badge size="sm" variant="secondary">SQL 초안</Badge>
          </span>
        </span>
        <span className="mt-1 block text-sm text-muted-foreground">{suggestion.body}</span>
      </BubbleContent>
    </Bubble>
  );
}

function SqlAiSuggestionEvidence({ suggestion }: { suggestion: QueryAiSuggestion }) {
  const retrieval = suggestion.retrieval;
  const sources = suggestion.sources ?? [];
  if (!retrieval || sources.length === 0) return null;

  return (
    <Bubble className="max-w-full" variant="tinted">
      <BubbleContent className="max-w-full text-sm">
        <strong>RAG 근거</strong>
        <span className="mt-1 block">
          Semantic model: {(retrieval.semanticModelNames ?? []).join(", ") || "없음"}
          {retrieval.semanticModelVersions?.some(Boolean)
            ? ` · version ${retrieval.semanticModelVersions.filter(Boolean).join(", ")}`
            : ""}
        </span>
        <span className="mt-1 block text-muted-foreground">
          Dataset: {(retrieval.datasetIds ?? []).join(", ") || "-"}
          {` · ${retrieval.status ?? "unknown"} · ${retrieval.resultCount ?? sources.length} source chunks`}
        </span>
        {(retrieval.queryPlannerProvider || retrieval.queryPlannerModel) && (
          <span className="mt-1 block text-muted-foreground">
            검색 계획: {[retrieval.queryPlannerProvider, retrieval.queryPlannerModel].filter(Boolean).join(" · ")}
          </span>
        )}
        {Object.entries(retrieval.queryEmbeddings ?? {}).map(([datasetId, embedding]) => (
          <span className="mt-1 block text-muted-foreground" key={`embedding-${datasetId}`}>
            쿼리 임베딩({datasetId}): {[embedding.provider, embedding.model, embedding.dimensions ? `${embedding.dimensions}차원` : null].filter(Boolean).join(" · ")}
          </span>
        ))}
        {(retrieval.relevanceProvider || retrieval.relevanceModel) && (
          <span className="mt-1 block text-muted-foreground">
            근거 관련성 검증: {[retrieval.relevanceProvider, retrieval.relevanceModel].filter(Boolean).join(" · ")}
          </span>
        )}
        {sources.map((source, index) => (
          <span className="mt-1 block text-muted-foreground" key={`${source.parentDocumentId ?? "source"}-${index}`}>
            {index + 1}. {source.title || source.body?.trim().slice(0, 180) || source.datasetId || "source chunk"}
            {source.chunkIndex !== undefined ? ` · chunk ${source.chunkIndex}` : ""}
            {source.embeddingProvider || source.embeddingModel ? ` · 임베딩 ${[source.embeddingProvider, source.embeddingModel].filter(Boolean).join(" · ")}` : ""}
          </span>
        ))}
      </BubbleContent>
    </Bubble>
  );
}

function SqlAiJoinEvidence({ suggestion }: { suggestion: QueryAiSuggestion }) {
  const evidence = suggestion.joinEvidence ?? [];
  if (evidence.length === 0) return null;

  return (
    <Bubble className="max-w-full" variant="tinted">
      <BubbleContent className="max-w-full text-sm">
        <strong>JOIN 근거</strong>
        {evidence.map((relationship, index) => {
          const sourceLabel = relationship.source.startsWith("semantic_model:")
            ? "게시된 시맨틱 관계"
            : "Catalog 검증 고유키";
          const predicates = relationship.columnPairs.map((pair) => (
            `${relationship.leftDatasetName}.${pair.leftColumn} = ${relationship.rightDatasetName}.${pair.rightColumn}`
          )).join(" AND ");
          return (
            <span
              className="mt-1 block text-muted-foreground"
              key={`${relationship.leftDatasetId}-${relationship.rightDatasetId}-${index}`}
            >
              {index + 1}. {predicates} · {sourceLabel} · {relationship.relationshipType}
            </span>
          );
        })}
      </BubbleContent>
    </Bubble>
  );
}

export function SqlAiWriterDialog({
  disabled = false,
  error,
  onApply,
  onGenerate,
  onOpenChange,
  onPromptChange,
  open,
  pending,
  prompt,
  promptRef,
  suggestion,
}: SqlAiWriterDialogProps) {
  const generateDisabled = disabled || pending || prompt.trim().length === 0;
  const promptOpen = !pending && !suggestion?.sql;
  const applyButtonRef = useRef<HTMLButtonElement | null>(null);
  const pendingStatusRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const focusTarget = () => {
      if (pending) {
        pendingStatusRef.current?.focus();
        return;
      }
      if (suggestion?.sql) {
        applyButtonRef.current?.focus();
        return;
      }
      if (error) promptRef.current?.focus();
    };

    const frame = requestAnimationFrame(focusTarget);
    return () => cancelAnimationFrame(frame);
  }, [error, open, pending, promptRef, suggestion?.sql]);

  const handlePromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key !== "Enter"
      || event.shiftKey
      || event.nativeEvent.isComposing
      || generateDisabled
    ) {
      return;
    }

    event.preventDefault();
    void onGenerate();
  };

  return (
    <Popover onOpenChange={onOpenChange} open={open}>
      <PopoverTrigger asChild>
        <Button disabled={disabled} size="sm" type="button" variant="outline">
          <Sparkles data-icon="inline-start" /> AI로 SQL 작성
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className={cn(styles.popover, "grid gap-4")}
        onOpenAutoFocus={(event) => {
          if (!promptOpen) return;
          event.preventDefault();
          promptRef.current?.focus();
        }}
        side="bottom"
        sideOffset={8}
      >
        <div className="grid gap-3 rounded-xl border border-blue-200 bg-blue-50/70 p-3">
          <div className="flex items-start gap-3">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-blue-600">
              <Sparkles aria-hidden="true" className="size-4 text-white" />
            </span>
            <span className="min-w-0">
              <strong className="block text-sm font-semibold text-blue-950">AI</strong>
              <span className="mt-0.5 block text-sm leading-5 text-slate-600">
                선택한 데이터셋을 기준으로 자연어 요청을 SQL 초안으로 바꿔드릴게요.
              </span>
            </span>
          </div>

          <Collapsible open={promptOpen}>
            <CollapsibleContent>
              <FieldGroup className="gap-3">
                <Field data-invalid={Boolean(error)}>
                  <FieldLabel htmlFor="sql-query-ai-popover-prompt">어떤 SQL이 필요한가요?</FieldLabel>
                  <Textarea
                    aria-invalid={Boolean(error)}
                    className="border-blue-200 bg-white"
                    disabled={disabled || pending}
                    id="sql-query-ai-popover-prompt"
                    onChange={(event) => onPromptChange(event.target.value)}
                    onKeyDown={handlePromptKeyDown}
                    placeholder="예: 최근 30일 동안 카테고리별 주문 금액 합계를 큰 순서대로 보여줘"
                    ref={promptRef}
                    rows={4}
                    value={prompt}
                  />
                  {disabled && (
                    <FieldDescription>
                      먼저 분석 테이블에서 데이터셋을 선택해 주세요.
                    </FieldDescription>
                  )}
                  {error && <FieldError role="alert">{error}</FieldError>}
                </Field>
                <Button
                  className="w-full disabled:bg-slate-300 disabled:text-white disabled:opacity-100"
                  disabled={generateDisabled}
                  onClick={() => void onGenerate()}
                  type="button"
                  variant="primary"
                >
                  <Send data-icon="inline-start" /> SQL 초안 생성
                </Button>
              </FieldGroup>
            </CollapsibleContent>
          </Collapsible>
        </div>

        {pending && (
          <div className="outline-none" ref={pendingStatusRef} role="status" tabIndex={-1}>
            <Bubble className="max-w-full" variant="muted">
              <BubbleContent className="flex max-w-full items-center gap-2">
                <Spinner data-icon="inline-start" /> SQL 초안 생성 중…
              </BubbleContent>
            </Bubble>
          </div>
        )}

        {suggestion?.sql && (
          <BubbleGroup aria-live="polite">
            <SqlAiSuggestionSummary suggestion={suggestion} />
            <SqlAiJoinEvidence suggestion={suggestion} />
            <SqlAiSuggestionEvidence suggestion={suggestion} />
            <Bubble className="w-full max-w-full" variant="outline">
              <BubbleContent className="w-full max-w-full p-0">
                <ScrollArea className={styles.preview} scrollbars="both" type="always">
                  <pre>{suggestion.sql}</pre>
                </ScrollArea>
              </BubbleContent>
            </Bubble>
            <Bubble align="end" className="max-w-full" variant="default">
              <BubbleContent asChild>
                <Button
                  className="h-auto whitespace-normal"
                  disabled={disabled || pending}
                  onClick={() => onApply(suggestion.sql ?? "")}
                  ref={applyButtonRef}
                  type="button"
                  variant="primary"
                >
                  <Check data-icon="inline-start" /> 편집기에 적용
                </Button>
              </BubbleContent>
            </Bubble>
          </BubbleGroup>
        )}
      </PopoverContent>
    </Popover>
  );
}
