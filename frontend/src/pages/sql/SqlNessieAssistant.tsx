import type { RefObject } from "react";
import { Send } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Bubble, BubbleContent, BubbleGroup } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { NessieMark } from "./NessieMark";

const NESSIE_PROMPT_PLACEHOLDER = "만들고 싶은 분석을 자연어로 입력해 주세요.";

export type NessieMessage = {
  content: string;
  id: string;
  role: "assistant" | "user";
  sql?: string;
  tone?: "default" | "error";
};

export const INITIAL_NESSIE_MESSAGES: NessieMessage[] = [{
  content: "SQL 작성과 방금 실행한 결과의 차트 생성을 도와드릴게요.",
  id: "nessie-welcome",
  role: "assistant",
}];

function NessieAvatar({ compact = false }: { compact?: boolean }) {
  return (
    <Avatar className="rounded-lg bg-muted p-1" size={compact ? "default" : "lg"}>
      <NessieMark className="size-full" />
      <AvatarFallback className="rounded-md">NS</AvatarFallback>
    </Avatar>
  );
}

export function SqlNessieAssistant({
  error,
  messages,
  onApplySuggestion,
  onPromptChange,
  onSubmit,
  pending,
  prompt,
  promptRef,
}: {
  error: string | null;
  messages: NessieMessage[];
  onApplySuggestion: (sql: string) => void;
  onPromptChange: (prompt: string) => void;
  onSubmit: () => void | Promise<void>;
  pending: boolean;
  prompt: string;
  promptRef: RefObject<HTMLTextAreaElement | null>;
}) {
  return (
    <Card
      className="grid h-full min-h-0 min-w-0 grid-rows-[max-content_1px_minmax(0,1fr)_1px_max-content] overflow-hidden"
      size="none"
    >
      <CardHeader className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 p-3">
        <NessieAvatar />
        <CardTitle>Nessie</CardTitle>
        <CardDescription className="col-start-2">
          SQL과 차트를 함께 완성해요.
        </CardDescription>
      </CardHeader>
      <Separator />
      <CardContent className="min-h-0 p-0">
        <ScrollArea
          className="h-full min-h-0"
          type="always"
          viewportProps={{ className: "[&>div]:!block [&>div]:h-full" }}
        >
          <BubbleGroup aria-live="polite" className="h-full justify-end p-4 pr-5">
            {messages.map((message) => (
              <div
                className={cn(
                  "flex min-w-0 items-end gap-2",
                  message.role === "user" && "justify-end",
                )}
                key={message.id}
              >
                {message.role === "assistant" && <NessieAvatar compact />}
                <Bubble
                  align={message.role === "user" ? "end" : "start"}
                  className="sql-ai-suggestion"
                  role={message.tone === "error" ? "alert" : undefined}
                  variant={message.role === "user" ? "default" : message.tone === "error" ? "destructive" : "secondary"}
                >
                  <BubbleContent className="grid gap-2">
                    <span>{message.content}</span>
                    {message.sql && <pre>{message.sql}</pre>}
                    {message.sql && (
                      <Button onClick={() => onApplySuggestion(message.sql ?? "")} type="button" size="sm" variant="primary">
                        SQL에 적용
                      </Button>
                    )}
                  </BubbleContent>
                </Bubble>
              </div>
            ))}
            {pending && (
              <div className="flex min-w-0 items-end gap-2">
                <NessieAvatar compact />
                <Bubble variant="muted">
                  <BubbleContent>Nessie가 SQL 초안을 만들고 있습니다.</BubbleContent>
                </Bubble>
              </div>
            )}
          </BubbleGroup>
        </ScrollArea>
      </CardContent>
      <Separator />
      <CardFooter className="min-w-0 p-3">
        <Field className="min-w-0" data-invalid={Boolean(error)}>
          <FieldLabel className="sr-only" htmlFor="sql-query-ai-prompt">Nessie에게 요청</FieldLabel>
          <InputGroup className="min-w-0 items-end focus-within:ring-0 focus-within:ring-offset-0">
            <InputGroupTextarea
              aria-invalid={Boolean(error)}
              className="min-h-[72px] max-h-[120px]"
              disabled={pending}
              id="sql-query-ai-prompt"
              onChange={(event) => onPromptChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey) return;
                event.preventDefault();
                void onSubmit();
              }}
              placeholder={NESSIE_PROMPT_PLACEHOLDER}
              ref={promptRef}
              rows={3}
              value={prompt}
            />
            <InputGroupAddon className="h-auto self-end px-1 pb-1">
              <Button
                aria-label="Nessie에게 보내기"
                disabled={pending || prompt.trim().length === 0}
                onClick={onSubmit}
                type="button"
                size="icon"
                variant="primary"
              >
                <Send />
              </Button>
            </InputGroupAddon>
          </InputGroup>
        </Field>
      </CardFooter>
    </Card>
  );
}
