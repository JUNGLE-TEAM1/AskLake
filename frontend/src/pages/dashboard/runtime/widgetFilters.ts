import type {
  DashboardWidgetFilter,
  DashboardWidgetFilterOperator,
  DashboardWidgetFilterValue,
} from "../../../types";
import type { DashboardDatasetColumn } from "./dashboardRuntimeTypes";

export const MAX_DASHBOARD_WIDGET_FILTERS = 5;
export const MAX_DASHBOARD_FILTER_VALUES = 50;

export type DashboardFilterOperatorOption = {
  label: string;
  value: DashboardWidgetFilterOperator;
};

const nullOperatorOptions: DashboardFilterOperatorOption[] = [
  { label: "비어 있음", value: "is_null" },
  { label: "비어 있지 않음", value: "is_not_null" },
];

const operatorOptionsByType: Record<DashboardDatasetColumn["type"], DashboardFilterOperatorOption[]> = {
  date: [
    { label: "같음", value: "eq" },
    { label: "이후", value: "gt" },
    { label: "이후 또는 같음", value: "gte" },
    { label: "이전", value: "lt" },
    { label: "이전 또는 같음", value: "lte" },
    { label: "범위", value: "between" },
    ...nullOperatorOptions,
  ],
  number: [
    { label: "같음", value: "eq" },
    { label: "초과", value: "gt" },
    { label: "이상", value: "gte" },
    { label: "미만", value: "lt" },
    { label: "이하", value: "lte" },
    { label: "범위", value: "between" },
    ...nullOperatorOptions,
  ],
  string: [
    { label: "같음", value: "eq" },
    { label: "여러 값 중 하나", value: "in" },
    { label: "포함", value: "contains" },
    ...nullOperatorOptions,
  ],
};

export function dashboardFilterOperatorOptions(
  columnType: DashboardDatasetColumn["type"],
) {
  return operatorOptionsByType[columnType];
}

export function createDashboardWidgetFilter(
  id: string,
  column?: DashboardDatasetColumn,
): DashboardWidgetFilter {
  return {
    column: column?.name ?? "",
    id,
    operator: "eq",
  };
}

export function dashboardFilterNeedsValue(operator: DashboardWidgetFilterOperator) {
  return operator !== "is_null" && operator !== "is_not_null";
}

export function dashboardFilterIsComplete(filter: DashboardWidgetFilter) {
  if (!filter.id.trim() || !filter.column.trim()) return false;
  if (!dashboardFilterNeedsValue(filter.operator)) return true;
  if (filter.operator === "in") {
    return Boolean(filter.values?.length && filter.values.length <= MAX_DASHBOARD_FILTER_VALUES);
  }
  if (filter.operator === "between") {
    return filter.values?.length === 2 && filter.values.every(hasFilterValue);
  }
  return hasFilterValue(filter.value);
}

function hasFilterValue(value: DashboardWidgetFilterValue | undefined) {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length > 0;
  return typeof value === "boolean";
}

export function normalizeDashboardWidgetFilters(filters: DashboardWidgetFilter[]) {
  return filters
    .filter(dashboardFilterIsComplete)
    .slice(0, MAX_DASHBOARD_WIDGET_FILTERS)
    .map((filter) => {
      if (!dashboardFilterNeedsValue(filter.operator)) {
        return {
          column: filter.column,
          id: filter.id,
          operator: filter.operator,
        };
      }
      if (filter.operator === "in" || filter.operator === "between") {
        return {
          column: filter.column,
          id: filter.id,
          operator: filter.operator,
          values: filter.values?.slice(0, MAX_DASHBOARD_FILTER_VALUES),
        };
      }
      return {
        column: filter.column,
        id: filter.id,
        operator: filter.operator,
        value: filter.value,
      };
    });
}

export function dashboardWidgetFiltersFromConfig(value: unknown): DashboardWidgetFilter[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const column = typeof record.column === "string" ? record.column.trim() : "";
    const operator = typeof record.operator === "string" ? record.operator : "";
    const supportedOperator = [
      "eq", "in", "contains", "gt", "gte", "lt", "lte", "between", "is_null", "is_not_null",
    ].includes(operator);
    if (!id || !column || !supportedOperator) return [];
    const filter: DashboardWidgetFilter = {
      column,
      id,
      operator: operator as DashboardWidgetFilterOperator,
    };
    if (typeof record.value === "string" || typeof record.value === "number" || typeof record.value === "boolean") {
      filter.value = record.value;
    }
    if (Array.isArray(record.values)) {
      filter.values = record.values.filter((candidate): candidate is DashboardWidgetFilterValue => (
        typeof candidate === "string" || typeof candidate === "number" || typeof candidate === "boolean"
      ));
    }
    return [filter];
  }).slice(0, MAX_DASHBOARD_WIDGET_FILTERS);
}

