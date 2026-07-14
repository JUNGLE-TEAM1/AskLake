import type { QualityRuleDraft, SchemaColumnDraft, TransformStepDraft } from "../types";

export type FailurePolicyApplication = {
  action: string;
  category: "quality" | "transform";
  label: string;
  target: string;
};

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
  const failurePolicyApplications: FailurePolicyApplication[] = [
    ...enabledSteps.map((step) => ({
      action: step.onError,
      category: "transform" as const,
      label: step.label || step.operation,
      target: step.output || step.input,
    })),
    ...enabledQualityRules.map((rule) => ({
      action: rule.failureAction,
      category: "quality" as const,
      label: rule.validationType,
      target: rule.targetColumn,
    })),
  ].filter(({ action }) => Boolean(action));
  const failureActions = failurePolicyApplications.map(({ action }) => action);
  const failureTargets = new Set(
    failurePolicyApplications.map(({ target }) => target).filter(Boolean),
  );

  return {
    enabledQualityRules,
    failureActions,
    failureApplicationCount: failurePolicyApplications.length,
    failurePolicyApplications,
    failurePolicyCount: new Set(failureActions).size,
    failureTargetCount: failureTargets.size,
    qualityRuleCount: enabledQualityRules.length,
    requiredColumnCount,
    transformedColumnCount: transformedColumns.size,
    transformRules,
  };
}
