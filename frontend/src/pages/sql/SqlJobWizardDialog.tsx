import { useEffect, useMemo, useRef, useState } from "react";
import { Calendar, Check, ChevronLeft, ChevronRight, Database, HardDrive, ShieldCheck } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  SqlJobDatasetStep,
  SqlJobGovernanceStep,
  SqlJobReviewStep,
  SqlJobScheduleStep,
} from "./SqlJobWizardSteps";
import {
  buildDefaultStoragePath,
  buildInitialSqlJobConfiguration,
  createSqlJobRequest,
  validateSqlJobStep,
  type SqlJobWizardBaseDataset,
  type SqlJobWizardConfiguration,
  type SqlJobWizardCreateRequest,
  type SqlJobWizardDatasetInfo,
  type SqlJobWizardDefaultMetadata,
  type SqlJobWizardStepId,
} from "./sqlJobWizardModel";
import type { SqlResultDraft } from "../../types";

export {
  formatSqlJobWizardScheduleLabel,
  formatSqlJobWizardScheduleSummary,
} from "./sqlJobWizardModel";
export type { SqlJobWizardCreateRequest } from "./sqlJobWizardModel";

export interface SqlJobWizardDialogProps {
  baseDataset: SqlJobWizardBaseDataset;
  defaultMetadata?: SqlJobWizardDefaultMetadata;
  onClose: () => void;
  onCreate: (request: SqlJobWizardCreateRequest) => Promise<boolean | void>;
  open: boolean;
  pending?: boolean;
  resultDraft: SqlResultDraft;
}

const wizardSteps: Array<{
  icon: typeof Database;
  id: SqlJobWizardStepId;
  label: string;
}> = [
  { icon: Database, id: "dataset", label: "기본 정보" },
  { icon: Calendar, id: "schedule", label: "스케줄" },
  { icon: ShieldCheck, id: "governance", label: "거버넌스" },
  { icon: HardDrive, id: "review", label: "저장 및 검토" },
];

