import type { ComponentProps, ReactNode, RefObject, UIEvent } from "react";
import { useMemo, useRef } from "react";

import { FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import styles from "./SqlCodeEditor.module.css";

type SqlCodeEditorProps = Omit<ComponentProps<typeof Textarea>, "ref" | "variant"> & {
  label?: string;
  minLineCount?: number;
  overlay?: ReactNode;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  variant?: "compact" | "default";
};

export function SqlCodeEditor({
  className,
  id,
  label = "SQL editor",
  minLineCount = 7,
  onScroll,
  overlay,
  textareaRef,
  value,
  variant = "default",
  ...textareaProps
}: SqlCodeEditorProps) {
  const lineNumberRef = useRef<HTMLPreElement | null>(null);
  const lineNumbers = useMemo(() => {
    const lineCount = Math.max(String(value ?? "").split("\n").length, minLineCount);
    return Array.from({ length: lineCount }, (_, index) => index + 1).join("\n");
  }, [minLineCount, value]);

  const syncScroll = (event: UIEvent<HTMLTextAreaElement>) => {
    if (lineNumberRef.current) lineNumberRef.current.scrollTop = event.currentTarget.scrollTop;
    onScroll?.(event);
  };

  return (
    <div className={cn(styles.editorSurface, variant === "compact" && styles.compact)}>
      <pre ref={lineNumberRef} aria-hidden="true" className={styles.lineNumbers}>{lineNumbers}</pre>
      <div className={styles.editorInputWrap}>
        {id && <FieldLabel className="sr-only" htmlFor={id}>{label}</FieldLabel>}
        <Textarea
          {...textareaProps}
          className={cn(styles.editorInput, className)}
          id={id}
          ref={textareaRef}
          onScroll={syncScroll}
          spellCheck={false}
          value={value}
        />
        {overlay}
      </div>
    </div>
  );
}
