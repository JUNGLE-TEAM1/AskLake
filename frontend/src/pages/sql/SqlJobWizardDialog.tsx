import { useEffect, useMemo, useRef, useState } from "react";
import {
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  Database,
  HardDrive,
  ShieldCheck,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import type {
  CatalogDataset,
  DerivedDatasetLayer,
  ScheduleOverlapPolicy,
  SqlResultDraft,
} from "../../types";

export type SqlJobWizardScheduleMode = "manual" | "daily" | "weekly";
export type SqlJobWizardAccessScope = "organization" | "private" | "project";
export type SqlJobWizardCompression = "Gzip" | "None" | "Snappy";
export type SqlJobWizardWeekday = "금" | "목" | "수" | "월" | "일" | "토" | "화";

export type SqlJobWizardDatasetInfo = {
  description: string;
  layer: DerivedDatasetLayer;
  name: string;
};

export type SqlJobWizardSchedule = {
  mode: SqlJobWizardScheduleMode;
  overlapPolicy: ScheduleOverlapPolicy;
  time: string;
  timezone: string;
  weekday: SqlJobWizardWeekday;
};

export type SqlJobWizardGovernance = {
  accessScope: SqlJobWizardAccessScope;
  owner: string;
  permissionSummary: string;
};

export type SqlJobWizardTarget = {
  compression: SqlJobWizardCompression;
  partitionColumn: string;
  storagePath: string;
};

export type SqlJobWizardConfiguration = {
  dataset: SqlJobWizardDatasetInfo;
  governance: SqlJobWizardGovernance;
  schedule: SqlJobWizardSchedule;
  target: SqlJobWizardTarget;
};

export type SqlJobWizardSourceContext = {
  baseDatasetId: string;
  baseDatasetName: string;
  columns: string[];
  previewLimit?: number;
  query: string;
  referenceDatasetIds: string[];
  resultDatasetId: string;
  resultDatasetName: string;
  rowCount: number;
  rows: string[][];
  sourceRunId: string;
  validationKey?: string;
};

export type SqlJobWizardCreateRequest = {
  configuration: SqlJobWizardConfiguration;
  context: SqlJobWizardSourceContext;
};

export type SqlJobWizardDefaultMetadata = Partial<SqlJobWizardDatasetInfo>;

export interface SqlJobWizardDialogProps {
  baseDataset: Pick<CatalogDataset, "id" | "name" | "owner">;
  defaultMetadata?: SqlJobWizardDefaultMetadata;
  engine?: "compatibility" | "trino";
  onClose: () => void;
  onCreate: (request: SqlJobWizardCreateRequest) => Promise<boolean | void>;
  open: boolean;
  pending?: boolean;
  resultDraft: SqlResultDraft;
}

type WizardStepId = "dataset" | "governance" | "review" | "schedule";

const wizardSteps: Array<{
  description: string;
  icon: typeof Database;
  id: WizardStepId;
  label: string;
}> = [
  { description: "생성할 데이터셋", icon: Database, id: "dataset", label: "기본 정보" },
  { description: "실행 주기와 정책", icon: Calendar, id: "schedule", label: "스케줄" },
  { description: "소유자와 접근 범위", icon: ShieldCheck, id: "governance", label: "거버넌스" },
  { description: "저장 위치와 결과 확인", icon: HardDrive, id: "review", label: "저장 및 검토" },
];

const weekdayOptions: SqlJobWizardWeekday[] = ["월", "화", "수", "목", "금", "토", "일"];
const timezoneOptions = ["Asia/Seoul", "UTC", "America/New_York", "Europe/London"];
const accessScopeLabels: Record<SqlJobWizardAccessScope, string> = {
  organization: "조직 내부",
  private: "소유자 전용",
  project: "프로젝트 멤버",
};
const overlapPolicyLabels: Record<ScheduleOverlapPolicy, string> = {
  allow_parallel: "겹쳐도 새 Run 시작",
  queue_after_current: "현재 Run 종료 후 실행",
  skip_if_running: "실행 중이면 다음 예약 건너뜀",
};

function normalizePathSegment(value: string) {
  return value.trim().replace(/\s+/g, "_") || "sql_result";
}

function buildDefaultStoragePath(dataset: SqlJobWizardDatasetInfo) {
  return `s3a://asklake-output/${normalizePathSegment(dataset.name)}/${dataset.layer.toLowerCase()}/`;
}

function findDefaultPartitionColumn(columns: string[]) {
  return columns.find((column) => /(date|time|month|year|created_at|updated_at)$/i.test(column)) ?? "";
}

function buildPermissionSummary(accessScope: SqlJobWizardAccessScope) {
  return `Data Engineer Group · ${accessScopeLabels[accessScope]} · 승인 검토`;
}

function buildInitialConfiguration(
  baseDataset: SqlJobWizardDialogProps["baseDataset"],
  resultDraft: SqlResultDraft,
  defaults?: SqlJobWizardDefaultMetadata,
): SqlJobWizardConfiguration {
  const dataset: SqlJobWizardDatasetInfo = {
    description: defaults?.description ?? `${baseDataset.name} SQL 결과로 생성한 분석 데이터셋`,
    layer: defaults?.layer ?? "GOLD",
    name: defaults?.name ?? `${baseDataset.name}_analysis`,
  };
  const accessScope: SqlJobWizardAccessScope = "organization";

  return {
    dataset,
    governance: {
      accessScope,
      owner: baseDataset.owner || "data-team-01",
      permissionSummary: buildPermissionSummary(accessScope),
    },
    schedule: {
      mode: "manual",
      overlapPolicy: "skip_if_running",
      time: "09:00",
      timezone: "Asia/Seoul",
      weekday: "월",
    },
    target: {
      compression: "Snappy",
      partitionColumn: findDefaultPartitionColumn(resultDraft.columns),
      storagePath: buildDefaultStoragePath(dataset),
    },
  };
}

export function formatSqlJobWizardScheduleLabel(schedule: SqlJobWizardSchedule) {
  if (schedule.mode === "manual") return "스케줄링 건너뛰기";
  if (schedule.mode === "daily") return `매일 ${schedule.time}`;
  return `매주 ${schedule.weekday}요일 ${schedule.time}`;
}

export function formatSqlJobWizardScheduleSummary(schedule: SqlJobWizardSchedule) {
  if (schedule.mode === "manual") return "스케줄링 건너뛰기 · Job 목록에서 직접 실행";
  return `반복 실행 · ${formatSqlJobWizardScheduleLabel(schedule)} · ${schedule.timezone} · ${overlapPolicyLabels[schedule.overlapPolicy]}`;
}

function isValidTime(value: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validateStep(step: WizardStepId, configuration: SqlJobWizardConfiguration, engine: "compatibility" | "trino") {
  const errors: string[] = [];
  if (step === "dataset") {
    if (!configuration.dataset.name.trim()) errors.push("데이터셋 이름을 입력해 주세요.");
    if (!configuration.dataset.description.trim()) errors.push("데이터셋 설명을 입력해 주세요.");
  }
  if (step === "schedule" && configuration.schedule.mode !== "manual") {
    if (!isValidTime(configuration.schedule.time)) errors.push("실행 시간을 HH:mm 형식으로 입력해 주세요.");
    if (!configuration.schedule.timezone.trim()) errors.push("시간대를 선택해 주세요.");
  }
  if (step === "governance") {
    if (!configuration.governance.owner.trim()) errors.push("데이터 오너를 입력해 주세요.");
    if (!configuration.governance.permissionSummary.trim()) errors.push("권한 정책 요약을 입력해 주세요.");
  }
  if (step === "review" && engine === "compatibility") {
    if (!configuration.target.storagePath.trim()) errors.push("저장 경로를 입력해 주세요.");
    if (configuration.target.storagePath && !/^s3a?:\/\//i.test(configuration.target.storagePath)) {
      errors.push("저장 경로는 s3:// 또는 s3a:// 형식이어야 합니다.");
    }
  }
  return errors;
}

function createRequest(
  baseDataset: SqlJobWizardDialogProps["baseDataset"],
  resultDraft: SqlResultDraft,
  configuration: SqlJobWizardConfiguration,
): SqlJobWizardCreateRequest {
  return {
    configuration,
    context: {
      baseDatasetId: baseDataset.id,
      baseDatasetName: baseDataset.name,
      columns: [...resultDraft.columns],
      previewLimit: resultDraft.previewLimit,
      query: resultDraft.query,
      referenceDatasetIds: [...(resultDraft.referenceDatasetIds ?? [])],
      resultDatasetId: resultDraft.datasetId,
      resultDatasetName: resultDraft.datasetName,
      rowCount: resultDraft.rowCount,
      rows: resultDraft.rows.map((row) => [...row]),
      sourceRunId: resultDraft.runId,
      validationKey: resultDraft.validationKey,
    },
  };
}

export function SqlJobWizardDialog({
  baseDataset,
  defaultMetadata,
  engine = "compatibility",
  onClose,
  onCreate,
  open,
  pending = false,
  resultDraft,
}: SqlJobWizardDialogProps) {
  const [configuration, setConfiguration] = useState(() => buildInitialConfiguration(baseDataset, resultDraft, defaultMetadata));
  const [stepIndex, setStepIndex] = useState(0);
  const [highestStepIndex, setHighestStepIndex] = useState(0);
  const [showErrors, setShowErrors] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [storagePathTouched, setStoragePathTouched] = useState(false);
  const previousContextRef = useRef<string | null>(null);
  const contextKey = `${baseDataset.id}:${resultDraft.runId}`;
  const activeStep = wizardSteps[stepIndex];
  const activeErrors = validateStep(activeStep.id, configuration, engine);
  const isBusy = pending || submitting;
  const allErrors = useMemo(
    () => wizardSteps.flatMap((step) => validateStep(step.id, configuration, engine)),
    [configuration, engine],
  );

  useEffect(() => {
    if (!open) {
      previousContextRef.current = null;
      return;
    }
    if (previousContextRef.current === contextKey) return;
    previousContextRef.current = contextKey;
    setConfiguration(buildInitialConfiguration(baseDataset, resultDraft, defaultMetadata));
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
      const firstInvalidIndex = wizardSteps.findIndex((step) => validateStep(step.id, configuration, engine).length > 0);
      setStepIndex(Math.max(firstInvalidIndex, 0));
      setHighestStepIndex((current) => Math.max(current, Math.max(firstInvalidIndex, 0)));
      setShowErrors(true);
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await onCreate(createRequest(baseDataset, resultDraft, configuration));
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
          {isBusy ? "생성 중..." : engine === "trino" ? "반복 SQL Job 생성" : "처리 Job 생성"}
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
      title={engine === "trino" ? "반복 SQL Job 생성" : "SQL 결과 처리 Job 생성"}
    >
      <div className="grid gap-5">
        <nav aria-label={engine === "trino" ? "반복 SQL Job 생성 단계" : "처리 Job 생성 단계"} className="grid grid-cols-4 gap-2 max-[760px]:grid-cols-2">
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
                <span className="min-w-0">
                  <strong className="block truncate text-sm text-slate-950">{step.label}</strong>
                  <small className="block truncate text-xs text-slate-500">{step.description}</small>
                </span>
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
          <FieldGroup className="grid-cols-12 gap-4 max-[760px]:grid-cols-1">
            <Field className="col-span-12 max-[760px]:col-span-1">
              <FieldLabel htmlFor="sql-job-wizard-name">데이터셋 이름</FieldLabel>
              <Input id="sql-job-wizard-name" value={configuration.dataset.name} onChange={(event) => updateDataset({ name: event.target.value })} />
              {showErrors && !configuration.dataset.name.trim() ? <FieldError>데이터셋 이름은 필수입니다.</FieldError> : null}
            </Field>
            <Field className="col-span-12 max-[760px]:col-span-1">
              <FieldLabel htmlFor="sql-job-wizard-description">설명</FieldLabel>
              <Textarea id="sql-job-wizard-description" rows={4} value={configuration.dataset.description} onChange={(event) => updateDataset({ description: event.target.value })} />
              {showErrors && !configuration.dataset.description.trim() ? <FieldError>데이터셋 설명은 필수입니다.</FieldError> : null}
            </Field>
          </FieldGroup>
        ) : null}

        {activeStep.id === "schedule" ? (
          <FieldGroup>
            <Field>
              <FieldLabel>실행 방식</FieldLabel>
              <ToggleGroup
                className="grid-cols-3 max-[760px]:grid-cols-1"
                type="single"
                value={configuration.schedule.mode}
                onValueChange={(mode) => {
                  if (!mode) return;
                  setConfiguration((current) => ({ ...current, schedule: { ...current.schedule, mode: mode as SqlJobWizardScheduleMode } }));
                }}
              >
                {([
                  ["manual", "스케줄링 건너뛰기", "필요할 때 Job 목록에서 직접 실행"],
                  ["daily", "매일 실행", "매일 같은 시각에 반복 실행"],
                  ["weekly", "매주 실행", "선택한 요일과 시각에 반복 실행"],
                ] as const).map(([value, label, description]) => (
                  <ToggleGroupItem
                    className={cn("h-auto min-h-20 items-start justify-start gap-3 rounded-lg border p-4 text-left", configuration.schedule.mode === value ? "border-blue-500 bg-blue-50" : "border-slate-200")}
                    key={value}
                    value={value}
                  >
                    <span><strong className="block text-sm">{label}</strong><small className="mt-1 block text-xs leading-5 text-slate-500">{description}</small></span>
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Field>
            {configuration.schedule.mode !== "manual" ? (
              <div className="grid grid-cols-2 gap-4 max-[760px]:grid-cols-1">
                {configuration.schedule.mode === "weekly" ? (
                  <Field>
                    <FieldLabel htmlFor="sql-job-wizard-weekday">실행 요일</FieldLabel>
                    <NativeSelect id="sql-job-wizard-weekday" value={configuration.schedule.weekday} onChange={(event) => setConfiguration((current) => ({ ...current, schedule: { ...current.schedule, weekday: event.target.value as SqlJobWizardWeekday } }))}>
                      {weekdayOptions.map((day) => <option key={day} value={day}>{day}요일</option>)}
                    </NativeSelect>
                  </Field>
                ) : null}
                <Field>
                  <FieldLabel htmlFor="sql-job-wizard-time">실행 시간</FieldLabel>
                  <Input id="sql-job-wizard-time" type="time" value={configuration.schedule.time} onChange={(event) => setConfiguration((current) => ({ ...current, schedule: { ...current.schedule, time: event.target.value } }))} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="sql-job-wizard-timezone">시간대</FieldLabel>
                  <NativeSelect id="sql-job-wizard-timezone" value={configuration.schedule.timezone} onChange={(event) => setConfiguration((current) => ({ ...current, schedule: { ...current.schedule, timezone: event.target.value } }))}>
                    {timezoneOptions.map((timezone) => <option key={timezone} value={timezone}>{timezone}</option>)}
                  </NativeSelect>
                </Field>
                <Field className={configuration.schedule.mode === "daily" ? "col-span-2 max-[760px]:col-span-1" : undefined}>
                  <FieldLabel htmlFor="sql-job-wizard-overlap">실행 겹침 정책</FieldLabel>
                  {engine === "trino" ? (
                    <Input id="sql-job-wizard-overlap" readOnly value={overlapPolicyLabels.skip_if_running} />
                  ) : (
                    <NativeSelect id="sql-job-wizard-overlap" value={configuration.schedule.overlapPolicy} onChange={(event) => setConfiguration((current) => ({ ...current, schedule: { ...current.schedule, overlapPolicy: event.target.value as ScheduleOverlapPolicy } }))}>
                      {Object.entries(overlapPolicyLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </NativeSelect>
                  )}
                </Field>
              </div>
            ) : null}
          </FieldGroup>
        ) : null}

        {activeStep.id === "governance" ? (
          <FieldGroup className="grid-cols-2 max-[760px]:grid-cols-1">
            <Field>
              <FieldLabel htmlFor="sql-job-wizard-owner">데이터 오너</FieldLabel>
              <Input id="sql-job-wizard-owner" value={configuration.governance.owner} onChange={(event) => setConfiguration((current) => ({ ...current, governance: { ...current.governance, owner: event.target.value } }))} />
              {showErrors && !configuration.governance.owner.trim() ? <FieldError>데이터 오너는 필수입니다.</FieldError> : null}
            </Field>
            <Field>
              <FieldLabel htmlFor="sql-job-wizard-access">접근 범위</FieldLabel>
              <NativeSelect
                id="sql-job-wizard-access"
                value={configuration.governance.accessScope}
                onChange={(event) => {
                  const accessScope = event.target.value as SqlJobWizardAccessScope;
                  setConfiguration((current) => ({
                    ...current,
                    governance: {
                      ...current.governance,
                      accessScope,
                      permissionSummary: buildPermissionSummary(accessScope),
                    },
                  }));
                }}
              >
                {Object.entries(accessScopeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </NativeSelect>
            </Field>
            <Field className="col-span-2 max-[760px]:col-span-1">
              <FieldLabel htmlFor="sql-job-wizard-permission-summary">권한 정책 요약</FieldLabel>
              <Textarea id="sql-job-wizard-permission-summary" rows={3} value={configuration.governance.permissionSummary} onChange={(event) => setConfiguration((current) => ({ ...current, governance: { ...current.governance, permissionSummary: event.target.value } }))} />
              {showErrors && !configuration.governance.permissionSummary.trim() ? <FieldError>권한 정책 요약은 필수입니다.</FieldError> : null}
            </Field>
          </FieldGroup>
        ) : null}

        {activeStep.id === "review" ? (
          <div className="grid gap-5">
            <FieldGroup className={engine === "trino" ? "grid-cols-2 max-[760px]:grid-cols-1" : "grid-cols-3 max-[760px]:grid-cols-1"}>
              {engine === "compatibility" ? <Field>
                <FieldLabel htmlFor="sql-job-wizard-compression">압축 방식</FieldLabel>
                <NativeSelect id="sql-job-wizard-compression" value={configuration.target.compression} onChange={(event) => setConfiguration((current) => ({ ...current, target: { ...current.target, compression: event.target.value as SqlJobWizardCompression } }))}>
                  <option value="Snappy">Snappy</option><option value="Gzip">Gzip</option><option value="None">압축 없음</option>
                </NativeSelect>
              </Field> : <Field>
                <FieldLabel>갱신 방식</FieldLabel>
                <Input readOnly value="전체 갱신 (full refresh)" />
              </Field>}
              <Field>
                <FieldLabel htmlFor="sql-job-wizard-partition">파티션 컬럼</FieldLabel>
                <NativeSelect id="sql-job-wizard-partition" value={configuration.target.partitionColumn || "__none__"} onChange={(event) => setConfiguration((current) => ({ ...current, target: { ...current.target, partitionColumn: event.target.value === "__none__" ? "" : event.target.value } }))}>
                  <option value="__none__">파티션 없음</option>
                  {resultDraft.columns.map((column) => <option key={column} value={column}>{column}</option>)}
                </NativeSelect>
              </Field>
              {engine === "compatibility" ? <Field>
                <FieldLabel htmlFor="sql-job-wizard-storage">저장 경로</FieldLabel>
                <Input id="sql-job-wizard-storage" value={configuration.target.storagePath} onChange={(event) => { setStoragePathTouched(true); setConfiguration((current) => ({ ...current, target: { ...current.target, storagePath: event.target.value } })); }} />
                {showErrors && validateStep("review", configuration, engine).length > 0 ? <FieldError>유효한 S3 저장 경로를 입력해 주세요.</FieldError> : null}
              </Field> : null}
            </FieldGroup>

            <div className="grid grid-cols-2 gap-3 max-[760px]:grid-cols-1">
              <Card className="grid gap-2" size="sm" variant="muted"><span className="text-xs font-semibold text-slate-500">데이터셋</span><strong>{configuration.dataset.name}</strong><small className="text-slate-500">{engine === "trino" ? "Iceberg · 전체 갱신" : `${configuration.target.compression} 압축`}</small></Card>
              <Card className="grid gap-2" size="sm" variant="muted"><span className="text-xs font-semibold text-slate-500">실행 정책</span><strong>{formatSqlJobWizardScheduleLabel(configuration.schedule)}</strong><small className="text-slate-500">{configuration.schedule.mode === "manual" ? "직접 실행" : configuration.schedule.timezone}</small></Card>
              <Card className="grid gap-2" size="sm" variant="muted"><span className="text-xs font-semibold text-slate-500">거버넌스</span><strong>{configuration.governance.owner}</strong><small className="text-slate-500">{accessScopeLabels[configuration.governance.accessScope]}</small></Card>
              <Card className="grid gap-2" size="sm" variant="muted"><span className="text-xs font-semibold text-slate-500">저장 위치</span><strong className="truncate" title={engine === "trino" ? "Trino 관리 Iceberg" : configuration.target.storagePath}>{engine === "trino" ? "Trino 관리 Iceberg" : configuration.target.storagePath}</strong><small className="text-slate-500">{configuration.target.partitionColumn ? `${configuration.target.partitionColumn} 파티션` : "파티션 없음"}</small></Card>
            </div>

            <section className="grid gap-3" aria-labelledby="sql-job-wizard-preview-title">
              <h3 className="font-semibold" id="sql-job-wizard-preview-title">SQL 결과 미리보기</h3>
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <Table className="min-w-[720px]">
                  <TableHeader><TableRow>{resultDraft.columns.map((column) => <TableHead key={column}>{column}</TableHead>)}</TableRow></TableHeader>
                  <TableBody>
                    {resultDraft.rows.slice(0, 5).map((row, rowIndex) => (
                      <TableRow key={rowIndex}>{resultDraft.columns.map((column, columnIndex) => <TableCell className="max-w-56 truncate" key={`${column}-${columnIndex}`} title={row[columnIndex] ?? ""}>{row[columnIndex] ?? ""}</TableCell>)}</TableRow>
                    ))}
                    {resultDraft.rows.length === 0 ? <TableRow><TableCell className="text-center text-slate-500" colSpan={Math.max(resultDraft.columns.length, 1)}>조회된 결과가 없습니다.</TableCell></TableRow> : null}
                  </TableBody>
                </Table>
              </div>
            </section>
          </div>
        ) : null}
      </div>
    </DialogShell>
  );
}
