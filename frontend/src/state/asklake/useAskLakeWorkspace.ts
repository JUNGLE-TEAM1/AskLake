import type { FlowId } from "../../types";
import type { WriteAuditLog } from "./contracts";
import { useCatalogController } from "./useCatalogController";
import { useJobController } from "./useJobController";
import { usePipelineMutations } from "./usePipelineMutations";
import { useAskLakeWorkspaceState } from "./useAskLakeWorkspaceState";
import { useWorkspaceHydration } from "./useWorkspaceHydration";

export function useAskLakeWorkspace({
  enabled = true,
  onFlowChange,
  showToast,
  writeAuditLog,
}: {
  enabled?: boolean;
  onFlowChange: (flow: FlowId) => void;
  showToast: (message: string, tone?: "success" | "info") => void;
  writeAuditLog: WriteAuditLog;
}) {
  const state = useAskLakeWorkspaceState();
  const hydration = useWorkspaceHydration({ enabled, showToast, state });
  const pipeline = usePipelineMutations({ onFlowChange, showToast, state, writeAuditLog });
  const catalog = useCatalogController({ onFlowChange, showToast, state, writeAuditLog });
  const jobs = useJobController({ enabled, onFlowChange, showToast, state, writeAuditLog });

  return {
    apiPending: state.apiPending,
    commandPendingByJobId: state.commandPendingByJobId,
    createMutationState: state.createMutationState,
    createPipeline: pipeline.createPipeline,
    createSqlDatasetJob: pipeline.createSqlDatasetJob,
    createTrinoSqlJob: pipeline.createTrinoSqlJob,
    dagStepsByRunId: state.dagStepsByRunId,
    dataError: state.dataError,
    dataLoading: state.dataLoading,
    datasets: state.datasets,
    deleteMaterializationRun: catalog.deleteMaterializationRun,
    draftPipeline: state.draftPipeline,
    filterJobs: hydration.filterJobs,
    handleJobCommand: jobs.handleJobCommand,
    jobExecutionEvidence: state.jobExecutionEvidence,
    jobListFacets: state.jobListFacets,
    jobs: state.jobs,
    jobsLoading: state.jobsLoading,
    openDataset: catalog.openDataset,
    openDatasetInSql: catalog.openDatasetInSql,
    openJobDetail: jobs.openJobDetail,
    openJobRuns: jobs.openJobRuns,
    refreshData: hydration.refreshData,
    runsByJobId: state.runsByJobId,
    selectedDataset: state.selectedDataset,
    selectedJob: state.selectedJob,
    selectedRunIdByJobId: state.selectedRunIdByJobId,
    selectRunForJob: jobs.selectRunForJob,
    setSelectedDataset: state.setSelectedDataset,
    setSelectedJob: state.setSelectedJob,
    setSqlResultDraft: state.setSqlResultDraft,
    sqlResultDraft: state.sqlResultDraft,
    updateDraftPipeline: pipeline.updateDraftPipeline,
  };
}
