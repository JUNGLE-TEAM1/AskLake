import type { FlowId } from "../../types";
import type { WriteAuditLog } from "./contracts";
import { getWorkspaceDataRequirements } from "./routeDataRequirements";
import { useCatalogHydration } from "./useCatalogHydration";
import { useCatalogController } from "./useCatalogController";
import { useJobController } from "./useJobController";
import { useJobsHydration } from "./useJobsHydration";
import { usePipelineMutations } from "./usePipelineMutations";
import { useAskLakeWorkspaceState } from "./useAskLakeWorkspaceState";

export function useAskLakeWorkspace({
  activeFlow,
  enabled = true,
  onFlowChange,
  showToast,
  writeAuditLog,
}: {
  activeFlow: FlowId;
  enabled?: boolean;
  onFlowChange: (flow: FlowId) => void;
  showToast: (message: string, tone?: "success" | "info") => void;
  writeAuditLog: WriteAuditLog;
}) {
  const state = useAskLakeWorkspaceState();
  const dataRequirements = getWorkspaceDataRequirements(activeFlow);
  const jobsHydration = useJobsHydration({ enabled: enabled && dataRequirements.jobs, showToast, state });
  const catalogHydration = useCatalogHydration({ enabled: enabled && dataRequirements.catalog, showToast, state });
  const pipeline = usePipelineMutations({ onFlowChange, showToast, state, writeAuditLog });
  const catalog = useCatalogController({ onFlowChange, showToast, state, writeAuditLog });
  const jobs = useJobController({ enabled: enabled && dataRequirements.jobs, onFlowChange, showToast, state, writeAuditLog });
  const refreshData = async () => {
    if (dataRequirements.jobs) return jobsHydration.refreshJobs();
    if (dataRequirements.catalog) return catalogHydration.refreshCatalog();
    return false;
  };

  return {
    apiPending: state.apiPending,
    catalogError: state.catalogError,
    catalogLoading: state.catalogLoading,
    commandPendingByJobId: state.commandPendingByJobId,
    createMutationState: state.createMutationState,
    createPipeline: pipeline.createPipeline,
    createSqlDatasetJob: pipeline.createSqlDatasetJob,
    createTrinoSqlJob: pipeline.createTrinoSqlJob,
    dagStepsByRunId: state.dagStepsByRunId,
    dataRequirements,
    datasets: state.datasets,
    deleteMaterializationRun: catalog.deleteMaterializationRun,
    draftPipeline: state.draftPipeline,
    filterJobs: jobsHydration.filterJobs,
    handleJobCommand: jobs.handleJobCommand,
    jobExecutionEvidence: state.jobExecutionEvidence,
    jobListFacets: state.jobListFacets,
    jobs: state.jobs,
    jobsError: state.jobsError,
    jobsLoading: state.jobsLoading,
    openDataset: catalog.openDataset,
    openDatasetInSql: catalog.openDatasetInSql,
    openJobDetail: jobs.openJobDetail,
    openJobRuns: jobs.openJobRuns,
    refreshData,
    resetDraftPipeline: pipeline.resetDraftPipeline,
    runsByJobId: state.runsByJobId,
    selectedDataset: state.selectedDataset,
    selectedJob: state.selectedJob,
    selectedRunIdByJobId: state.selectedRunIdByJobId,
    selectRunForJob: jobs.selectRunForJob,
    setSelectedDataset: state.setSelectedDataset,
    setJobs: state.setJobs,
    setSelectedJob: state.setSelectedJob,
    setSqlResultDraft: state.setSqlResultDraft,
    sqlResultDraft: state.sqlResultDraft,
    updateDraftPipeline: pipeline.updateDraftPipeline,
  };
}
