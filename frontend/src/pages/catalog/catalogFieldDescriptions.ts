import type { CatalogDataset } from "../../types";

const datasetFieldDescriptions: Record<string, Record<string, string>> = {
  app_events: {
    eventId: "앱 이벤트를 구분하는 고유 식별자",
    customerId: "이벤트를 발생시킨 고객의 고유 식별자",
    sessionId: "이벤트가 발생한 사용자 세션의 식별자",
    eventTime: "앱 이벤트가 발생한 시각",
    eventType: "조회, 클릭, 오류 등 앱 이벤트의 종류",
    "properties.pagePath": "이벤트가 발생한 앱 화면 또는 페이지 경로",
    "properties.experiment.key": "이벤트에 연결된 실험의 식별 키",
    "properties.errorCode": "오류 이벤트에 기록된 오류 코드",
    "device.os": "이벤트 발생 기기의 운영체제",
    "device.appVersion": "이벤트 발생 당시의 앱 버전",
    "device.locale": "이벤트 발생 기기에 설정된 언어 및 지역",
  },
  customer_reviews: {
    reviewId: "고객 리뷰를 구분하는 고유 식별자",
    customerId: "리뷰를 작성한 고객의 고유 식별자",
    orderId: "리뷰와 연결된 주문의 고유 식별자",
    sku: "리뷰 대상 상품의 재고 관리 코드",
    rating: "고객이 상품 또는 주문 경험에 부여한 평점",
    comment: "고객이 작성한 리뷰 원문",
    sentiment: "리뷰 원문에서 분류한 감정",
    topics: "리뷰 원문에서 추출한 주요 주제 목록",
    "metadata.channel": "리뷰가 작성된 유입 채널",
    "metadata.device": "리뷰 작성에 사용된 기기 유형",
    "metadata.region": "리뷰가 작성된 지역 코드",
    createdAt: "리뷰가 생성된 시각",
  },
};

const commonFieldDescriptions: Record<string, string> = {
  created_at: "레코드가 생성된 시각",
  createdAt: "레코드가 생성된 시각",
  updated_at: "레코드가 마지막으로 수정된 시각",
  updatedAt: "레코드가 마지막으로 수정된 시각",
};

const typeLabels: Record<string, string> = {
  "array<string>": "문자열 목록",
  bigint: "큰 정수",
  boolean: "참/거짓",
  date: "날짜",
  decimal: "소수",
  double: "실수",
  float: "실수",
  integer: "정수",
  number: "숫자",
  string: "문자열",
  text: "긴 문자열",
  timestamp: "날짜와 시각",
};

export function getCatalogFieldDescription(
  dataset: Pick<CatalogDataset, "name">,
  fieldName: string,
  fieldType: string,
) {
  const datasetName = dataset.name.trim().toLowerCase();
  const specificDescription = datasetFieldDescriptions[datasetName]?.[fieldName];
  if (specificDescription) return specificDescription;

  const commonDescription = commonFieldDescriptions[fieldName];
  if (commonDescription) return commonDescription;

  const typeLabel = typeLabels[fieldType.trim().toLowerCase()] ?? fieldType;
  return `${fieldName} 값을 저장하는 ${typeLabel} 형식 필드`;
}
