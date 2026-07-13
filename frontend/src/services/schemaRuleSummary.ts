import type { QualityRuleDraft, SchemaColumnDraft, TransformStepDraft } from "../types";

export function summarizeSchemaRuleState(
  columns: SchemaColumnDraft[],
  qualityRules: QualityRuleDraft[],
  transformSteps: TransformStepDraft[],
) {
  const enabledSteps = transformSteps.filter((step) => step.enabled);
  const transformRules = enabledSteps.filter((step) => step.operation !== "Null Guard");
  const enabledQualityRules = qualityRules.filter((rule) => rule.enabled);
  const requiredColumnCount = columns.filter((column) => (
    column.included !== false && column.nullable === false
  )).length;
  const transformedColumns = new Set(
    transformRules.map((step) => step.output || step.input).filter(Boolean),
  );
  const failureActions = [
    ...enabledSteps.map((step) => step.onError),
    ...enabledQualityRules.map((rule) => rule.failureAction),
  ].filter(Boolean);

  return {
    enabledQualityRules,
    failureActions,
    qualityRuleCount: enabledQualityRules.length,
    requiredColumnCount,
    transformedColumnCount: transformedColumns.size,
    transformRules,
  };
}
