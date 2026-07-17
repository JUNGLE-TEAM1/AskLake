import type { FlowId } from "../../types";

export type WorkspaceDataRequirements = {
  catalog: boolean;
  jobs: boolean;
};

const jobDataFlows = new Set<FlowId>(["jobs", "jobDetail", "jobRuns"]);

const catalogDataFlows = new Set<FlowId>(["catalog", "catalogDetail", "sql", "semantic"]);

export function getWorkspaceDataRequirements(flow: FlowId): WorkspaceDataRequirements {
  return {
    catalog: catalogDataFlows.has(flow),
    jobs: jobDataFlows.has(flow),
  };
}
