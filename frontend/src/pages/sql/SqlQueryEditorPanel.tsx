import type { KeyboardEventHandler, RefObject } from "react";
import {
  SQL_PAGE_PANEL_ICON_CLASS_NAME,
  SqlPageIcon as PlayCircle,
  SqlPageIcon as RotateCcw,
  SqlPageIcon as Table2,
} from "./SqlPageIcon";

import { ActionGroup } from "@/components/ui/action-group";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldLabel } from "@/components/ui/field";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import type { QueryAiSuggestion } from "../../services/queryAiService";
import styles from "./SqlAnalysisPage.module.css";
import { SqlAiWriterDialog } from "./SqlAiWriterDialog";
import type { AutocompleteCandidate } from "./sqlLogic";

type PreflightSummary = {
  detail?: string;
  label: string;
  tone: "error" | "success" | "warning";
};

type SqlQueryEditorPanelProps = {
  ai: {
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
  autocompleteCandidates: AutocompleteCandidate[];
  autocompleteIndex: number;
  canExecute: boolean;
  disabled: boolean;
  lineNumberRef: RefObject<HTMLPreElement | null>;
  lineNumbers: string;
  onAutocompleteSelect: (candidate: AutocompleteCandidate) => void;
  onEditorBlur: () => void;
  onEditorCursorChange: (textarea: HTMLTextAreaElement) => void;
  onEditorKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  onExecute: () => void;
  onQueryChange: (query: string, cursorIndex: number) => void;
  onReset: () => void;
  onScroll: () => void;
  pending: boolean;
  preflightSummary: PreflightSummary | null;
  query: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
};

export function SqlQueryEditorPanel({
  ai,
  autocompleteCandidates,
  autocompleteIndex,
  canExecute,
  disabled,
  lineNumberRef,
  lineNumbers,
  onAutocompleteSelect,
  onEditorBlur,
  onEditorCursorChange,
  onEditorKeyDown,
  onExecute,
  onQueryChange,
  onReset,
  onScroll,
  pending,
  preflightSummary,
  query,
  textareaRef,
}: SqlQueryEditorPanelProps) {
  return (
    <Panel className={`${styles.queryPanel} grid gap-0 p-0`}>
      <PanelHeader
        actions={(
          <ActionGroup density="compact" wrap="wrap">
            <SqlAiWriterDialog disabled={disabled} {...ai} />
            <Button type="button" onClick={onReset} size="sm" variant="outline">
              <RotateCcw data-icon="inline-start" /> SQL 초기화
            </Button>
            <Button type="button" onClick={onExecute} disabled={!canExecute || pending} size="sm" variant="primary">
              <PlayCircle data-icon="inline-start" /> {pending ? "실행 중" : "실행"}
            </Button>
          </ActionGroup>
        )}
        icon={<Table2 size={16} />}
        iconClassName={SQL_PAGE_PANEL_ICON_CLASS_NAME}
        iconVariant="outline"
        size="section"
        title="선택 데이터셋 기준 SQL"
      />

      <div className="grid gap-4 px-5 pb-5 pt-4">
        <div className={styles.editorSurface}>
          <pre ref={lineNumberRef} aria-hidden="true">{lineNumbers}</pre>
          <div className={styles.editorInputWrap}>
            <FieldLabel className="sr-only" htmlFor="sql-query-editor">SQL editor</FieldLabel>
            <Textarea
              className="focus-visible:ring-0 focus-visible:ring-offset-0"
              id="sql-query-editor"
              ref={textareaRef}
              disabled={disabled}
              placeholder={disabled ? "왼쪽 분석 테이블에서 데이터셋을 선택하면 SQL을 작성할 수 있습니다." : "SQL을 입력하세요."}
              value={query}
              onChange={(event) => onQueryChange(event.target.value, event.target.selectionStart)}
              onClick={(event) => onEditorCursorChange(event.currentTarget)}
              onBlur={onEditorBlur}
              onKeyDown={onEditorKeyDown}
              onKeyUp={(event) => {
                if (["ArrowDown", "ArrowUp", "Tab", "Escape"].includes(event.key)) return;
                onEditorCursorChange(event.currentTarget);
              }}
              onScroll={onScroll}
              spellCheck={false}
            />
            {autocompleteCandidates.length > 0 && (
              <Panel className={styles.autocompletePopover}>
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
                        onClick={() => onAutocompleteSelect(candidate)}
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

        {preflightSummary && (
          <div className={styles.editorFooter}>
            <div className={styles.editorStatusLine}>
              <Badge size="sm" variant={preflightSummary.tone === "error" ? "destructive" : "warning"}>
                {preflightSummary.label}
              </Badge>
              {preflightSummary.detail && (
                <Badge size="sm" variant={preflightSummary.tone === "error" ? "destructive" : "warning"}>
                  {preflightSummary.detail}
                </Badge>
              )}
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}
