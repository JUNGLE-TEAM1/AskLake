import { useMemo } from "react";

import { Card } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
import type { SqlResultDraft } from "../../types";
import { SqlJobTargetSettings } from "./SqlJobTargetSettings";
import { WizardSelectField, WizardTimeField } from "./SqlJobWizardFields";
import {
  accessScopeLabels,
  accessScopeOptions,
  buildPermissionSummary,
  buildSqlJobPartitionOptions,
  formatSqlJobWizardScheduleLabel,
  overlapPolicyOptions,
  timezoneSelectOptions,
  weekdaySelectOptions,
  type SqlJobWizardConfiguration,
  type SqlJobWizardBaseDataset,
  type SqlJobWizardDatasetInfo,
  type SqlJobWizardGovernance,
  type SqlJobWizardSchedule,
  type SqlJobWizardScheduleMode,
  type SqlJobWizardTarget,
} from "./sqlJobWizardModel";

export function SqlJobDatasetStep({
  dataset,
  onChange,
  showErrors,
}: {
  dataset: SqlJobWizardDatasetInfo;
  onChange: (patch: Partial<SqlJobWizardDatasetInfo>) => void;
  showErrors: boolean;
}) {
  return (
    <FieldGroup className="grid-cols-12 gap-4 max-[760px]:grid-cols-1">
      <Field className="col-span-12 max-[760px]:col-span-1">
        <FieldLabel htmlFor="sql-job-wizard-name">데이터셋 이름</FieldLabel>
        <Input id="sql-job-wizard-name" value={dataset.name} onChange={(event) => onChange({ name: event.target.value })} />
        {showErrors && !dataset.name.trim() ? <FieldError>데이터셋 이름은 필수입니다.</FieldError> : null}
      </Field>
      <Field className="col-span-12 max-[760px]:col-span-1">
        <FieldLabel htmlFor="sql-job-wizard-description">설명</FieldLabel>
        <Textarea id="sql-job-wizard-description" rows={4} value={dataset.description} onChange={(event) => onChange({ description: event.target.value })} />
        {showErrors && !dataset.description.trim() ? <FieldError>데이터셋 설명은 필수입니다.</FieldError> : null}
      </Field>
    </FieldGroup>
  );
}

