import type { PermissionAction, PermissionGrant, PermissionPrincipalType } from "../types/permissions";

export type SemanticMetric = {
  id: string;
  name: string;
  label: string;
  definition: string;
  expression: string;
  format: string;
  status: "ready" | "draft";
};

export type SemanticDimension = {
  id: string;
  name: string;
  label: string;
  source: string;
  synonyms: string[];
};

export type SemanticRelationship = {
  id: string;
  label: string;
  left: string;
  right: string;
  cardinality: "1:N" | "N:1" | "N:N";
};

export type SemanticPermissionAction = PermissionAction | "publish";

export type SemanticPermissionGrant = Omit<PermissionGrant, "actions"> & {
  actions: SemanticPermissionAction[];
};

export type RagClassification =
  | "analytics_only"
  | "review"
  | "support_conversation"
  | "incident_report"
  | "business_document"
  | "mixed"
  | "unknown";

export type RagColumnRole = "document_text" | "document_title" | "filter" | "identifier" | "exclude";
export type RagReviewState = "not_configured" | "candidate" | "needs_review" | "approved" | "excluded";
export type RagIndexStatus = "not_indexed" | "indexing" | "ready" | "failed";

export type RagColumnRecommendation = {
  column: string;
  role: RagColumnRole;
  reason: string;
  confidence: number;
};

export type RagEmbeddingStatus = "not_started" | "pending" | "generating" | "ready" | "failed";

export type RagVectorDocument = {
  documentId: string;
  body: string;
  metadata: Record<string, string>;
  sourceDataset: string;
  sourceColumn: string;
  targetIndex: string;
  embeddingStatus: RagEmbeddingStatus;
};

export type RagDatasetProfile = {
  datasetId: string;
  classification: RagClassification;
  classificationLabel: string;
  confidence: number;
  aiReason: string;
  aiReviewedAt: string;
  reviewState: RagReviewState;
  indexStatus: RagIndexStatus;
  indexedRows: string;
  documentCount: string;
  targetIndex: string;
  embeddingStatus: RagEmbeddingStatus;
  lastIndexedAt?: string;
  sourceLabel: string;
  textColumns: string[];
  titleColumns: string[];
  filterColumns: string[];
  excludedColumns: string[];
  recommendations: RagColumnRecommendation[];
  sampleRows: Array<{ id: string; text: string; metadata: string }>;
  vectorDocuments: RagVectorDocument[];
};

export type SemanticLayerModel = {
  id: string;
  name: string;
  description: string;
  purpose: string;
  questionExamples: string[];
  owner: string;
  updatedAt: string;
  status: "published" | "draft";
  linkedDatasetIds: string[];
  metrics: SemanticMetric[];
  dimensions: SemanticDimension[];
  relationships: SemanticRelationship[];
  synonyms: string[];
  permissionGrants: SemanticPermissionGrant[];
};

