import type { CanonicalRuleDraft, RuleCompilationResult, SchemaColumnDraft } from "../types";
import { apiClient } from "./apiClient";

export type SnapshotRulePreviewResponse = {
  compilation: RuleCompilationResult;
  quality: Record<string, number | string>;
  quarantined: Array<Record<string, unknown>>;
  records: Array<Record<string, unknown>>;
  transform: Record<string, number | string>;
};

export function previewSnapshotRules({
  executionMode,
  records,
  rules,
  schemaColumns,
  sourceType,
}: {
  executionMode: "snapshot" | "continuous";
  records: Array<Record<string, unknown>>;
  rules: CanonicalRuleDraft[];
  schemaColumns: SchemaColumnDraft[];
  sourceType: string;
}) {
  return apiClient.post<SnapshotRulePreviewResponse>("/api/etl/rules/preview", {
    executionMode,
    records,
    ruleContractVersion: "1.0",
    rules,
    schemaColumns,
    sourceType,
  });
}