export function SqlJobScheduleStep({
  disabled,
  onChange,
  runtime,
  schedule,
}: {
  disabled: boolean;
  onChange: (patch: Partial<SqlJobWizardSchedule>) => void;
  runtime: "compatibility" | "trino";
  schedule: SqlJobWizardSchedule;
}) {
  return (
    <FieldGroup>
      <Field>
        <FieldLabel>실행 방식</FieldLabel>
        <ToggleGroup
          className="grid-cols-3 max-[760px]:grid-cols-1"
          type="single"
          value={schedule.mode}
          onValueChange={(mode) => mode && onChange({ mode: mode as SqlJobWizardScheduleMode })}
        >
          {([
            ["manual", "스케줄링 건너뛰기", "필요할 때 Job 목록에서 직접 실행"],
            ["daily", "매일 실행", "매일 같은 시각에 반복 실행"],
            ["weekly", "매주 실행", "선택한 요일과 시각에 반복 실행"],
          ] as const).map(([value, label, description]) => (
            <ToggleGroupItem
              className={cn("h-auto min-h-20 items-start justify-start gap-3 rounded-lg border p-4 text-left", schedule.mode === value ? "border-blue-500 bg-blue-50" : "border-slate-200")}
              key={value}
              value={value}
            >
              <span><strong className="block text-sm">{label}</strong><small className="mt-1 block text-xs leading-5 text-slate-500">{description}</small></span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Field>
      {schedule.mode !== "manual" ? (
        <div className="grid grid-cols-2 gap-4 max-[760px]:grid-cols-1">
          {schedule.mode === "weekly" ? (
            <WizardSelectField disabled={disabled} id="sql-job-wizard-weekday" label="실행 요일" options={weekdaySelectOptions} value={schedule.weekday} onValueChange={(weekday) => onChange({ weekday })} />
          ) : null}
          <WizardTimeField disabled={disabled} id="sql-job-wizard-time" label="실행 시간" value={schedule.time} onValueChange={(time) => onChange({ time })} />
          <WizardSelectField disabled={disabled} id="sql-job-wizard-timezone" label="시간대" options={timezoneSelectOptions} value={schedule.timezone} onValueChange={(timezone) => onChange({ timezone })} />
          {runtime === "trino" ? (
            <Field className={schedule.mode === "daily" ? "col-span-2 max-[760px]:col-span-1" : undefined}>
              <FieldLabel>실행 겹침 정책</FieldLabel>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                실행 중이면 다음 예약 건너뜀 (Trino 고정 정책)
              </div>
            </Field>
          ) : (
            <WizardSelectField
              className={schedule.mode === "daily" ? "col-span-2 max-[760px]:col-span-1" : undefined}
              disabled={disabled}
              id="sql-job-wizard-overlap"
              label="실행 겹침 정책"
              options={overlapPolicyOptions}
              value={schedule.overlapPolicy}
              onValueChange={(overlapPolicy) => onChange({ overlapPolicy })}
            />
          )}
        </div>
      ) : null}
    </FieldGroup>
  );
}

export function SqlJobGovernanceStep({
  disabled,
  governance,
  onChange,
  projectGroups,
  showErrors,
}: {
  disabled: boolean;
  governance: SqlJobWizardGovernance;
  onChange: (patch: Partial<SqlJobWizardGovernance>) => void;
  projectGroups: Array<{ id: string; name: string }>;
  showErrors: boolean;
}) {
  const projectGroupOptions = projectGroups.map((group) => ({ label: group.name, value: group.id }));
  const setAccessScope = (accessScope: SqlJobWizardGovernance["accessScope"]) => {
    const selectedGroup = projectGroups.find((group) => group.id === governance.principalId) ?? projectGroups[0];
    const principalId = accessScope === "private"
      ? governance.owner.trim()
      : accessScope === "organization"
        ? "authenticated-users"
        : selectedGroup?.id ?? "";
    const principalLabel = accessScope === "project" ? selectedGroup?.name ?? "" : governance.owner.trim();
    onChange({ accessScope, principalId, permissionSummary: buildPermissionSummary(accessScope, principalLabel) });
  };
  return (
    <FieldGroup className="grid-cols-2 max-[760px]:grid-cols-1">
      <Field>
        <FieldLabel htmlFor="sql-job-wizard-owner">데이터 오너</FieldLabel>
        <Input id="sql-job-wizard-owner" value={governance.owner} onChange={(event) => {
          const owner = event.target.value;
          onChange(governance.accessScope === "private"
            ? { owner, principalId: owner.trim(), permissionSummary: buildPermissionSummary("private", owner.trim()) }
            : { owner });
        }} />
        {showErrors && !governance.owner.trim() ? <FieldError>데이터 오너는 필수입니다.</FieldError> : null}
      </Field>
      <WizardSelectField
        disabled={disabled}
        id="sql-job-wizard-access"
        label="접근 범위"
        options={accessScopeOptions}
        value={governance.accessScope}
        onValueChange={setAccessScope}
      />
      {governance.accessScope === "project" && projectGroupOptions.length > 0 ? (
        <WizardSelectField
          disabled={disabled}
          id="sql-job-wizard-project-group"
          label="프로젝트 그룹"
          options={projectGroupOptions}
          value={governance.principalId}
          onValueChange={(principalId) => {
            const label = projectGroups.find((group) => group.id === principalId)?.name ?? principalId;
            onChange({ principalId, permissionSummary: buildPermissionSummary("project", label) });
          }}
        />
      ) : null}
      {governance.accessScope === "project" && projectGroupOptions.length === 0 ? (
        <Field><FieldError>현재 계정에 연결된 프로젝트 그룹이 없습니다. 관리자에서 실제 그룹을 먼저 연결해 주세요.</FieldError></Field>
      ) : null}
      <Field className="col-span-2 max-[760px]:col-span-1">
        <FieldLabel htmlFor="sql-job-wizard-permission-summary">권한 정책 요약</FieldLabel>
        <Textarea id="sql-job-wizard-permission-summary" readOnly rows={3} value={governance.permissionSummary} />
        {showErrors && !governance.permissionSummary.trim() ? <FieldError>권한 정책 요약은 필수입니다.</FieldError> : null}
      </Field>
    </FieldGroup>
  );
}

export function SqlJobReviewStep({
  baseDataset,
  configuration,
  disabled,
  onStoragePathTouched,
  onTargetChange,
  resultDraft,
  runtime,
  showErrors,
}: {
  baseDataset: SqlJobWizardBaseDataset;
  configuration: SqlJobWizardConfiguration;
  disabled: boolean;
  onStoragePathTouched: () => void;
  onTargetChange: (patch: Partial<SqlJobWizardTarget>) => void;
  resultDraft: SqlResultDraft;
  runtime: "compatibility" | "trino";
  showErrors: boolean;
}) {
  const partitionOptions = useMemo(
    () => buildSqlJobPartitionOptions(baseDataset, resultDraft),
    [baseDataset, resultDraft],
  );

  return (
    <div className="grid gap-5">
      <SqlJobTargetSettings
        disabled={disabled}
        onChange={onTargetChange}
        onStoragePathTouched={onStoragePathTouched}
        partitionOptions={partitionOptions}
        runtime={runtime}
        showErrors={showErrors}
        target={configuration.target}
      />

      <div className="grid grid-cols-2 gap-3 max-[760px]:grid-cols-1">
        <Card className="grid gap-2" size="sm" variant="muted"><span className="text-xs font-semibold text-slate-500">데이터셋</span><strong>{configuration.dataset.name}</strong><small className="text-slate-500">{runtime === "trino" ? "ICEBERG · 관리형 저장" : `${configuration.target.fileFormat.toUpperCase()} · ${configuration.target.compression} 압축`}</small></Card>
        <Card className="grid gap-2" size="sm" variant="muted"><span className="text-xs font-semibold text-slate-500">실행 정책</span><strong>{formatSqlJobWizardScheduleLabel(configuration.schedule)}</strong><small className="text-slate-500">{configuration.schedule.mode === "manual" ? "직접 실행" : configuration.schedule.timezone}</small></Card>
        <Card className="grid gap-2" size="sm" variant="muted"><span className="text-xs font-semibold text-slate-500">거버넌스</span><strong>{configuration.governance.owner}</strong><small className="text-slate-500">{accessScopeLabels[configuration.governance.accessScope]}</small></Card>
        <Card className="grid gap-2" size="sm" variant="muted"><span className="text-xs font-semibold text-slate-500">저장 위치</span><strong className="truncate" title={runtime === "trino" ? "AskLake 관리형 Trino 카탈로그" : configuration.target.storagePath}>{runtime === "trino" ? "AskLake 관리형 Trino 카탈로그" : configuration.target.storagePath}</strong><small className="text-slate-500">{runtime === "trino" ? "전체 새로고침" : configuration.target.databaseName} · {configuration.target.partitionColumns.length > 0 ? `${configuration.target.partitionColumns.join(", ")} 파티션` : "파티션 없음"}</small></Card>
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
  );
}