export const semanticRagProfiles: RagDatasetProfile[] = [
  {
    datasetId: "ds_customer_review_gold",
    classification: "review",
    classificationLabel: "고객 리뷰",
    confidence: 0.97,
    aiReason: "review_text에 고객의 경험과 의견을 담은 자연어 문장이 반복적으로 확인됩니다.",
    aiReviewedAt: "오늘 09:38",
    reviewState: "approved",
    indexStatus: "ready",
    indexedRows: "4.2M개 중 4.1M개",
    documentCount: "4.2M개 대상 · 4.1M개 적재",
    targetIndex: "customer_review_gold",
    embeddingStatus: "ready",
    lastIndexedAt: "오늘 09:40",
    sourceLabel: "customer_review_gold_pipeline",
    textColumns: ["review_text"],
    titleColumns: [],
    filterColumns: ["product_id", "rating", "sentiment"],
    excludedColumns: ["review_id"],
    recommendations: [
      { column: "review_text", role: "document_text", reason: "고객 경험과 의견을 담은 문장형 텍스트", confidence: 0.98 },
      { column: "product_id", role: "filter", reason: "상품별 검색 범위를 제한하는 식별 필드", confidence: 0.99 },
      { column: "rating", role: "filter", reason: "평점 조건으로 검색 결과를 좁힐 수 있음", confidence: 0.98 },
      { column: "sentiment", role: "filter", reason: "긍정·부정 리뷰를 구분하는 분류 필드", confidence: 0.95 },
      { column: "review_id", role: "exclude", reason: "검색 본문이 아닌 원천 행 식별자", confidence: 0.99 },
    ],
    sampleRows: [
      { id: "RV-991", text: "Fast delivery and the packaging was safe.", metadata: "SKU-200 · 5점 · positive" },
      { id: "RV-992", text: "Packaging was damaged and the battery drains quickly.", metadata: "SKU-118 · 2점 · negative" },
    ],
    vectorDocuments: [
      {
        documentId: "RV-991",
        body: "Fast delivery and the packaging was safe.",
        metadata: { product_id: "SKU-200", rating: "5", sentiment: "positive" },
        sourceDataset: "customer_review_gold",
        sourceColumn: "review_text",
        targetIndex: "customer_review_gold",
        embeddingStatus: "ready",
      },
      {
        documentId: "RV-992",
        body: "Packaging was damaged and the battery drains quickly.",
        metadata: { product_id: "SKU-118", rating: "2", sentiment: "negative" },
        sourceDataset: "customer_review_gold",
        sourceColumn: "review_text",
        targetIndex: "customer_review_gold",
        embeddingStatus: "ready",
      },
    ],
  },
  {
    datasetId: "ds_customer_orders_gold",
    classification: "analytics_only",
    classificationLabel: "분석 전용",
    confidence: 0.99,
    aiReason: "금액·일자·상태·식별자 중심의 구조화 Dataset이며 검색할 장문 텍스트가 없습니다.",
    aiReviewedAt: "오늘 09:35",
    reviewState: "excluded",
    indexStatus: "not_indexed",
    indexedRows: "-",
    documentCount: "0개",
    targetIndex: "없음 · 분석 전용",
    embeddingStatus: "not_started",
    sourceLabel: "orders_clean_pipeline",
    textColumns: [],
    titleColumns: [],
    filterColumns: ["order_date", "region", "status"],
    excludedColumns: ["order_id", "customer_id", "total_amount"],
    recommendations: [
      { column: "order_date", role: "filter", reason: "기간 조건에 사용하는 날짜 필드", confidence: 0.99 },
      { column: "total_amount", role: "exclude", reason: "SQL 집계 대상 숫자 필드", confidence: 0.99 },
    ],
    sampleRows: [],
    vectorDocuments: [],
  },
  {
    datasetId: "ds_sales_daily_summary",
    classification: "analytics_only",
    classificationLabel: "분석 전용",
    confidence: 0.99,
    aiReason: "일자·지역·매출·주문 수로 구성된 집계 Mart입니다.",
    aiReviewedAt: "오늘 09:36",
    reviewState: "excluded",
    indexStatus: "not_indexed",
    indexedRows: "-",
    documentCount: "0개",
    targetIndex: "없음 · 분석 전용",
    embeddingStatus: "not_started",
    sourceLabel: "daily_sales_aggregation",
    textColumns: [],
    titleColumns: [],
    filterColumns: ["sales_date", "region", "status"],
    excludedColumns: ["gross_sales", "order_count"],
    recommendations: [
      { column: "sales_date", role: "filter", reason: "기간 조건에 사용하는 날짜 필드", confidence: 0.99 },
      { column: "gross_sales", role: "exclude", reason: "Semantic Metric이 SQL로 계산하는 숫자 필드", confidence: 0.99 },
    ],
    sampleRows: [],
    vectorDocuments: [],
  },
];

