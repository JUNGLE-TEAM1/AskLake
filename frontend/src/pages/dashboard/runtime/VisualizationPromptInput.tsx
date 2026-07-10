import { type FormEvent, forwardRef, useImperativeHandle, useRef } from "react";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupTextarea } from "@/components/ui/input-group";

export type VisualizationPromptInputHandle = {
  focus: () => void;
  blur: () => void;
};

export const VisualizationPromptInput = forwardRef<
  VisualizationPromptInputHandle,
  {
    ariaLabel?: string;
    disabled?: boolean;
    isSubmitting?: boolean;
    onBlur?: () => void;
    onCancel?: () => void;
    onFocus?: () => void;
    onSubmit: () => void;
    onValueChange: (value: string) => void;
    placeholder: string;
    rows?: number;
    submitAriaLabel?: string;
    textareaClassName?: string;
    value: string;
  }
>(({
  ariaLabel = "시각화 요청",
  disabled = false,
  isSubmitting = false,
  onBlur,
  onCancel,
  onFocus,
  onSubmit,
  onValueChange,
  placeholder,
  rows = 1,
  submitAriaLabel = "Assistant 요청",
  textareaClassName,
  value,
}, ref) => {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const canSubmit = Boolean(value.trim()) && !disabled && !isSubmitting;

  useImperativeHandle(ref, () => ({
    blur: () => textareaRef.current?.blur(),
    focus: () => textareaRef.current?.focus(),
  }), []);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    onSubmit();
  };

  return (
    <form className="asklake-visualization-prompt-input" onSubmit={handleSubmit}>
      <InputGroup className="items-end p-1.5">
        <InputGroupTextarea
          aria-label={ariaLabel}
          className={textareaClassName ?? "min-h-11 px-3 py-2 text-sm font-medium"}
          disabled={disabled || isSubmitting}
          placeholder={placeholder}
          ref={textareaRef}
          rows={rows}
          value={value}
          onBlur={onBlur}
          onChange={(event) => onValueChange(event.target.value)}
          onFocus={onFocus}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              onCancel?.();
              event.currentTarget.blur();
            }
          }}
        />
        <Button aria-label={submitAriaLabel} disabled={!canSubmit} size="icon" type="submit">
          {isSubmitting ? <Loader2 className="animate-spin" /> : <Send />}
        </Button>
      </InputGroup>
    </form>
  );
});
VisualizationPromptInput.displayName = "VisualizationPromptInput";
