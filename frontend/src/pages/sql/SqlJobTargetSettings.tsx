import { useState } from "react";
import { BookOpen, HardDrive, Plus, SlidersHorizontal, X } from "lucide-react";

import { DatabaseField } from "@/components/target/DatabaseField";
import { S3PathField } from "@/components/s3/S3PathField";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  compressionOptions,
  fileFormatOptions,
  type SqlJobWizardCompression,
  type SqlJobWizardFileFormat,
  type SqlJobWizardPartitionOption,
  type SqlJobWizardTarget,
} from "./sqlJobWizardModel";

interface SqlJobTargetSettingsProps {
  disabled: boolean;
  onChange: (patch: Partial<SqlJobWizardTarget>) => void;
  onStoragePathTouched: () => void;
  partitionOptions: SqlJobWizardPartitionOption[];
  showErrors: boolean;
  target: SqlJobWizardTarget;
}

function TargetSelectField<T extends string>({
  disabled,
  id,
  label,
  onValueChange,
  options,
  value,
}: {
  disabled: boolean;
  id: string;
  label: string;
  onValueChange: (value: T) => void;
  options: ReadonlyArray<{ label: string; value: T }>;
  value: T;
}) {
  return (
    <Field data-disabled={disabled || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select disabled={disabled} onValueChange={(nextValue) => onValueChange(nextValue as T)} value={value}>
        <SelectTrigger id={id} size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

export function SqlJobTargetSettings({
  disabled,
  onChange,
  onStoragePathTouched,
  partitionOptions,
  showErrors,
  target,
}: SqlJobTargetSettingsProps) {
  const [customTag, setCustomTag] = useState("");
  const storagePathInvalid = Boolean(target.storagePath && !/^s3a?:\/\//i.test(target.storagePath));

  const addTag = () => {
    const nextTag = customTag.trim().replace(/^#+/, "");
    if (!nextTag || target.tags.some((tag) => tag.toLowerCase() === nextTag.toLowerCase())) return;
    onChange({ tags: [...target.tags, nextTag] });
    setCustomTag("");
  };

  const removeTag = (tagToRemove: string) => {
    onChange({ tags: target.tags.filter((tag) => tag !== tagToRemove) });
  };

  const togglePartition = (columnName: string, selected: boolean) => {
    onChange({
      partitionColumns: selected
        ? [...target.partitionColumns, columnName]
        : target.partitionColumns.filter((column) => column !== columnName),
    });
  };

  return (
    <div className="grid gap-4">
      <Card size="none">
        <CardHeader className="flex flex-row items-center gap-3 border-b border-slate-200 px-4 py-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-blue-50 text-blue-600">
            <HardDrive className="size-4" aria-hidden="true" />
          </span>
          <CardTitle className="text-base">저장 위치 설정</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-12 gap-4 px-4 pb-4 pt-4 max-[760px]:grid-cols-1">
          <Field className="col-span-5 max-[760px]:col-span-1" data-disabled={disabled || undefined}>
            <FieldLabel>DB 선택</FieldLabel>
            <DatabaseField disabled={disabled} useShadcnStyles value={target.databaseName} onChange={(databaseName) => onChange({ databaseName })} />
          </Field>
          <div className="col-span-3 max-[760px]:col-span-1">
            <TargetSelectField
              disabled={disabled}
              id="sql-job-wizard-format"
              label="포맷"
              options={fileFormatOptions}
              value={target.fileFormat}
              onValueChange={(fileFormat: SqlJobWizardFileFormat) => onChange({ fileFormat })}
            />
          </div>
          <div className="col-span-4 max-[760px]:col-span-1">
            <TargetSelectField
              disabled={disabled}
              id="sql-job-wizard-compression"
              label="압축 방식"
              options={compressionOptions}
              value={target.compression}
              onValueChange={(compression: SqlJobWizardCompression) => onChange({ compression })}
            />
          </div>
          <Field
            className="col-span-12 max-[760px]:col-span-1"
            data-invalid={showErrors && (!target.storagePath.trim() || storagePathInvalid) ? true : undefined}
          >
            <FieldLabel>저장 경로</FieldLabel>
            <S3PathField
              disabled={disabled}
              useShadcnStyles
              value={target.storagePath}
              onChange={(storagePath) => {
                onStoragePathTouched();
                onChange({ storagePath });
              }}
            />
            {showErrors && (!target.storagePath.trim() || storagePathInvalid) ? (
              <FieldError>유효한 S3 저장 경로를 선택해 주세요.</FieldError>
            ) : null}
          </Field>
        </CardContent>
      </Card>

      <Card size="none">
        <CardHeader className="flex flex-row items-center gap-3 border-b border-slate-200 px-4 py-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-blue-50 text-blue-600">
            <SlidersHorizontal className="size-4" aria-hidden="true" />
          </span>
          <CardTitle className="text-base">파티션 및 태그</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-5 px-4 pb-4 pt-4 max-[760px]:grid-cols-1">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="sql-job-wizard-tag">
                <BookOpen className="mr-1 inline size-4 text-blue-600" aria-hidden="true" />
                태그
              </FieldLabel>
              {target.tags.length > 0 ? (
                <div className="flex min-h-10 flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-2" aria-label="타겟 태그" role="group">
                  {target.tags.map((tag) => (
                    <Button key={tag} size="sm" type="button" variant="secondary" onClick={() => removeTag(tag)}>
                      #{tag}
                      <X data-icon="inline-end" />
                      <span className="sr-only">{tag} 태그 삭제</span>
                    </Button>
                  ))}
                </div>
              ) : (
                <p className="rounded-lg border border-dashed border-slate-200 p-3 text-sm text-slate-500">추가된 태그가 없습니다.</p>
              )}
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <Input
                  disabled={disabled}
                  id="sql-job-wizard-tag"
                  placeholder="직접 태그 추가"
                  value={customTag}
                  onChange={(event) => setCustomTag(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addTag();
                    }
                  }}
                />
                <Button disabled={disabled || !customTag.trim()} type="button" variant="outline" onClick={addTag}>
                  <Plus data-icon="inline-start" /> 추가
                </Button>
              </div>
            </Field>
          </FieldGroup>

          <FieldSet disabled={disabled}>
            <FieldLegend className="text-sm">파티션</FieldLegend>
            <div className="grid grid-cols-2 gap-2 max-[980px]:grid-cols-1" role="group" aria-label="파티션 컬럼 다중 선택">
              {partitionOptions.map((option) => {
                const checked = target.partitionColumns.includes(option.name);
                const checkboxId = `sql-job-partition-${option.name}`;
                return (
                  <FieldLabel
                    className={cn(
                      "grid min-h-10 cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2",
                      checked && "border-blue-500 bg-blue-50",
                    )}
                    htmlFor={checkboxId}
                    key={option.name}
                  >
                    <Checkbox
                      checked={checked}
                      id={checkboxId}
                      onCheckedChange={(nextChecked) => togglePartition(option.name, nextChecked === true)}
                    />
                    <span className="truncate">{option.name}</span>
                    <span className="font-mono text-xs font-medium text-slate-500">{option.type}</span>
                  </FieldLabel>
                );
              })}
            </div>
          </FieldSet>
        </CardContent>
      </Card>
    </div>
  );
}