export const semanticLayerMocks: SemanticLayerModel[] = [
  {
    id: "semantic-commerce-sales",
    name: "Commerce Sales",
    description: "주문과 일별 매출을 하나의 분석 언어로 묶은 업무 모델입니다.",
    purpose: "주문과 일별 매출 Mart를 연결해 매출을 일관된 기준으로 조회합니다.",
    questionExamples: ["총매출은 얼마인가?", "지역별 매출은 어떻게 되는가?", "월별 주문 수는 얼마인가?"],
    owner: "Analytics Team",
    updatedAt: "오늘 09:42",
    status: "published",
    linkedDatasetIds: ["ds_customer_orders_gold", "ds_sales_daily_summary"],
    metrics: [
      { id: "gross-sales", name: "gross_sales", label: "총매출", definition: "결제 완료 주문의 상품 금액 합계", expression: "SUM(orders_clean.total_amount)", format: "통화", status: "ready" },
      { id: "order-count", name: "order_count", label: "주문 수", definition: "중복을 제거한 주문 건수", expression: "COUNT(DISTINCT orders_clean.order_id)", format: "정수", status: "ready" },
      { id: "average-order-value", name: "average_order_value", label: "객단가", definition: "총매출을 주문 수로 나눈 값", expression: "gross_sales / order_count", format: "통화", status: "ready" },
    ],
    dimensions: [
      { id: "sales-date", name: "sales_date", label: "매출일", source: "sales_daily_summary.sales_date", synonyms: ["날짜", "판매일", "일자"] },
      { id: "region", name: "region", label: "지역", source: "sales_daily_summary.region", synonyms: ["국가", "권역", "지역명"] },
      { id: "order-status", name: "order_status", label: "주문 상태", source: "orders_clean.status", synonyms: ["상태", "결제 상태"] },
    ],
    relationships: [{ id: "sales-orders", label: "일별 매출 ↔ 주문", left: "sales_daily_summary.order_date", right: "orders_clean.order_date", cardinality: "1:N" }],
    synonyms: ["매출", "주문 매출", "판매액", "revenue", "sales"],
    permissionGrants: [
      { id: "commerce-analytics", principalId: "analytics-team", principalType: "group", actions: ["view", "query", "manage", "publish", "share"] },
      { id: "commerce-finance", principalId: "finance-team", principalType: "group", actions: ["view", "query"] },
    ],
  },
  {
    id: "semantic-customer-health",
    name: "Customer Health",
    description: "고객 리뷰와 주문 활동을 연결해 고객 상태를 설명하는 업무 모델입니다.",
    purpose: "리뷰 점수와 감성 신호를 주문 활동과 함께 분석합니다.",
    questionExamples: ["부정 리뷰가 많은 상품은?", "리뷰 점수가 낮은 고객군은?"],
    owner: "Customer Analytics",
    updatedAt: "어제 16:10",
    status: "draft",
    linkedDatasetIds: ["ds_customer_orders_gold", "ds_customer_review_gold"],
    metrics: [
      { id: "review-score", name: "review_score", label: "리뷰 점수", definition: "고객 리뷰의 평균 평점", expression: "AVG(customer_review_gold.rating)", format: "0.0점", status: "ready" },
      { id: "negative-review-rate", name: "negative_review_rate", label: "부정 리뷰율", definition: "전체 리뷰 중 부정 감성 리뷰의 비율", expression: "AVG(sentiment = 'negative')", format: "%", status: "draft" },
    ],
    dimensions: [
      { id: "customer-id", name: "customer_id", label: "고객 ID", source: "orders_clean.customer_id", synonyms: ["회원", "고객 번호"] },
      { id: "sentiment", name: "sentiment", label: "리뷰 감성", source: "customer_review_gold.sentiment", synonyms: ["긍정/부정", "감정"] },
    ],
    relationships: [{ id: "customer-review-orders", label: "주문 ↔ 리뷰", left: "orders_clean.customer_id", right: "customer_review_gold.customer_id", cardinality: "1:N" }],
    synonyms: ["고객 상태", "고객 건강도", "customer health", "VOC"],
    permissionGrants: [
      { id: "customer-analytics", principalId: "analytics-team", principalType: "group", actions: ["view", "query", "manage", "publish"] },
    ],
  },
  {
    id: "semantic-product-risk",
    name: "Product Risk",
    description: "상품 재고, 리뷰, 운영 신호를 조합해 상품 위험도를 관리합니다.",
    purpose: "재고 신호와 리뷰 신호를 연결해 상품 운영 위험을 확인합니다.",
    questionExamples: ["저재고 상품은 무엇인가?", "재고와 리뷰가 함께 나빠진 상품은?"],
    owner: "Commerce Analytics",
    updatedAt: "2026-07-12",
    status: "published",
    linkedDatasetIds: ["ds_product_health_gold", "ds_inventory_snapshot", "ds_customer_review_gold"],
    metrics: [
      { id: "health-score", name: "health_score", label: "상품 건강도", definition: "재고와 리뷰 신호를 반영한 상품 상태 점수", expression: "AVG(product_health_gold.health_score)", format: "0점", status: "ready" },
      { id: "low-stock-rate", name: "low_stock_rate", label: "저재고율", definition: "저재고 상태 SKU의 비율", expression: "AVG(inventory_signal = 'low_stock')", format: "%", status: "ready" },
    ],
    dimensions: [
      { id: "category", name: "category", label: "상품 카테고리", source: "product_health_gold.category", synonyms: ["분류", "상품군"] },
      { id: "inventory-signal", name: "inventory_signal", label: "재고 신호", source: "product_health_gold.inventory_signal", synonyms: ["재고 상태", "재고 위험"] },
    ],
    relationships: [],
    synonyms: ["상품 위험", "상품 상태", "product health", "리스크"],
    permissionGrants: [
      { id: "product-analytics", principalId: "analytics-team", principalType: "group", actions: ["view", "query", "manage", "publish", "share"] },
      { id: "product-public", principalId: "public", principalType: "public", actions: ["view"] },
    ],
  },
];

export function cloneSemanticModels() {
  return semanticLayerMocks.map((model) => ({
    ...model,
    linkedDatasetIds: [...model.linkedDatasetIds],
    synonyms: [...model.synonyms],
    metrics: model.metrics.map((metric) => ({ ...metric })),
    dimensions: model.dimensions.map((dimension) => ({ ...dimension, synonyms: [...dimension.synonyms] })),
    relationships: model.relationships.map((relationship) => ({ ...relationship })),
    permissionGrants: model.permissionGrants.map((grant) => ({ ...grant, actions: [...grant.actions] })),
  }));
}

export function cloneSemanticRagProfiles() {
  return semanticRagProfiles.map((profile) => ({
    ...profile,
    textColumns: [...profile.textColumns],
    titleColumns: [...profile.titleColumns],
    filterColumns: [...profile.filterColumns],
    excludedColumns: [...profile.excludedColumns],
    recommendations: profile.recommendations.map((recommendation) => ({ ...recommendation })),
    sampleRows: profile.sampleRows.map((row) => ({ ...row })),
  }));
}

export function createSemanticPermissionGrant(id: string): SemanticPermissionGrant {
  return { id, principalId: "new-team", principalType: "group" as PermissionPrincipalType, actions: ["view", "query"] };
}
