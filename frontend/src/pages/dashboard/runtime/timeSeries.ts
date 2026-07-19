import type { DashboardWidgetDateUnit } from "../../../types";

const YEAR_PATTERN = /^\d{4}$/;
const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_PREFIX_PATTERN = /^\d{4}-\d{2}-\d{2}[T\s]/;

export const TIME_SERIES_POINT_LIMIT = 60;

function padded(value: number) {
  return String(value).padStart(2, "0");
}

function parseTimeValue(value: unknown) {
  const date = value instanceof Date
    ? value
    : typeof value === "number"
      ? new Date(value)
      : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
}

export function bucketTimeLabel(value: unknown, dateUnit: DashboardWidgetDateUnit) {
  const date = parseTimeValue(value);
  if (!date) return null;

  const year = date.getFullYear();
  const month = padded(date.getMonth() + 1);
  const day = padded(date.getDate());
  const hour = padded(date.getHours());
  const minute = padded(date.getMinutes());

  if (dateUnit === "year") return String(year);
  if (dateUnit === "month") return `${year}-${month}`;
  if (dateUnit === "day") return `${year}-${month}-${day}`;
  if (dateUnit === "hour") return `${year}-${month}-${day}T${hour}:00:00`;
  return `${year}-${month}-${day}T${hour}:${minute}:00`;
}

function normalizedTimeCategory(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  if (typeof value !== "string") return null;

  const text = value.trim();
  if (!text) return null;
  const normalized = YEAR_PATTERN.test(text)
    ? `${text}-01-01T00:00:00`
    : MONTH_PATTERN.test(text)
      ? `${text}-01T00:00:00`
      : DAY_PATTERN.test(text)
        ? `${text}T00:00:00`
        : DATE_TIME_PREFIX_PATTERN.test(text)
          ? text.replace(" ", "T")
          : null;
  if (!normalized) return null;

  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function timeSeriesCategoryTimestamps(categories: unknown[]) {
  if (!categories.length) return null;
  const timestamps = categories.map(normalizedTimeCategory);
  return timestamps.every((value): value is number => value !== null) ? timestamps : null;
}

export function latestTimeSeriesSlice<Value>(values: Value[], limit = TIME_SERIES_POINT_LIMIT) {
  if (limit <= 0) return [];
  return values.slice(-limit);
}

export function boundedTimeSeriesSlice<Value>(
  values: Value[],
  categories: unknown[],
  limit = TIME_SERIES_POINT_LIMIT,
) {
  if (limit <= 0) return [];
  return timeSeriesCategoryTimestamps(categories)
    ? latestTimeSeriesSlice(values, limit)
    : values.slice(0, limit);
}

export function formatTimeAxisLabel(
  value: string | number,
  dateUnit?: DashboardWidgetDateUnit,
  detailed = false,
) {
  const date = parseTimeValue(value);
  if (!date) return String(value);

  const options: Intl.DateTimeFormatOptions = dateUnit === "year"
    ? { year: "numeric" }
    : dateUnit === "month"
      ? { month: "2-digit", year: detailed ? "numeric" : undefined }
      : dateUnit === "day"
        ? { day: "2-digit", month: "2-digit", year: detailed ? "numeric" : undefined }
        : dateUnit === "hour"
          ? { day: detailed ? "2-digit" : undefined, hour: "2-digit", hour12: false, month: detailed ? "2-digit" : undefined }
          : { day: detailed ? "2-digit" : undefined, hour: "2-digit", hour12: false, minute: "2-digit", month: detailed ? "2-digit" : undefined };
  return new Intl.DateTimeFormat("ko-KR", options).format(date);
}

export function defaultTimeBucketForColumn(column: { name: string; type: string } | undefined) {
  if (!column || column.type !== "date") return undefined;
  return /(^|_)(time|timestamp|datetime|at)($|_)/i.test(column.name) ? "hour" : "day";
}
