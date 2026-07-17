function configuredDatabases() {
  const configured = (process.env.TARGET_DATABASES || process.env.ASKLAKE_TARGET_DATABASES || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  const active = configured.length > 0
    ? configured
    : [String(process.env.TRINO_SCHEMA || "asklake").trim()].filter(Boolean);
  return [...new Set(active)].map((name) => ({
    description: "Configured Trino/Iceberg target schema",
    name,
  }));
}

export function listTargetDatabases() {
  return { databases: configuredDatabases() };
}