export function SqlJobWizardDialog({
  baseDataset,
  defaultMetadata,
  onClose,
  onCreate,
  open,
  pending = false,
  resultDraft,
}: SqlJobWizardDialogProps) {
  const [configuration, setConfiguration] = useState(() => buildInitialSqlJobConfiguration(baseDataset, resultDraft, defaultMetadata));
  const [stepIndex, setStepIndex] = useState(0);
  const [highestStepIndex, setHighestStepIndex] = useState(0);
  const [showErrors, setShowErrors] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [storagePathTouched, setStoragePathTouched] = useState(false);
  const previousContextRef = useRef<string | null>(null);
  const contextKey = `${baseDataset.id}:${resultDraft.runId}`;
  const activeStep = wizardSteps[stepIndex];
  const activeErrors = validateSqlJobStep(activeStep.id, configuration);
  const isBusy = pending || submitting;
  const allErrors = useMemo(
    () => wizardSteps.flatMap((step) => validateSqlJobStep(step.id, configuration)),
    [configuration],
  );

  useEffect(() => {
    if (!open) {
      previousContextRef.current = null;
      return;
    }
    if (previousContextRef.current === contextKey) return;
    previousContextRef.current = contextKey;
    setConfiguration(buildInitialSqlJobConfiguration(baseDataset, resultDraft, defaultMetadata));
    setStepIndex(0);
    setHighestStepIndex(0);
    setShowErrors(false);
    setSubmitError(null);
    setStoragePathTouched(false);
  }, [baseDataset, contextKey, defaultMetadata, open, resultDraft]);

  const updateDataset = (patch: Partial<SqlJobWizardDatasetInfo>) => {
    setConfiguration((current) => {
      const dataset = { ...current.dataset, ...patch };
      const shouldSyncPath = !storagePathTouched || current.target.storagePath === buildDefaultStoragePath(current.dataset);
      return {
        ...current,
        dataset,
        target: {
          ...current.target,
          storagePath: shouldSyncPath ? buildDefaultStoragePath(dataset) : current.target.storagePath,
        },
      };
    });
  };
  const updateSchedule = (patch: Partial<SqlJobWizardConfiguration["schedule"]>) => {
    setConfiguration((current) => ({
      ...current,
      schedule: { ...current.schedule, ...patch },
    }));
  };
  const updateGovernance = (patch: Partial<SqlJobWizardConfiguration["governance"]>) => {
    setConfiguration((current) => ({
      ...current,
      governance: { ...current.governance, ...patch },
    }));
  };
  const updateTarget = (patch: Partial<SqlJobWizardConfiguration["target"]>) => {
    setConfiguration((current) => ({
      ...current,
      target: { ...current.target, ...patch },
    }));
  };

  const goToStep = (nextIndex: number) => {
    if (nextIndex < 0 || nextIndex >= wizardSteps.length || nextIndex > highestStepIndex) return;
    setStepIndex(nextIndex);
    setShowErrors(false);
    setSubmitError(null);
  };

  const goNext = () => {
    if (activeErrors.length > 0) {
      setShowErrors(true);
      return;
    }
    const nextIndex = Math.min(stepIndex + 1, wizardSteps.length - 1);
    setHighestStepIndex((current) => Math.max(current, nextIndex));
    setStepIndex(nextIndex);
    setShowErrors(false);
    setSubmitError(null);
  };

  const createJob = async () => {
    if (allErrors.length > 0) {
      const firstInvalidIndex = wizardSteps.findIndex((step) => validateSqlJobStep(step.id, configuration).length > 0);
      setStepIndex(Math.max(firstInvalidIndex, 0));
      setHighestStepIndex((current) => Math.max(current, Math.max(firstInvalidIndex, 0)));
      setShowErrors(true);
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await onCreate(createSqlJobRequest(baseDataset, resultDraft, configuration));
      if (created !== false) onClose();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "처리 Job 생성 요청을 완료하지 못했습니다.");
    } finally {
      setSubmitting(false);
    }
  };

  const footer = (
    <>
      <Button type="button" disabled={isBusy} onClick={onClose} size="sm" variant="ghost">취소</Button>
      <Button type="button" disabled={isBusy || stepIndex === 0} onClick={() => goToStep(stepIndex - 1)} size="sm" variant="outline">
        <ChevronLeft data-icon="inline-start" /> 이전
      </Button>
      {stepIndex < wizardSteps.length - 1 ? (
        <Button type="button" disabled={isBusy} onClick={goNext} size="sm" variant="primary">
          다음 <ChevronRight data-icon="inline-end" />
        </Button>
      ) : (
        <Button type="button" disabled={isBusy || allErrors.length > 0} onClick={() => void createJob()} size="sm" variant="primary">
          {isBusy ? <Spinner /> : <Database data-icon="inline-start" />}
          {isBusy ? "생성 중..." : "처리 Job 생성"}
        </Button>
      )}
    </>
  );

  return (
    <DialogShell
      bodyClassName="min-h-0"
      contentClassName="grid-rows-[auto_minmax(0,1fr)_auto]"
      footer={footer}
      onClose={onClose}
      open={open}
      showCloseButton={!isBusy}
      size="wide"
      title="SQL 결과 처리 Job 생성"
    >
      <div className="grid gap-5">
        <nav aria-label="처리 Job 생성 단계" className="grid grid-cols-4 gap-2 max-[760px]:grid-cols-2">
          {wizardSteps.map((step, index) => {
            const Icon = step.icon;
            const complete = index < stepIndex;
            const active = index === stepIndex;
            const enabled = index <= highestStepIndex;
            return (
              <button
                aria-current={active ? "step" : undefined}
                className={cn(
                  "flex min-w-0 items-center gap-3 rounded-lg border px-3 py-3 text-left transition-colors",
                  active ? "border-blue-500 bg-blue-50" : "border-slate-200 bg-white",
                  enabled ? "hover:border-blue-300" : "cursor-default opacity-60",
                )}
                disabled={!enabled || isBusy}
                key={step.id}
                onClick={() => goToStep(index)}
                type="button"
              >
                <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", active || complete ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-500")}>
                  {complete ? <Check size={16} /> : <Icon size={16} />}
                </span>
                <strong className="min-w-0 truncate text-sm text-slate-950">{step.label}</strong>
              </button>
            );
          })}
        </nav>

        {showErrors && activeErrors.length > 0 ? (
          <Alert variant="destructive">
            <AlertTitle>입력값을 확인해 주세요.</AlertTitle>
            <AlertDescription>{activeErrors.join(" ")}</AlertDescription>
          </Alert>
        ) : null}
        {submitError ? (
          <Alert variant="destructive">
            <AlertTitle>Job 생성에 실패했습니다.</AlertTitle>
            <AlertDescription>{submitError}</AlertDescription>
          </Alert>
        ) : null}

        {activeStep.id === "dataset" ? (
          <SqlJobDatasetStep dataset={configuration.dataset} onChange={updateDataset} showErrors={showErrors} />
        ) : null}

        {activeStep.id === "schedule" ? (
          <SqlJobScheduleStep disabled={isBusy} onChange={updateSchedule} schedule={configuration.schedule} />
        ) : null}

        {activeStep.id === "governance" ? (
          <SqlJobGovernanceStep
            disabled={isBusy}
            governance={configuration.governance}
            onChange={updateGovernance}
            showErrors={showErrors}
          />
        ) : null}

        {activeStep.id === "review" ? (
          <SqlJobReviewStep
            baseDataset={baseDataset}
            configuration={configuration}
            disabled={isBusy}
            onStoragePathTouched={() => setStoragePathTouched(true)}
            onTargetChange={updateTarget}
            resultDraft={resultDraft}
            showErrors={showErrors}
          />
        ) : null}
      </div>
    </DialogShell>
  );
}
