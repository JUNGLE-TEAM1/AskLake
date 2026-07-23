import type { FlowId, ScheduleFlowId } from "../../types";

export type EtlWizardStep = {
  flow: FlowId;
  label: string;
  path: string;
};

const baseStepRegistry: Record<Extract<FlowId, "source" | "recordParsing" | "schema" | "rules" | "permission" | "target" | "review">, EtlWizardStep> = {
  source: { flow: "source", label: "소스", path: "/etl/source" },
  recordParsing: { flow: "recordParsing", label: "레코드 구조화", path: "/etl/record-parsing" },
  schema: { flow: "schema", label: "처리", path: "/etl/schema" },
  rules: { flow: "rules", label: "처리 규칙", path: "/etl/rules" },
  permission: { flow: "permission", label: "권한", path: "/etl/permission" },
  target: { flow: "target", label: "타겟", path: "/etl/target" },
  review: { flow: "review", label: "검토", path: "/etl/review" },
};

export function buildEtlWizardSteps({
  continuousKafka,
  requiresRecordParsing,
  scheduleFlow,
}: {
  continuousKafka: boolean;
  requiresRecordParsing: boolean;
  scheduleFlow: ScheduleFlowId;
}): EtlWizardStep[] {
  const steps: EtlWizardStep[] = [baseStepRegistry.source];
  if (requiresRecordParsing) steps.push(baseStepRegistry.recordParsing);
  steps.push(baseStepRegistry.schema);
  if (!continuousKafka) {
    steps.push({ flow: scheduleFlow, label: "스케줄", path: "/etl/schedule" });
  }
  steps.push(baseStepRegistry.permission, baseStepRegistry.target, baseStepRegistry.review);
  return steps;
}

export function etlFlowPath(flow: FlowId) {
  if (flow === "repeat" || flow === "manual") return "/etl/schedule";
  if (flow in baseStepRegistry) return baseStepRegistry[flow as keyof typeof baseStepRegistry].path;
  return null;
}

export function etlStyleRoute(flow: FlowId) {
  const path = etlFlowPath(flow);
  return path?.startsWith("/etl/") ? path.slice("/etl/".length) : null;
}

export function etlFlowFromRoute(
  id: string | undefined,
  action: string | undefined,
  segmentCount: number,
  currentScheduleFlow: ScheduleFlowId,
): FlowId | null {
  const directMatch = Object.values(baseStepRegistry).find((step) => step.path === `/etl/${id}`);
  if (directMatch) return directMatch.flow;
  if (id !== "schedule") return null;
  if (segmentCount === 2) return currentScheduleFlow;
  if (segmentCount === 3 && (action === "manual" || action === "repeat")) return action;
  return null;
}
