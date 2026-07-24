export const DEFAULT_TARGET_DATASET = "30일 클릭 로그 데이터셋";
export const DEFAULT_TARGET_DESCRIPTION = "2026년 6월 클릭 로그";

const LEGACY_DEFAULT_TARGET_DATASETS = new Set([
  "customer_review_gold",
  "pair_a_customer_review_gold",
  "구매전환율 데이터셋",
  "과거 30일 클릭 로그 데이터셋",
]);
const LEGACY_DEFAULT_TARGET_DESCRIPTIONS = new Set([
  "고객 리뷰 분석용 정제 데이터셋",
  "이전 30일 2026년 6월 클릭로그",
]);

export function isDefaultTargetDataset(value: string | undefined) {
  const normalized = value?.trim();
  return !normalized || normalized === DEFAULT_TARGET_DATASET || LEGACY_DEFAULT_TARGET_DATASETS.has(normalized);
}

export function isDefaultTargetDescription(value: string | undefined) {
  const normalized = value?.trim();
  return !normalized || normalized === DEFAULT_TARGET_DESCRIPTION || LEGACY_DEFAULT_TARGET_DESCRIPTIONS.has(normalized);
}

export function resolveDefaultTargetDataset(value: string | undefined) {
  const normalized = value?.trim();
  return isDefaultTargetDataset(normalized) ? DEFAULT_TARGET_DATASET : normalized ?? DEFAULT_TARGET_DATASET;
}

export function resolveDefaultTargetDescription(value: string | undefined) {
  const normalized = value?.trim();
  return isDefaultTargetDescription(normalized) ? DEFAULT_TARGET_DESCRIPTION : normalized ?? DEFAULT_TARGET_DESCRIPTION;
}
