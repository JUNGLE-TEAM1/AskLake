export type SqlResultDraft = {
  columns: string[];
  datasetId: string;
  datasetName: string;
  executedAt: string;
  mode?: "preview" | "run";
  previewLimit?: number;
  query: string;
  rowCount: number;
  rows: string[][];
  runId: string;
  validationKey?: string;
};
