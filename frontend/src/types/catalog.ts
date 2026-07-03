export type CatalogDataset = {
  description: string;
  downstream: string[];
  freshness: "latest" | "stale" | "approval";
  id: string;
  layer: "RAW" | "BRONZE" | "SILVER" | "GOLD";
  lastUpdated: string;
  name: string;
  nextRefresh: string;
  owner: string;
  quality: string;
  rag: boolean;
  rows: string;
  sampleRows: string[][];
  schema: Array<[string, string]>;
  size: string;
  source: string;
  status: "사용 가능" | "승인 필요";
  tags: string[];
  upstream: string[];
};

