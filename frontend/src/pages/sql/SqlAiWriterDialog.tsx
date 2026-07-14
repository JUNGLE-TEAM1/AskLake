import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import {
  SqlPageIcon as Check,
  SqlPageIcon as Sparkles,
} from "./SqlPageIcon";

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
import { NessieMark } from "./NessieMark";
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
          <NessieMark className="size-5" /> Nessie로 SQL 작성
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
        <BubbleGroup aria-live="polite">
          <Bubble className="max-w-full" variant="tinted">
            <BubbleContent className="max-w-full">
              <span className="flex items-center gap-2 font-semibold">
                <NessieMark className="size-5" /> Nessie
              </span>
              <span className="mt-1 block text-sm">
                선택한 데이터셋을 기준으로 자연어 요청을 SQL 초안으로 바꿔드릴게요.
              </span>
            </BubbleContent>
          </Bubble>
        </BubbleGroup>

        <Collapsible open={promptOpen}>
          <CollapsibleContent>
            <FieldGroup>
              <Field data-invalid={Boolean(error)}>
                <FieldLabel htmlFor="sql-query-ai-popover-prompt">어떤 SQL이 필요한가요?</FieldLabel>
                <Textarea
                  aria-invalid={Boolean(error)}
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
                className="w-full"
                disabled={generateDisabled}
                onClick={() => void onGenerate()}
                type="button"
                variant="secondary"
              >
                <Sparkles data-icon="inline-start" /> SQL 초안 생성
              </Button>
            </FieldGroup>
          </CollapsibleContent>
        </Collapsible>

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
            <Bubble className="max-w-full" variant="secondary">
              <BubbleContent className="max-w-full">
                <span className="flex min-w-0 items-center justify-between gap-3">
                  <strong className="truncate">{suggestion.title}</strong>
                  <Badge size="sm" variant="secondary">SQL 초안</Badge>
                </span>
                <span className="mt-1 block text-sm text-muted-foreground">{suggestion.body}</span>
              </BubbleContent>
            </Bubble>
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
