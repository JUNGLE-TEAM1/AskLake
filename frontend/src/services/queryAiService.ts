import type { CatalogDataset } from "../types";
import { apiClient, apiConfig } from "./apiClient";

type QueryAiPreflightMessage = {
  text: string;
  tone: "success" | "info" | "warning" | "error";
};

export type QueryAiMode = "draft_sql";

export type QueryAiRequest = {
  baseDataset: CatalogDataset;
  mode: QueryAiMode;
  preflightMessages: QueryAiPreflightMessage[];
  prompt: string;
  query: string;
  selectedDatasets: CatalogDataset[];
};

export type QueryAiSuggestion = {
  body: string;
  mode: QueryAiMode;
  model?: string | null;
  notices: string[];
  sql?: string;
  title: string;
};

const PREVIEW_LIMIT = 100;

export async function generateQueryAiSuggestion(request: QueryAiRequest): Promise<QueryAiSuggestion> {
  if (!apiConfig.useMock) {
    const suggestion = await apiClient.post<QueryAiSuggestion>("/api/query/ai-suggestions", {
      baseDatasetId: request.baseDataset.id,
      currentQuery: request.query,
      mode: request.mode,
      prompt: request.prompt,
      selectedDatasetIds: request.selectedDatasets.map((dataset) => dataset.id),
      selectedDatasets: request.selectedDatasets.map((dataset) => ({
        description: dataset.description,
        id: dataset.id,
        layer: dataset.layer,
        name: dataset.name,
        schema: dataset.schema,
      })),
    });
    return ensureSelectedJoinSuggestion(request, suggestion);
  }

  await new Promise((resolve) => window.setTimeout(resolve, 180));
  return draftSql(request);
}

function ensureSelectedJoinSuggestion(request: QueryAiRequest, suggestion: QueryAiSuggestion) {
  const referenceDatasets = request.selectedDatasets.filter((dataset) => dataset.id !== request.baseDataset.id);

  if (referenceDatasets.length === 0 || suggestionIncludesSelectedJoin(suggestion.sql, referenceDatasets)) {
    return suggestion;
  }

  const fallback = buildJoinSuggestion(request.baseDataset, referenceDatasets);
  if (!fallback) return suggestion;

  return {
    ...fallback,
    notices: [
      ...fallback.notices,
      "live AI 응답이 선택 reference JOIN을 포함하지 않아 frontend JOIN 초안 fallback을 적용했습니다.",
    ],
  };
}

function suggestionIncludesSelectedJoin(sql: string | undefined, referenceDatasets: CatalogDataset[]) {
  if (!sql || !/\bjoin\b/i.test(sql)) return false;

  const normalizedSql = sql.toLowerCase();
  return referenceDatasets.some((dataset) => normalizedSql.includes(dataset.name.toLowerCase()));
}

