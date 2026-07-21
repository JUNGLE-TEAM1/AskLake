import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Loader2, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import type {
  DashboardWidgetFilter,
  DashboardWidgetFilterOperator,
  DashboardWidgetFilterValue,
} from "../../../types";
import { DashboardFieldCombobox } from "./DashboardFieldCombobox";
import type { DashboardDatasetColumn, DashboardDatasetOption } from "./dashboardRuntimeTypes";
import {
  MAX_DASHBOARD_WIDGET_FILTERS,
  createDashboardWidgetFilter,
  dashboardContextFilters,
  dashboardFilterInputValue,
  dashboardFilterNeedsValue,
  dashboardFilterOperatorOptions,
  localDashboardFilterValues,
} from "./widgetFilters";
import {
  getDashboardDatasetFilterValues,
  type DashboardFilterValueOption,
} from "./dashboardCatalogApi";

let fallbackFilterId = 0;

function nextFilterId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `filter-${globalThis.crypto.randomUUID()}`;
  }
  fallbackFilterId += 1;
  return `filter-${Date.now()}-${fallbackFilterId}`;
}

function filterValueIdentity(value: DashboardWidgetFilterValue) {
  return `${typeof value}:${String(value)}`;
}

function filterValueLabel(value: DashboardWidgetFilterValue) {
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function FilterValuePicker({
  column,
  contextFilters,
  dataset,
  filter,
  onChange,
}: {
  column: DashboardDatasetColumn;
  contextFilters: DashboardWidgetFilter[];
  dataset: DashboardDatasetOption;
  filter: DashboardWidgetFilter;
  onChange: (patch: Partial<DashboardWidgetFilter>) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<DashboardFilterValueOption[]>([]);
  const [query, setQuery] = useState("");
  const [truncated, setTruncated] = useState(false);
  const contextKey = useMemo(() => JSON.stringify(contextFilters), [contextFilters]);
  const isMultiple = filter.operator === "in";
  const selectedValues = isMultiple
    ? filter.values ?? []
    : filter.value === undefined ? [] : [filter.value];
  const selectedIdentities = new Set(selectedValues.map(filterValueIdentity));
  const buttonLabel = selectedValues.length
    ? selectedValues.map(filterValueLabel).join(", ")
    : "값 선택";

  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const timeoutId = globalThis.setTimeout(() => {
      const localRows = dataset.rows;
      if (localRows) {
        const result = localDashboardFilterValues(
          localRows,
          column.name,
          contextFilters,
          query,
          50,
        );
        setOptions(result.values.map((value) => ({ label: filterValueLabel(value), value })));
        setTruncated(result.truncated);
        setLoading(false);
        return;
      }

      void getDashboardDatasetFilterValues(
        dataset.id,
        {
          column: column.name,
          contextFilters,
          limit: 50,
          search: query,
        },
        { signal: controller.signal },
      ).then((response) => {
        if (controller.signal.aborted) return;
        setOptions(response.values);
        setTruncated(response.truncated);
      }).catch((requestError: unknown) => {
        if (controller.signal.aborted) return;
        setOptions([]);
        setTruncated(false);
        setError(requestError instanceof Error ? requestError.message : "필터 값을 불러오지 못했습니다.");
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    }, 300);

    return () => {
      globalThis.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [column.name, contextKey, dataset, open, query]);

  const selectValue = (value: DashboardWidgetFilterValue) => {
    if (!isMultiple) {
      onChange({ value, values: undefined });
      setOpen(false);
      setQuery("");
      return;
    }
    const identity = filterValueIdentity(value);
    const nextValues = selectedIdentities.has(identity)
      ? selectedValues.filter((candidate) => filterValueIdentity(candidate) !== identity)
      : [...selectedValues, value];
    onChange({ value: undefined, values: nextValues });
  };

  return (
    <div className="asklake-widget-filter-value-field">
      <span>값</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            aria-expanded={open}
            className="asklake-widget-filter-value-trigger"
            role="combobox"
            type="button"
            variant="outline"
          >
            <span>{buttonLabel}</span>
            <ChevronDown aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              className="pl-9"
              placeholder="실제 데이터 값 검색"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
              }}
            />
          </div>
          <ScrollArea className="mt-2 h-52" type="always">
            <div className="grid gap-1 pr-2" role="listbox" aria-label={`${column.name} 값`}>
              {loading ? (
                <p className="asklake-widget-filter-value-status"><Loader2 className="animate-spin" /> 값을 조회하는 중입니다.</p>
              ) : error ? (
                <p className="asklake-widget-filter-value-error">{error}</p>
              ) : options.length ? options.map((option) => {
                const selected = selectedIdentities.has(filterValueIdentity(option.value));
                return (
                  <Button
                    aria-selected={selected}
                    className="justify-start"
                    key={filterValueIdentity(option.value)}
                    role="option"
                    size="sm"
                    type="button"
                    variant={selected ? "secondary" : "ghost"}
                    onClick={() => selectValue(option.value)}
                  >
                    <Check aria-hidden="true" className={selected ? "opacity-100" : "opacity-0"} />
                    <span className="truncate">{option.label}</span>
                  </Button>
                );
              }) : (
                <p className="asklake-widget-filter-value-status">일치하는 값이 없습니다.</p>
              )}
            </div>
          </ScrollArea>
          {truncated ? <p className="asklake-widget-filter-value-hint">일부 값만 표시됩니다. 검색어를 입력해 좁혀보세요.</p> : null}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function FilterInput({
  column,
  contextFilters,
  dataset,
  filter,
  onChange,
}: {
  column: DashboardDatasetColumn;
  contextFilters: DashboardWidgetFilter[];
  dataset: DashboardDatasetOption;
  filter: DashboardWidgetFilter;
  onChange: (patch: Partial<DashboardWidgetFilter>) => void;
}) {
  if (!dashboardFilterNeedsValue(filter.operator)) {
    return <p className="asklake-widget-filter-null-hint">이 조건에는 값을 입력하지 않습니다.</p>;
  }
  if (column.type === "string" && (filter.operator === "eq" || filter.operator === "in")) {
    return (
      <FilterValuePicker
        column={column}
        contextFilters={contextFilters}
        dataset={dataset}
        filter={filter}
        onChange={onChange}
      />
    );
  }
  if (filter.operator === "between") {
    const values = filter.values ?? [];
    const inputType = column.type === "number" ? "number" : "datetime-local";
    return (
      <div className="asklake-widget-filter-range">
        <label>
          <span>시작</span>
          <Input
            size="sm"
            type={inputType}
            value={String(values[0] ?? "")}
            onChange={(event) => onChange({
              value: undefined,
              values: [
                dashboardFilterInputValue(event.target.value, column.type) ?? "",
                values[1] ?? "",
              ],
            })}
          />
        </label>
        <label>
          <span>종료</span>
          <Input
            size="sm"
            type={inputType}
            value={String(values[1] ?? "")}
            onChange={(event) => onChange({
              value: undefined,
              values: [
                values[0] ?? "",
                dashboardFilterInputValue(event.target.value, column.type) ?? "",
              ],
            })}
          />
        </label>
      </div>
    );
  }
  return (
    <label className="asklake-widget-filter-input">
      <span>값</span>
      <Input
        placeholder={filter.operator === "contains" ? "포함할 텍스트" : "값 입력"}
        size="sm"
        type={column.type === "number" ? "number" : column.type === "date" ? "datetime-local" : "text"}
        value={String(filter.value ?? "")}
        onChange={(event) => onChange({
          value: dashboardFilterInputValue(event.target.value, column.type),
          values: undefined,
        })}
      />
    </label>
  );
}

export function WidgetFilterEditor({
  dataset,
  filters,
  onChange,
}: {
  dataset: DashboardDatasetOption;
  filters: DashboardWidgetFilter[];
  onChange: (filters: DashboardWidgetFilter[]) => void;
}) {
  const columnsByName = useMemo(
    () => new Map(dataset.columns.map((column) => [column.name, column])),
    [dataset.columns],
  );

  const patchFilter = (index: number, patch: Partial<DashboardWidgetFilter>) => {
    onChange(filters.map((filter, filterIndex) => (
      filterIndex === index ? { ...filter, ...patch } : filter
    )));
  };

  return (
    <section className="asklake-widget-filter-editor" aria-labelledby="asklake-widget-filter-title">
      <div className="asklake-widget-filter-heading">
        <div>
          <strong id="asklake-widget-filter-title">필터 조건</strong>
          <span>현재 위젯에만 적용됩니다.</span>
        </div>
        <Button
          disabled={!dataset.columns.length || filters.length >= MAX_DASHBOARD_WIDGET_FILTERS}
          size="sm"
          type="button"
          variant="outline"
          onClick={() => onChange([
            ...filters,
            createDashboardWidgetFilter(nextFilterId(), dataset.columns[0]),
          ])}
        >
          <Plus aria-hidden="true" /> 조건 추가
        </Button>
      </div>

      {filters.length ? (
        <div className="asklake-widget-filter-list">
          {filters.map((filter, index) => {
            const column = columnsByName.get(filter.column) ?? dataset.columns[0];
            const operatorOptions = dashboardFilterOperatorOptions(column?.type ?? "string");
            return (
              <div className="asklake-widget-filter-card" key={filter.id}>
                <div className="asklake-widget-filter-card-heading">
                  <span>{index === 0 ? "조건" : "그리고"} {index + 1}</span>
                  <Button
                    aria-label={`필터 조건 ${index + 1} 삭제`}
                    size="icon"
                    type="button"
                    variant="ghost"
                    onClick={() => onChange(filters.filter((_, filterIndex) => filterIndex !== index))}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
                <DashboardFieldCombobox
                  label="컬럼"
                  options={dataset.columns.map((candidate) => ({ label: candidate.name, value: candidate.name }))}
                  value={filter.column}
                  onValueChange={(columnName) => patchFilter(index, {
                    column: columnName,
                    operator: "eq",
                    value: undefined,
                    values: undefined,
                  })}
                />
                <DashboardFieldCombobox
                  label="조건"
                  options={operatorOptions}
                  value={filter.operator}
                  onValueChange={(operator) => patchFilter(index, {
                    operator: operator as DashboardWidgetFilterOperator,
                    value: undefined,
                    values: undefined,
                  })}
                />
                {column ? (
                  <FilterInput
                    column={column}
                    contextFilters={dashboardContextFilters(filters, index)}
                    dataset={dataset}
                    filter={filter}
                    onChange={(patch) => patchFilter(index, patch)}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="asklake-widget-filter-empty">조건을 추가하면 같은 데이터셋으로 위젯마다 다른 결과를 만들 수 있습니다.</p>
      )}
    </section>
  );
}
