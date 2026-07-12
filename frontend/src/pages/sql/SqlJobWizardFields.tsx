import { useEffect, useRef, useState } from "react";
import { Clock3 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";

export type WizardSelectOption<T extends string> = {
  label: string;
  value: T;
};

const timeHourOptions = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0"));
const timeMinuteOptions = Array.from({ length: 60 }, (_, minute) => String(minute).padStart(2, "0"));

export function WizardSelectField<T extends string>({
  className,
  disabled,
  id,
  label,
  onValueChange,
  options,
  value,
}: {
  className?: string;
  disabled?: boolean;
  id: string;
  label: string;
  onValueChange: (value: T) => void;
  options: ReadonlyArray<WizardSelectOption<T>>;
  value: T;
}) {
  const selectedOption = options.find((option) => option.value === value);

  return (
    <Field className={className}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={label}
            className="w-full min-w-0 max-w-full justify-start overflow-hidden text-left"
            disabled={disabled}
            id={id}
            type="button"
            variant="outline"
          >
            <span className="min-w-0 flex-1 truncate text-left">
              {selectedOption?.label ?? "선택해 주세요"}
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-40">
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup onValueChange={(nextValue) => onValueChange(nextValue as T)} value={value}>
            {options.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                <span className="min-w-0 truncate">{option.label}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </Field>
  );
}

function formatWizardTime(value: string) {
  const [hourText = "00", minute = "00"] = value.split(":");
  const hour = Number(hourText);
  const period = hour < 12 ? "오전" : "오후";
  const displayHour = String(hour % 12 || 12).padStart(2, "0");
  return `${period} ${displayHour}:${minute}`;
}

export function WizardTimeField({
  disabled,
  id,
  label,
  onValueChange,
  value,
}: {
  disabled?: boolean;
  id: string;
  label: string;
  onValueChange: (value: string) => void;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const selectedHourRef = useRef<HTMLButtonElement>(null);
  const selectedMinuteRef = useRef<HTMLButtonElement>(null);
  const [hour = "00", minute = "00"] = value.split(":");

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      selectedHourRef.current?.scrollIntoView({ block: "center" });
      selectedMinuteRef.current?.scrollIntoView({ block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [hour, minute, open]);

  const renderOptions = (options: string[], selectedValue: string, onSelect: (option: string) => void, suffix: string) => (
    <ScrollArea className="h-52 rounded-lg border border-slate-200">
      <div className="grid gap-1 p-1 pr-3">
        {options.map((option) => {
          const selected = option === selectedValue;
          return (
            <Button
              aria-pressed={selected}
              className="w-full justify-center"
              key={option}
              onClick={() => onSelect(option)}
              ref={selected ? (suffix === "시" ? selectedHourRef : selectedMinuteRef) : undefined}
              size="sm"
              type="button"
              variant={selected ? "subtle" : "ghost"}
            >
              {option}{suffix}
            </Button>
          );
        })}
      </div>
    </ScrollArea>
  );

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <Button
            className="w-full min-w-0 max-w-full justify-between overflow-hidden text-left"
            disabled={disabled}
            id={id}
            type="button"
            variant="outline"
          >
            <span className="min-w-0 flex-1 truncate text-left">{formatWizardTime(value)}</span>
            <Clock3 aria-hidden="true" className="text-slate-500" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="grid w-72 gap-3 p-3">
          <div className="grid gap-1">
            <strong className="text-sm">실행 시간</strong>
            <small className="text-xs text-slate-500">시와 분을 각각 선택해 주세요.</small>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <span className="text-xs font-semibold text-slate-500">시</span>
              {renderOptions(timeHourOptions, hour, (option) => onValueChange(`${option}:${minute}`), "시")}
            </div>
            <div className="grid gap-1.5">
              <span className="text-xs font-semibold text-slate-500">분</span>
              {renderOptions(timeMinuteOptions, minute, (option) => onValueChange(`${hour}:${option}`), "분")}
            </div>
          </div>
          <Button onClick={() => setOpen(false)} size="sm" type="button">완료</Button>
        </PopoverContent>
      </Popover>
    </Field>
  );
}
