export type SqlResultDraft = {
  baseDatasetId?: string;
  columns: string[];
  datasetId: string;
  datasetName: string;
  executedAt: string;
  mode?: "preview" | "run";
  previewLimit?: number;
  query: string;
  referenceDatasetIds?: string[];
  rowCount: number;
  rows: string[][];
  runId: string;
  validationKey?: string;
};
