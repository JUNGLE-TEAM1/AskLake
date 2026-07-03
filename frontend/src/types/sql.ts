export type SqlResultDraft = {
  columns: string[];
  datasetId: string;
  datasetName: string;
  executedAt: string;
  query: string;
  rowCount: number;
  rows: string[][];
  runId: string;
};

