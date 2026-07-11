import type { KeyboardEvent, RefObject } from "react";
import { Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Panel } from "@/components/ui/panel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type { QueryAiSuggestion } from "../../services/queryAiService";
import { NessieMark } from "./NessieMark";

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

  const handlePromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key !== "Enter"
      || (!event.metaKey && !event.ctrlKey)
      || event.nativeEvent.isComposing
      || generateDisabled
    ) {
      return;
    }

    event.preventDefault();
    void onGenerate();
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="w-[min(calc(100vw-2rem),44rem)] max-w-none">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <NessieMark className="size-6" /> Nessie로 SQL 작성
          </DialogTitle>
          <DialogDescription>
            선택한 데이터셋과 현재 SQL을 기준으로 요청을 해석합니다. 생성된 초안은 자동 실행하지 않고 편집기에만 적용합니다.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field data-invalid={Boolean(error)}>
            <FieldLabel htmlFor="sql-query-ai-dialog-prompt">어떤 SQL이 필요한가요?</FieldLabel>
            <Textarea
              aria-invalid={Boolean(error)}
              disabled={disabled || pending}
              id="sql-query-ai-dialog-prompt"
              onChange={(event) => onPromptChange(event.target.value)}
              onKeyDown={handlePromptKeyDown}
              placeholder="예: 최근 30일 동안 카테고리별 주문 금액 합계를 큰 순서대로 보여줘"
              ref={promptRef}
              rows={4}
              value={prompt}
            />
            <FieldDescription>
              {disabled
                ? "먼저 분석 테이블에서 데이터셋을 선택해 주세요."
                : "⌘/Ctrl + Enter로도 SQL 초안을 생성할 수 있습니다."}
            </FieldDescription>
            {error && <FieldError role="alert">{error}</FieldError>}
          </Field>

          {suggestion?.sql && (
            <Panel className="grid gap-3 p-4" variant="muted">
              <div className="flex min-w-0 items-center justify-between gap-3">
                <strong className="truncate">{suggestion.title}</strong>
                <Badge size="sm" variant="secondary">SQL 초안</Badge>
              </div>
              <p className="text-sm leading-6 text-muted-foreground">{suggestion.body}</p>
              <ScrollArea className="sql-ai-dialog-preview" scrollbars="both" type="always">
                <pre>{suggestion.sql}</pre>
              </ScrollArea>
            </Panel>
          )}
        </FieldGroup>

        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)} variant="outline">취소</Button>
          <Button
            disabled={generateDisabled}
            onClick={() => void onGenerate()}
            type="button"
            variant="secondary"
          >
            {pending ? <Spinner data-icon="inline-start" /> : <Sparkles data-icon="inline-start" />}
            {pending ? "생성 중" : "SQL 초안 생성"}
          </Button>
          {suggestion?.sql && (
            <Button
              disabled={disabled || pending}
              onClick={() => onApply(suggestion.sql ?? "")}
              type="button"
              variant="primary"
            >
              편집기에 적용
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
