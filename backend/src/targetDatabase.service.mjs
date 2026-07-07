const DEFAULT_TARGET_DATABASES = [
  { description: "기본 AskLake 카탈로그 DB", name: "asklake" },
  { description: "정제 Gold 데이터셋 저장 DB", name: "asklake_gold" },
  { description: "분석용 데이터 마트 DB", name: "analytics" },
  { description: "마케팅/고객 데이터 DB", name: "marketing" },
];

function configuredDatabases() {
  const configured = (process.env.TARGET_DATABASES || process.env.ASKLAKE_TARGET_DATABASES || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  if (configured.length === 0) return DEFAULT_TARGET_DATABASES;
  return configured.map((name) => ({ description: "환경변수로 허용된 target DB", name }));
}

export function listTargetDatabases() {
  return { databases: configuredDatabases() };
}
