import type { CatalogDataset } from "../../types";

export function buildDefaultDerivedDatasetName(dataset: CatalogDataset) {
  return `${dataset.name}_analysis`;
}

export function buildDefaultDerivedDatasetDescription(dataset: CatalogDataset) {
  return `${dataset.name} SQL 결과로 생성한 분석 데이터셋`;
}

export function buildDefaultDerivedDatasetTags(dataset: CatalogDataset) {
  return Array.from(new Set(["#sql-derived", ...dataset.tags])).slice(0, 4).join(" ");
}

export function parseDerivedDatasetTags(value: string) {
  const tags = value
    .split(/[\s,]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => tag.startsWith("#") ? tag : `#${tag}`);

  return Array.from(new Set(tags));
}