export function reconcileDashboardWidgetFilters(
  filters: DashboardWidgetFilter[],
  columns: DashboardDatasetColumn[],
) {
  const columnsByName = new Map(columns.map((column) => [column.name, column]));
  return filters.flatMap((filter) => {
    const column = columnsByName.get(filter.column);
    if (!column) return [];
    const supportedOperators = dashboardFilterOperatorOptions(column.type).map((option) => option.value);
    if (!supportedOperators.includes(filter.operator)) {
      return [{ ...filter, operator: "eq" as const, value: undefined, values: undefined }];
    }
    return [filter];
  }).slice(0, MAX_DASHBOARD_WIDGET_FILTERS);
}

export function validateDashboardWidgetFilters(
  filters: DashboardWidgetFilter[],
  columns: DashboardDatasetColumn[],
) {
  if (filters.length > MAX_DASHBOARD_WIDGET_FILTERS) {
    return `필터 조건은 최대 ${MAX_DASHBOARD_WIDGET_FILTERS}개까지 추가할 수 있습니다.`;
  }
  const columnsByName = new Map(columns.map((column) => [column.name, column]));
  const ids = new Set<string>();
  for (const filter of filters) {
    if (ids.has(filter.id)) return "중복된 필터 조건이 있습니다.";
    ids.add(filter.id);
    const column = columnsByName.get(filter.column);
    if (!column) return "필터 컬럼을 선택해 주세요.";
    if (!dashboardFilterOperatorOptions(column.type).some((option) => option.value === filter.operator)) {
      return `${filter.column} 컬럼에서 지원하지 않는 필터 방식입니다.`;
    }
    if (!dashboardFilterIsComplete(filter)) return `${filter.column} 필터 값을 입력해 주세요.`;
  }
  return null;
}

export function dashboardContextFilters(
  filters: DashboardWidgetFilter[],
  currentIndex: number,
) {
  return normalizeDashboardWidgetFilters(filters.slice(0, currentIndex));
}

export function dashboardFilterInputValue(
  rawValue: string,
  columnType: DashboardDatasetColumn["type"],
): DashboardWidgetFilterValue | undefined {
  if (columnType !== "number") return rawValue || undefined;
  if (!rawValue.trim()) return undefined;
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function localDashboardFilterValues(
  rows: Array<Record<string, unknown>>,
  column: string,
  contextFilters: DashboardWidgetFilter[],
  search: string,
  limit: number,
) {
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const seen = new Set<string>();
  const values: DashboardWidgetFilterValue[] = [];
  for (const row of rows) {
    if (!contextFilters.every((filter) => dashboardRowMatchesFilter(row, filter))) continue;
    const value = row[column];
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
    if (normalizedSearch && !String(value).toLocaleLowerCase().includes(normalizedSearch)) continue;
    const identity = `${typeof value}:${String(value)}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    values.push(value);
    if (values.length > limit) break;
  }
  return {
    truncated: values.length > limit,
    values: values.slice(0, limit),
  };
}

export function applyDashboardWidgetFilters(
  rows: Array<Record<string, unknown>>,
  filters: DashboardWidgetFilter[],
) {
  const activeFilters = normalizeDashboardWidgetFilters(filters);
  return rows.filter((row) => (
    activeFilters.every((filter) => dashboardRowMatchesFilter(row, filter))
  ));
}

function dashboardRowMatchesFilter(
  row: Record<string, unknown>,
  filter: DashboardWidgetFilter,
) {
  const current = row[filter.column];
  if (filter.operator === "is_null") return current === null || current === undefined;
  if (filter.operator === "is_not_null") return current !== null && current !== undefined;
  if (filter.operator === "in") return filter.values?.some((value) => value === current) ?? false;
  if (filter.operator === "contains") {
    return String(current ?? "").toLocaleLowerCase().includes(String(filter.value ?? "").toLocaleLowerCase());
  }
  if (filter.operator === "between") {
    const [start, end] = filter.values ?? [];
    return compareFilterValues(current, start) >= 0 && compareFilterValues(current, end) <= 0;
  }
  const comparison = compareFilterValues(current, filter.value);
  if (filter.operator === "gt") return comparison > 0;
  if (filter.operator === "gte") return comparison >= 0;
  if (filter.operator === "lt") return comparison < 0;
  if (filter.operator === "lte") return comparison <= 0;
  return current === filter.value || String(current ?? "") === String(filter.value ?? "");
}

function compareFilterValues(left: unknown, right: unknown) {
  const numericLeft = typeof left === "number" ? left : Number(left);
  const numericRight = typeof right === "number" ? right : Number(right);
  if (Number.isFinite(numericLeft) && Number.isFinite(numericRight)) return numericLeft - numericRight;
  const dateLeft = Date.parse(String(left ?? ""));
  const dateRight = Date.parse(String(right ?? ""));
  if (Number.isFinite(dateLeft) && Number.isFinite(dateRight)) return dateLeft - dateRight;
  return String(left ?? "").localeCompare(String(right ?? ""));
}