function draftSql({ baseDataset, prompt, selectedDatasets }: QueryAiRequest): QueryAiSuggestion {
  const intent = normalizeText(prompt);
  const referenceDatasets = selectedDatasets.filter((dataset) => dataset.id !== baseDataset.id);
  const joinSuggestion = buildJoinSuggestion(baseDataset, referenceDatasets);

  if (joinSuggestion) return joinSuggestion;

  const dimensionColumn = pickDimensionColumn(baseDataset, intent);
  const metricColumn = pickMetricColumn(baseDataset, intent);
  const wantsCount = /건수|몇\s*개|count|개수|수량/.test(intent);
  const wantsAverage = /평균|avg|average/.test(intent);
  const wantsMax = /최대|max|highest|상위/.test(intent);

  if (dimensionColumn && metricColumn && !wantsCount) {
    const metricExpression = wantsAverage
      ? `AVG(${metricColumn.name})`
      : wantsMax
        ? `MAX(${metricColumn.name})`
        : `SUM(${metricColumn.name})`;
    const metricAlias = wantsAverage ? `avg_${metricColumn.name}` : wantsMax ? `max_${metricColumn.name}` : `total_${metricColumn.name}`;
    const sql = [
      `SELECT ${dimensionColumn.name},`,
      `       ${metricExpression} AS ${metricAlias}`,
      `FROM ${baseDataset.name}`,
      `GROUP BY ${dimensionColumn.name}`,
      `ORDER BY ${metricAlias} DESC`,
      `LIMIT ${PREVIEW_LIMIT};`,
    ].join("\n");

    return {
      body: `${baseDataset.name}에서 ${dimensionColumn.name} 기준으로 ${metricColumn.name}을 집계하는 읽기 전용 SQL 초안입니다.`,
      mode: "draft_sql",
      notices: [
        "선택되지 않은 테이블은 사용하지 않았습니다.",
        "바로 실행하지 않고 편집기에 적용한 뒤 기존 점검을 다시 통과해야 합니다.",
      ],
      sql,
      title: "집계 SQL 초안",
    };
  }

  if (dimensionColumn && wantsCount) {
    const sql = [
      `SELECT ${dimensionColumn.name},`,
      "       COUNT(*) AS row_count",
      `FROM ${baseDataset.name}`,
      `GROUP BY ${dimensionColumn.name}`,
      "ORDER BY row_count DESC",
      `LIMIT ${PREVIEW_LIMIT};`,
    ].join("\n");

    return {
      body: `${baseDataset.name}에서 ${dimensionColumn.name}별 행 수를 확인하는 SQL 초안입니다.`,
      mode: "draft_sql",
      notices: [
        "COUNT 기반 초안이라 실제 지표 정의와 다를 수 있습니다.",
        "필요하면 WHERE 조건을 추가한 뒤 실행해 주세요.",
      ],
      sql,
      title: "건수 집계 SQL 초안",
    };
  }

  const columns = baseDataset.schema.slice(0, 4).map(([name]) => name);
  const sql = [
    `SELECT ${columns.length > 0 ? columns.join(", ") : "*"}`,
    `FROM ${baseDataset.name}`,
    `LIMIT ${PREVIEW_LIMIT};`,
  ].join("\n");

  return {
    body: `${baseDataset.name}의 주요 컬럼을 먼저 확인하는 기본 조회 SQL 초안입니다.`,
    mode: "draft_sql",
    notices: [
      "질문 의도가 명확하지 않아 안전한 기본 조회 형태로 제안했습니다.",
      "필요한 컬럼이나 조건을 추가한 뒤 실행해 주세요.",
    ],
    sql,
    title: "기본 조회 SQL 초안",
  };
}

function buildJoinSuggestion(baseDataset: CatalogDataset, referenceDatasets: CatalogDataset[]): QueryAiSuggestion | null {
  if (referenceDatasets.length === 0) return null;

  const selectedDatasets = [baseDataset, ...referenceDatasets].slice(0, 4);
  const joinTargets = selectedDatasets.slice(1);
  const joinKeys = joinTargets.flatMap((targetDataset) => {
    const joinKey = findJoinKey(baseDataset, targetDataset);
    return joinKey ? [{ ...joinKey, targetDataset }] : [];
  });
  const selectColumns = selectedDatasets.flatMap((dataset, datasetIndex) => {
    const alias = aliasFor(datasetIndex);
    return dataset.schema
      .slice(0, datasetIndex === 0 ? 3 : 2)
      .map(([column]) => `  ${alias}.${column} AS ${alias}_${column}`);
  }).slice(0, 8);
  const joins = joinTargets.map((targetDataset, index) => {
    const joinKey = joinKeys.find((key) => key.targetDataset.id === targetDataset.id);
    const targetAlias = aliasFor(index + 1);

    if (!joinKey) return `-- ${targetDataset.name}: 조인 키 후보를 찾지 못해 수동 확인 필요`;
    return `LEFT JOIN ${targetDataset.name} ${targetAlias}\n  ON b.${joinKey.leftColumn} = ${targetAlias}.${joinKey.rightColumn}`;
  });
  const sql = [
    "SELECT",
    selectColumns.length ? selectColumns.join(",\n") : "  b.*",
    `FROM ${baseDataset.name} b`,
    joins.join("\n"),
    `LIMIT ${PREVIEW_LIMIT};`,
  ].filter(Boolean).join("\n");
  const notices = [
    `${selectedDatasets.length}개 선택 테이블 metadata를 함께 참조했습니다.`,
    ...joinKeys.map((key) => `${key.leftColumn} = ${key.rightColumn} 조인 후보를 사용했습니다.`),
    ...joinTargets.filter((targetDataset) => !joinKeys.some((key) => key.targetDataset.id === targetDataset.id)).map((targetDataset) => `${targetDataset.name} 조인 키 후보를 찾지 못했습니다.`),
    "실행 전 SQL preflight와 read-only guard를 다시 통과해야 합니다.",
  ];

  return {
    body: `${baseDataset.name}을 기준으로 ${joinTargets.map((dataset) => dataset.name).join(", ")}를 조인하는 SQL 초안입니다.`,
    mode: "draft_sql",
    notices,
    sql,
    title: "선택 테이블 JOIN SQL 초안",
  };
}

