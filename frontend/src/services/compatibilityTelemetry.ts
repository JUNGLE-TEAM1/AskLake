const compatibilityCounts = new Map<string, number>();

type CompatibilityContext = Record<string, boolean | number | string | null | undefined>;

export function recordCompatibilityPath(
  path: string,
  reason: string,
  context: CompatibilityContext = {},
) {
  const count = (compatibilityCounts.get(path) ?? 0) + 1;
  compatibilityCounts.set(path, count);
  console.warn("compatibility.path.used", {
    compatibilityContext: Object.fromEntries(
      Object.entries(context)
        .slice(0, 12)
        .map(([key, value]) => [key.slice(0, 80), typeof value === "string" ? value.slice(0, 200) : value]),
    ),
    compatibilityCount: count,
    compatibilityPath: path,
    compatibilityReason: reason.slice(0, 200),
    event: "compatibility.path.used",
  });
  return count;
}

export function getCompatibilityPathCounts() {
  return Object.fromEntries([...compatibilityCounts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function resetCompatibilityPathCountsForTest() {
  compatibilityCounts.clear();
}
