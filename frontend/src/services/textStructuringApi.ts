import { apiClient } from "./apiClient";
import type {
  TextStructuringDefinition,
  TextStructuringResultRow,
  TextStructuringSpec,
  TextStructuringSpecRef,
  TextStructuringSpecVersion,
} from "../types";

export async function suggestTextStructuringDefinition(input: {
  sourceColumns: Array<{ name: string; type: string }>;
  sampleRows: Array<Record<string, unknown>>;
  sourceFields: string[];
  locale?: string;
  includeAspects?: boolean;
}): Promise<{ definition: TextStructuringDefinition; model: string; source: string; warnings: string[] }> {
  return apiClient.post<{ definition: TextStructuringDefinition; model: string; source: string; warnings: string[] }>("/api/text-structuring/suggest", input);
}

export async function previewTextStructuring(input: {
  definition: TextStructuringDefinition;
  rows: Array<Record<string, unknown>>;
}): Promise<{
  rows: TextStructuringResultRow[];
  routeBreakdown: Record<string, number>;
  warnings: string[];
}> {
  return apiClient.post<{
    rows: TextStructuringResultRow[];
    routeBreakdown: Record<string, number>;
    warnings: string[];
  }>("/api/text-structuring/preview", {
    ...input,
    persistReviewItems: false,
  });
}

export async function createTextStructuringSpec(input: {
  name: string;
  description: string;
  definition: TextStructuringDefinition;
}): Promise<TextStructuringSpec> {
  return apiClient.post<TextStructuringSpec>("/api/text-structuring/specs", input);
}

export async function createTextStructuringVersion(
  specId: string,
  definition: TextStructuringDefinition,
): Promise<TextStructuringSpecVersion> {
  return apiClient.post<TextStructuringSpecVersion>(`/api/text-structuring/specs/${encodeURIComponent(specId)}/versions`, {
    definition,
    publish: false,
  });
}

export async function publishTextStructuringVersion(
  specId: string,
  version: number,
): Promise<TextStructuringSpecVersion> {
  return apiClient.post<TextStructuringSpecVersion>(
    `/api/text-structuring/specs/${encodeURIComponent(specId)}/versions/${version}/publish`,
    {},
  );
}

export function versionSpecRef(version: TextStructuringSpecVersion): TextStructuringSpecRef {
  return {
    specId: version.specId,
    version: version.version,
    fingerprint: version.fingerprint,
  };
}
