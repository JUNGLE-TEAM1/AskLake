import type { PermissionGrant } from "../types/permissions";

export type SemanticMetric = { id: string; name: string; label: string; definition: string; expression: string; format: string; status: "ready" | "draft" };
export type SemanticDimension = { id: string; name: string; label: string; source: string; synonyms: string[] };
export type SemanticRelationship = { id: string; label: string; left: string; right: string; cardinality: "1:N" | "N:1" | "N:N" };
export type SemanticLayerModel = {
  id: string; name: string; description: string; purpose: string; questionExamples: string[]; owner: string; updatedAt: string;
  status: "published" | "draft"; linkedDatasetIds: string[]; metrics: SemanticMetric[]; dimensions: SemanticDimension[];
  relationships: SemanticRelationship[]; synonyms: string[]; permissionGrants: PermissionGrant[];
};

export const semanticLayerMocks: SemanticLayerModel[] = [
  {
    id: "semantic-commerce-sales", name: "Commerce Sales", description: "주문과 일별 매출을 하나의 분석 언어로 묶은 Semantic Dataset입니다.",
    purpose: "주문과 일별 매출을 하나의 업무 언어로 묶어 매출 현황과 추이를 설명합니다.",
    questionExamples: ["매출은 얼마인가?", "지역별 매출은 어떻게 되는가?", "월별 주문 수는 얼마인가?"], owner: "Analytics Team", updatedAt: "오늘 09:42", status: "published",
    linkedDatasetIds: ["ds_customer_orders_gold", "ds_sales_daily_summary"], synonyms: ["매출", "주문 매출", "판매액", "revenue", "sales"],
    metrics: [
      { id: "gross-sales", name: "gross_sales", label: "총매출", definition: "결제 완료 주문의 상품 금액 합계", expression: "SUM(orders_clean.total_amount)", format: "₩ 통화", status: "ready" },
      { id: "order-count", name: "order_count", label: "주문 수", definition: "중복을 제거한 주문 건수", expression: "COUNT(DISTINCT orders_clean.order_id)", format: "정수", status: "ready" },
      { id: "average-order-value", name: "average_order_value", label: "객단가", definition: "총매출을 주문 수로 나눈 값", expression: "gross_sales / order_count", format: "₩ 통화", status: "ready" },
    ],
    dimensions: [
      { id: "sales-date", name: "sales_date", label: "매출일", source: "sales_daily_summary.sales_date", synonyms: ["날짜", "판매일", "일자"] },
      { id: "region", name: "region", label: "지역", source: "sales_daily_summary.region", synonyms: ["국가", "권역", "지역명"] },
      { id: "order-status", name: "order_status", label: "주문 상태", source: "orders_clean.status", synonyms: ["상태", "결제 상태"] },
    ],
    relationships: [{ id: "sales-orders", label: "일별 매출 ↔ 주문", left: "sales_daily_summary.order_date", right: "orders_clean.order_date", cardinality: "1:N" }],
    permissionGrants: [
      { id: "commerce-analytics", principalId: "analytics-team", principalType: "group", actions: ["view", "query", "manage", "share"] },
      { id: "commerce-finance", principalId: "finance-team", principalType: "group", actions: ["view", "query"] },
    ],
  },
  {
    id: "semantic-customer-health", name: "Customer Health", description: "고객 리뷰와 주문 활동을 연결해 고객 상태를 설명하는 모델입니다.",
    purpose: "고객 리뷰와 주문 활동을 연결해 고객 상태와 위험 신호를 설명합니다.", questionExamples: ["부정 리뷰율은 얼마인가?", "고객별 리뷰 점수는 어떤가?", "리뷰와 주문이 함께 악화된 고객은 누구인가?"],
    owner: "Customer Analytics", updatedAt: "어제 16:10", status: "draft", linkedDatasetIds: ["ds_customer_orders_gold", "ds_customer_review_gold"], synonyms: ["고객 상태", "고객 건강도", "customer health", "VOC"],
    metrics: [
      { id: "review-score", name: "review_score", label: "리뷰 점수", definition: "고객 리뷰의 평균 평점", expression: "AVG(customer_review_gold.rating)", format: "0.0 점", status: "ready" },
      { id: "negative-review-rate", name: "negative_review_rate", label: "부정 리뷰율", definition: "전체 리뷰 중 부정 감성 리뷰의 비율", expression: "AVG(sentiment = 'negative')", format: "%", status: "draft" },
    ],
    dimensions: [
      { id: "customer-id", name: "customer_id", label: "고객 ID", source: "orders_clean.customer_id", synonyms: ["회원", "고객 번호"] },
      { id: "sentiment", name: "sentiment", label: "리뷰 감성", source: "customer_review_gold.sentiment", synonyms: ["긍정/부정", "감정"] },
    ], relationships: [{ id: "customer-review-orders", label: "주문 ↔ 리뷰", left: "orders_clean.customer_id", right: "customer_review_gold.customer_id", cardinality: "1:N" }],
    permissionGrants: [{ id: "customer-analytics", principalId: "analytics-team", principalType: "group", actions: ["view", "query", "manage"] }],
  },
  {
    id: "semantic-product-risk", name: "Product Risk", description: "상품 재고, 리뷰, 운영 신호를 조합해 상품 위험도를 관리합니다.",
    purpose: "상품 재고와 리뷰 신호를 조합해 상품의 운영 위험도를 설명합니다.", questionExamples: ["저재고 상품은 무엇인가?", "카테고리별 상품 건강도는 어떤가?", "재고와 리뷰가 함께 나빠진 상품은 무엇인가?"],
    owner: "Commerce Analytics", updatedAt: "2026-07-12", status: "published", linkedDatasetIds: ["ds_product_health_gold", "ds_inventory_snapshot", "ds_customer_review_gold"], synonyms: ["상품 위험", "상품 상태", "product health", "리스크"],
    metrics: [
      { id: "health-score", name: "health_score", label: "상품 건강도", definition: "재고와 리뷰 신호를 반영한 상품 상태 점수", expression: "AVG(product_health_gold.health_score)", format: "0 점", status: "ready" },
      { id: "low-stock-rate", name: "low_stock_rate", label: "저재고율", definition: "저재고 상태인 SKU의 비율", expression: "AVG(inventory_signal = 'low_stock')", format: "%", status: "ready" },
    ],
    dimensions: [
      { id: "category", name: "category", label: "상품 카테고리", source: "product_health_gold.category", synonyms: ["분류", "상품군"] },
      { id: "inventory-signal", name: "inventory_signal", label: "재고 신호", source: "product_health_gold.inventory_signal", synonyms: ["재고 상태", "재고 위험"] },
    ], relationships: [],
    permissionGrants: [
      { id: "product-analytics", principalId: "analytics-team", principalType: "group", actions: ["view", "query", "manage", "share"] },
      { id: "product-public", principalId: "public", principalType: "public", actions: ["view"] },
    ],
  },
];
