export function escapeCsvCell(value: string) {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatResultTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "executed";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
