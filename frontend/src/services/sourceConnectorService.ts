import { apiClient } from "./apiClient";
import type { DraftPipelinePatch, SourceDraft } from "../types";

type SourceFieldRows = Array<[string, string]>;

export type SourceConnectorAnalysis = {
  actionPath: string;
  assets: Array<[string, string, string]>;
  draftPatch: DraftPipelinePatch;
  logs: string[];
  message: string;
  previewColumns: string[];
  previewNote: string;
  previewRows: string[][];
  status: SourceDraft["connectionStatus"];
  testItems: Array<[string, string]>;
};

type BackendSourceConnectorResponse = SourceConnectorAnalysis;

export async function testSourceConnector(sourceType: string, fields: SourceFieldRows): Promise<SourceConnectorAnalysis> {
  return apiClient.post<BackendSourceConnectorResponse>("/api/etl/sources/test", {
    sourceConfig: fields,
    sourceType,
  });
}
