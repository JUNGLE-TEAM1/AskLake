import { ChevronDown, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { FormFieldGroup } from "@/components/ui/form-field-group";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

export type DashboardComboboxOption = {
  label: string;
  value: string;
};

export function DashboardFieldCombobox({
  className,
  disabled = false,
  fieldClassName,
  label,
  onValueChange,
  options,
  placeholder = "선택하세요",
  value,
}: {
  className?: string;
  disabled?: boolean;
  fieldClassName?: string;
  label: string;
  onValueChange: (value: string) => void;
  options: DashboardComboboxOption[];
  placeholder?: string;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selectedOption = options.find((option) => option.value === value);
  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return options;
    return options.filter((option) => option.label.toLocaleLowerCase().includes(normalizedQuery));
  }, [options, query]);

  const selectOption = (nextValue: string) => {
    onValueChange(nextValue);
    setOpen(false);
    setQuery("");
  };

  return (
    <FormFieldGroup className={cn("min-w-0 w-full", fieldClassName)} label={label}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            aria-expanded={open}
            className={cn(
              "asklake-widget-combobox w-full min-w-0 max-w-full justify-between overflow-hidden text-left",
              className,
            )}
            disabled={disabled}
            role="combobox"
            type="button"
            variant="outline"
          >
            <span className="min-w-0 flex-1 truncate">{selectedOption?.label ?? placeholder}</span>
            <ChevronDown className="shrink-0" data-icon="inline-end" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              className="pl-9"
              placeholder={`${label} 검색`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && filteredOptions.length === 1) {
                  event.preventDefault();
                  selectOption(filteredOptions[0].value);
                }
              }}
            />
          </div>
          <ScrollArea className="mt-2 max-h-56" type="always">
            <div className="grid gap-1 pr-2" role="listbox" aria-label={label}>
              {filteredOptions.length ? filteredOptions.map((option) => (
                <Button
                  aria-selected={option.value === value}
                  className="justify-start"
                  key={option.value}
                  role="option"
                  size="sm"
                  type="button"
                  variant={option.value === value ? "secondary" : "ghost"}
                  onClick={() => selectOption(option.value)}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-2 shrink-0 rounded-full bg-current",
                      option.value === value ? "opacity-100" : "opacity-0",
                    )}
                    data-icon="inline-start"
                  />
                  <span className="truncate">{option.label}</span>
                </Button>
              )) : <p className="px-2 py-3 text-sm text-muted-foreground">검색 결과가 없습니다.</p>}
            </div>
          </ScrollArea>
        </PopoverContent>
      </Popover>
    </FormFieldGroup>
  );
}