function findJoinKey(leftDataset: CatalogDataset, rightDataset: CatalogDataset) {
  const leftColumns = leftDataset.schema.map(([name]) => name);
  const rightColumns = rightDataset.schema.map(([name]) => name);
  const exactMatch = leftColumns.find((leftColumn) => rightColumns.includes(leftColumn));

  if (exactMatch) return { leftColumn: exactMatch, rightColumn: exactMatch };

  const aliases: Array<[string, string]> = [
    ["customer_id", "user_id"],
    ["user_id", "customer_id"],
    ["product_id", "sku_id"],
    ["sku_id", "product_id"],
    ["order_date", "event_time"],
    ["sales_date", "order_date"],
  ];

  for (const [leftAlias, rightAlias] of aliases) {
    if (leftColumns.includes(leftAlias) && rightColumns.includes(rightAlias)) {
      return { leftColumn: leftAlias, rightColumn: rightAlias };
    }
  }

  const leftIdColumn = leftColumns.find((column) => column.endsWith("_id"));
  const rightIdColumn = rightColumns.find((column) => column.endsWith("_id"));
  return leftIdColumn && rightIdColumn ? { leftColumn: leftIdColumn, rightColumn: rightIdColumn } : null;
}

function aliasFor(index: number) {
  return ["b", "j1", "j2", "j3"][index] ?? `j${index}`;
}

function pickDimensionColumn(dataset: CatalogDataset, intent: string) {
  const targetedPatterns = [
    [/고객|customer|사용자|user/, /customer_id|user_id|customer|user/],
    [/상품|product|sku|카테고리|category/, /product_id|sku|category|product/],
    [/채널|channel/, /channel/],
    [/날짜|일별|월별|date|day|month|시간|time/, /date|day|month|time|created_at|event_time/],
    [/상태|status/, /status/],
    [/지역|region/, /region/],
  ] as const;

  const targetedPattern = targetedPatterns.find(([intentPattern]) => intentPattern.test(intent))?.[1];
  if (targetedPattern) {
    const targetedColumn = dataset.schema.find(([name]) => targetedPattern.test(name.toLowerCase()));
    if (targetedColumn) return toColumn(targetedColumn);
  }

  const fallback = dataset.schema.find(([name, type]) => {
    const lowerName = name.toLowerCase();
    const lowerType = type.toLowerCase();
    return /id|date|time|category|status|region|type|segment/.test(lowerName) || /string|date|timestamp/.test(lowerType);
  });

  return fallback ? toColumn(fallback) : null;
}

function pickMetricColumn(dataset: CatalogDataset, intent: string) {
  const targetedPatterns = [
    [/금액|매출|revenue|amount|sales|구매/, /amount|revenue|sales|price|total/],
    [/주문|order/, /^(orders?|order_count)$/],
    [/수량|재고|quantity|stock/, /quantity|stock|count/],
    [/점수|score|위험|risk/, /score|risk/],
    [/가치|value/, /value/],
  ] as const;

  const targetedPattern = targetedPatterns.find(([intentPattern]) => intentPattern.test(intent))?.[1];
  if (targetedPattern) {
    const targetedColumn = dataset.schema.find(([name]) => targetedPattern.test(name.toLowerCase()));
    if (targetedColumn) return toColumn(targetedColumn);
  }

  const fallback = dataset.schema.find(([name, type]) => {
    const lowerName = name.toLowerCase();
    const lowerType = type.toLowerCase();
    return /amount|price|total|score|value|quantity|count|sales|revenue/.test(lowerName)
      || /int|decimal|double|float|numeric|number/.test(lowerType);
  });

  return fallback ? toColumn(fallback) : null;
}

function toColumn([name, type]: [string, string]) {
  return { name, type };
}

function normalizeText(value: string) {
  return value.trim().toLowerCase();
}
