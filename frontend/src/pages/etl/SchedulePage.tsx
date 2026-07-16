import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldGroup, FieldLabel, FieldLegend, FieldSet, Field as FormField } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import {
  Calendar,
  Check,
  Info,
  PlayCircle,
  Repeat2
} from "lucide-react";
import type React from "react";
import { useState } from "react";
import { CreationFlowLayout, CreationTopActions } from "../../components/creation/CreationFlow";
import { EtlSectionHeader } from "../../components/etl/EtlSectionHeader";
import { EtlStepHeader } from "../../components/etl/EtlStepHeader";
import { normalizeRetryPolicy, retryFailureActionLabels, scheduleOverlapPolicyLabels } from "../../services/draftPipelineContract";
import type { DraftPipelinePatch, ScheduleFlowId } from "../../types";
import type { RetryPolicyDraft, ScheduleDraft, ScheduleOverlapPolicy, WatermarkPolicyDraft, WatermarkWindowMode } from "../../types/etl";

import {
  RepeatFrequency,
  RepeatScheduleDraft,
  ScheduleOptionId
} from "./sourceModel";

export function SchedulePage({
  draftSchedule,
  mode,
  onDraftChange,
  onModeChange,
  onPrev,
  onNext,
}: {
  draftSchedule: ScheduleDraft;
  mode: ScheduleFlowId;
  onDraftChange: (patch: DraftPipelinePatch) => void;
  onModeChange: (flow: ScheduleFlowId) => void;
  onPrev: () => void;
  onNext: () => void;
  onSave: () => void;
}) {
  const draftRetryPolicy = draftSchedule.retryPolicy;
  const draftScheduleLabel = draftSchedule.label;
  const initialRepeat = parseRepeatScheduleLabel(draftScheduleLabel);
  const [repeatFrequency, setRepeatFrequency] = useState<RepeatFrequency>(initialRepeat.frequency);
  const [repeatDay, setRepeatDay] = useState(initialRepeat.day);
  const [repeatTime, setRepeatTime] = useState(initialRepeat.time);
  const [repeatMinute, setRepeatMinute] = useState(initialRepeat.minute);
  const [customCron, setCustomCron] = useState(initialRepeat.cron);
  const [scheduleError, setScheduleError] = useState("");
  const title = "스케줄링 설정";
  const repeatDraft = { cron: customCron, day: repeatDay, frequency: repeatFrequency, minute: repeatMinute, time: repeatTime };
  const selectedOption = getScheduleOptionFromLabel(draftScheduleLabel, mode);
  const scheduleTimezone = normalizeScheduleTimezone(draftSchedule.timezone);
  const scheduleStartDate = normalizeDateValue(draftSchedule.startDate, SCHEDULE_START_DATE);
  const scheduleEndDate = normalizeOptionalDateValue(draftSchedule.endDate);
  const invalidRepeatCron = selectedOption === "repeat" && repeatFrequency === "custom" && !isValidCronExpression(customCron);
  const updateRetryPolicy = (retryPolicy: RetryPolicyDraft) => {
    onDraftChange({ schedule: { retryPolicy } });
  };
  const applyScheduleDraft = () => {
    const normalizedRepeat = normalizeRepeatScheduleDraft(repeatDraft);
    setRepeatDay(normalizedRepeat.day);
    setRepeatTime(normalizedRepeat.time);
    setRepeatMinute(normalizedRepeat.minute);
    setCustomCron(normalizedRepeat.cron);
    onDraftChange(buildSchedulePatch(selectedOption, normalizedRepeat, scheduleTimezone, draftSchedule, { endDate: scheduleEndDate, startDate: scheduleStartDate }));
  };
  const selectOption = (nextOption: ScheduleOptionId) => {
    setScheduleError("");
    onDraftChange(buildSchedulePatch(nextOption, repeatDraft, scheduleTimezone, draftSchedule, { endDate: scheduleEndDate, startDate: scheduleStartDate }));
    onModeChange(scheduleFlowFromOption(nextOption));
  };
  const goNext = () => {
    if (invalidRepeatCron) {
      setScheduleError("Cron 표현식을 5개 필드 형식으로 입력해 주세요. 예: 0 10 * * 1-5");
      return;
    }
    setScheduleError("");
    applyScheduleDraft();
    onNext();
  };

  return (
    <CreationFlowLayout
      actions={<CreationTopActions nextDisabled={invalidRepeatCron} split onPrev={onPrev} onNext={goNext} />}
    >
        <EtlStepHeader
          className="etl-step-standalone-header"
          icon={<Calendar />}
          title={title}
        />
        <Card className="overflow-hidden" size="none">
          <EtlSectionHeader icon={<PlayCircle />} title="실행 방식" />
          <CardContent className="grid gap-6 p-5">
            <div aria-label="실행 방식" className="grid gap-4 md:grid-cols-2" role="group">
              <ScheduleModeCard
                icon={<PlayCircle size={24} />}
                selected={selectedOption === "skip"}
                title="직접 실행"
                onClick={() => selectOption("skip")}
              />
              <ScheduleModeCard
                icon={<Repeat2 size={24} />}
                selected={selectedOption === "repeat"}
                title="반복 실행"
                onClick={() => selectOption("repeat")}
              />
            </div>
            <Separator />
            {scheduleError && <Alert variant="destructive"><Info /><AlertTitle>스케줄을 확인해 주세요.</AlertTitle><AlertDescription>{scheduleError}</AlertDescription></Alert>}
            {selectedOption === "repeat" && <RepeatSettings customCron={customCron} frequency={repeatFrequency} minute={repeatMinute} overlapPolicy={draftSchedule.overlapPolicy ?? DEFAULT_OVERLAP_POLICY} selectedDay={repeatDay} time={repeatTime} timezone={scheduleTimezone} onCronChange={(cron) => {
            const sanitizedCron = sanitizeCronInput(cron);
            setCustomCron(sanitizedCron);
            onDraftChange(buildSchedulePatch("repeat", { cron: sanitizedCron, day: repeatDay, frequency: repeatFrequency, minute: repeatMinute, time: repeatTime }, scheduleTimezone, draftSchedule, { endDate: scheduleEndDate, startDate: scheduleStartDate }));
          }} onCronCommit={() => {
            const normalizedCron = normalizeCronExpression(customCron);
            setCustomCron(normalizedCron);
            onDraftChange(buildSchedulePatch("repeat", { cron: normalizedCron, day: repeatDay, frequency: repeatFrequency, minute: repeatMinute, time: repeatTime }, scheduleTimezone, draftSchedule, { endDate: scheduleEndDate, startDate: scheduleStartDate }));
          }} onDayChange={(day) => {
            setRepeatDay(day);
            onDraftChange(buildSchedulePatch("repeat", { cron: customCron, day, frequency: repeatFrequency, minute: repeatMinute, time: repeatTime }, scheduleTimezone, draftSchedule, { endDate: scheduleEndDate, startDate: scheduleStartDate }));
          }} onFrequencyChange={(frequency) => {
            setRepeatFrequency(frequency);
            onDraftChange(buildSchedulePatch("repeat", { cron: customCron, day: repeatDay, frequency, minute: repeatMinute, time: repeatTime }, scheduleTimezone, draftSchedule, { endDate: scheduleEndDate, startDate: scheduleStartDate }));
          }} onMinuteChange={(minute) => {
            setRepeatMinute(minute);
            onDraftChange(buildSchedulePatch("repeat", { cron: customCron, day: repeatDay, frequency: repeatFrequency, minute, time: repeatTime }, scheduleTimezone, draftSchedule, { endDate: scheduleEndDate, startDate: scheduleStartDate }));
          }} onTimeCommit={() => {
            const normalizedTime = normalizeTimeValue(repeatTime);
            setRepeatTime(normalizedTime);
            onDraftChange(buildSchedulePatch("repeat", { cron: customCron, day: repeatDay, frequency: repeatFrequency, minute: repeatMinute, time: normalizedTime }, scheduleTimezone, draftSchedule, { endDate: scheduleEndDate, startDate: scheduleStartDate }));
          }} onTimeChange={(time) => {
            setRepeatTime(time);
            onDraftChange(buildSchedulePatch("repeat", { cron: customCron, day: repeatDay, frequency: repeatFrequency, minute: repeatMinute, time }, scheduleTimezone, draftSchedule, { endDate: scheduleEndDate, startDate: scheduleStartDate }));
            }} onOverlapPolicyChange={(overlapPolicy) => onDraftChange({ overlapPolicy, schedule: { overlapPolicy } })} onTimezoneChange={(timezone) => onDraftChange(buildSchedulePatch("repeat", repeatDraft, timezone, draftSchedule, { endDate: scheduleEndDate, startDate: scheduleStartDate }))} />}
            <ScheduleRetrySettings retryPolicy={draftRetryPolicy} onRetryPolicyChange={updateRetryPolicy} />
          </CardContent>
        </Card>
    </CreationFlowLayout>
  );
}

function ScheduleModeCard({
  icon,
  selected,
  title,
  onClick,
}: {
  icon: React.ReactNode;
  selected: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={selected}
      className={cn(
        "relative flex min-h-28 items-center gap-4 rounded-xl border bg-white p-5 text-left transition-colors",
        "hover:border-blue-300 hover:bg-blue-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2",
        selected && "border-blue-500 bg-blue-50/70 shadow-[inset_3px_0_0_#2563eb]",
      )}
      type="button"
      onClick={onClick}
    >
      <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600", selected && "bg-blue-100 text-blue-600")}>
        {icon}
      </span>
      <strong className="text-base font-semibold text-slate-950">{title}</strong>
      <span className={cn("absolute right-5 top-5 flex size-5 items-center justify-center rounded-full border border-slate-300 text-transparent", selected && "border-blue-600 bg-blue-600 text-white")}>
        <Check aria-hidden="true" size={13} strokeWidth={3} />
      </span>
    </button>
  );
}

const DEFAULT_REPEAT_DAY = "목";
const DEFAULT_REPEAT_TIME = "10:30";
const DEFAULT_REPEAT_MINUTE = "00";
const DEFAULT_CUSTOM_CRON = "0 10 * * 1-5";
const SCHEDULE_START_DATE = "2026-07-07";
const SCHEDULE_TIMEZONE = "Asia/Seoul";
const DEFAULT_OVERLAP_POLICY: ScheduleOverlapPolicy = "skip_if_running";
const DEFAULT_WATERMARK_POLICY: WatermarkPolicyDraft = {
  column: "updated_at",
  enabled: true,
  lookbackMinutes: 5,
  mode: "last_success_to_scheduled_at",
};
const timezoneOptions = [
  { label: "Asia/Seoul (UTC+09:00)", value: "Asia/Seoul" },
  { label: "UTC", value: "UTC" },
  { label: "America/New_York (DST 적용)", value: "America/New_York" },
  { label: "Europe/London (DST 적용)", value: "Europe/London" },
];

function normalizeScheduleTimezone(timezone?: string) {
  if (!timezone) return SCHEDULE_TIMEZONE;
  if (timezone.includes("Seoul") || timezone.includes("Tokyo") || timezone.includes("GMT+09:00")) return SCHEDULE_TIMEZONE;
  return timezoneOptions.some((option) => option.value === timezone) ? timezone : SCHEDULE_TIMEZONE;
}
const validRepeatMinutes = ["00", "15", "30", "45"];
const validRepeatDays = ["월", "화", "수", "목", "금", "토", "일"];
const repeatFrequencyLabels: Record<RepeatFrequency, string> = {
  hourly: "매시간",
  daily: "매일",
  weekly: "매주",
  custom: "커스텀",
};
const repeatFrequencyOptions = Object.entries(repeatFrequencyLabels).map(([value, label]) => ({ label, value: value as RepeatFrequency }));

function formatScheduleLabel(option: ScheduleOptionId, repeat: RepeatScheduleDraft) {
  const normalizedRepeat = normalizeRepeatScheduleDraft(repeat);
  if (option === "skip") return "스케줄링 건너뛰기";
  if (normalizedRepeat.frequency === "hourly") return `매시간 ${normalizedRepeat.minute}분`;
  if (normalizedRepeat.frequency === "daily") return `매일 ${normalizedRepeat.time}`;
  if (normalizedRepeat.frequency === "custom") return `커스텀: ${normalizedRepeat.cron}`;
  return `매주 ${normalizedRepeat.day}요일 ${normalizedRepeat.time}`;
}

function getScheduleFlowFromLabel(label: string): ScheduleFlowId {
  if (label.includes("건너뛰기") || label.includes("스케줄 없음") || label.includes("수동")) return "manual";
  if (label.includes("1회") || label.includes("예약")) return "manual";
  return "repeat";
}

function getScheduleOptionFromLabel(label: string, fallbackFlow: ScheduleFlowId): ScheduleOptionId {
  if (label.includes("건너뛰기") || label.includes("스케줄 없음") || label.includes("수동")) return "skip";
  if (label.includes("1회") || label.includes("예약")) return "skip";
  if (label) return "repeat";
  return fallbackFlow === "manual" ? "skip" : "repeat";
}

function scheduleFlowFromOption(option: ScheduleOptionId): ScheduleFlowId {
  if (option === "skip") return "manual";
  return "repeat";
}

function buildSchedulePatch(option: ScheduleOptionId, repeat: RepeatScheduleDraft, timezone: string = SCHEDULE_TIMEZONE, currentSchedule?: ScheduleDraft, dates?: { endDate?: string; startDate?: string; }): DraftPipelinePatch {
  const normalizedRepeat = normalizeRepeatScheduleDraft(repeat);
  const label = formatScheduleLabel(option, normalizedRepeat);
  const nextRun = option === "skip" ? "-" : "저장 시점 기준 계산";
  const startDate = option === "repeat" ? normalizeDateValue(dates?.startDate ?? currentSchedule?.startDate, SCHEDULE_START_DATE) : "";
  const normalizedEndDate = option === "repeat" ? normalizeOptionalDateValue(dates?.endDate ?? currentSchedule?.endDate) : "";
  const endDate = normalizedEndDate && normalizedEndDate >= startDate ? normalizedEndDate : "";
  const scheduleTimezone = option === "skip" ? "" : timezone;
  const summary = formatScheduleSummary(option, label, scheduleTimezone);
  const nextRunUtc = option === "skip" ? "" : "";
  const restoreRepeatDefaults = option !== "skip" && (currentSchedule?.mode === "manual" || currentSchedule?.label.includes("건너뛰기"));
  const overlapPolicy = option === "skip" ? undefined : restoreRepeatDefaults ? DEFAULT_OVERLAP_POLICY : currentSchedule?.overlapPolicy ?? DEFAULT_OVERLAP_POLICY;
  const watermarkPolicy = option === "skip"
    ? { ...DEFAULT_WATERMARK_POLICY, enabled: false, mode: "full_refresh" as WatermarkWindowMode }
    : restoreRepeatDefaults ? DEFAULT_WATERMARK_POLICY : currentSchedule?.watermarkPolicy ?? DEFAULT_WATERMARK_POLICY;

  return {
    endDate,
    nextRunUtc,
    overlapPolicy,
    schedule: {
      endDate,
      label,
      nextRun,
      nextRunUtc,
      overlapPolicy,
      startDate,
      summary,
      timezone: scheduleTimezone,
      watermarkPolicy,
    },
    scheduleLabel: label,
    scheduleSummary: summary,
    startDate,
    timezone: scheduleTimezone,
    watermarkPolicy,
  };
}

function formatScheduleSummary(option: ScheduleOptionId, label: string, timezone: string) {
  if (option === "skip") return "스케줄링 건너뛰기 · 나중에 목록에서 직접 실행";
  return `반복 실행 · ${label} · ${timezone} · 저장 후 다음 예약부터 시작`;
}

function parseRepeatScheduleLabel(label: string) {
  const weeklyMatch = label.match(/매주\s+(.+?)요일\s+(.+)$/);
  const dailyMatch = label.match(/매일\s+(.+)$/);
  const hourlyMatch = label.match(/매시간\s+(.+?)분$/);
  const customMatch = label.match(/^커스텀:\s*(.+)$/);
  const frequency: RepeatFrequency = customMatch ? "custom" : hourlyMatch ? "hourly" : dailyMatch ? "daily" : "weekly";

  return {
    cron: customMatch?.[1] ?? DEFAULT_CUSTOM_CRON,
    day: weeklyMatch?.[1] ?? DEFAULT_REPEAT_DAY,
    frequency,
    minute: hourlyMatch?.[1] ?? DEFAULT_REPEAT_MINUTE,
    time: weeklyMatch?.[2] ?? dailyMatch?.[1] ?? DEFAULT_REPEAT_TIME,
  };
}

function normalizeRepeatScheduleDraft(repeat: RepeatScheduleDraft): RepeatScheduleDraft {
  return {
    cron: normalizeCronExpression(repeat.cron),
    day: validRepeatDays.includes(repeat.day) ? repeat.day : DEFAULT_REPEAT_DAY,
    frequency: repeat.frequency,
    minute: validRepeatMinutes.includes(repeat.minute) ? repeat.minute : DEFAULT_REPEAT_MINUTE,
    time: normalizeTimeValue(repeat.time),
  };
}

function normalizeTimeValue(value: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : DEFAULT_REPEAT_TIME;
}

function normalizeDateValue(value: string | undefined, fallback: string) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
}

function normalizeOptionalDateValue(value: string | undefined) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

function sanitizeCronInput(value: string) {
  return value.replace(/[^\d*,/\-\s]/g, "").replace(/\s+/g, " ").slice(0, 64);
}

function isValidCronExpression(value: string) {
  const fields = value.trim().split(/\s+/);
  return fields.length === 5 && fields.every((field) => /^[\d*,/\-]+$/.test(field));
}

function normalizeCronExpression(value: string) {
  const sanitized = sanitizeCronInput(value).trim();
  return isValidCronExpression(sanitized) ? sanitized : DEFAULT_CUSTOM_CRON;
}

function RepeatSettings({
  customCron,
  frequency,
  minute,
  onCronChange,
  onCronCommit,
  onDayChange,
  onFrequencyChange,
  onMinuteChange,
  onOverlapPolicyChange,
  onTimezoneChange,
  onTimeCommit,
  onTimeChange,
  overlapPolicy,
  selectedDay,
  time,
  timezone,
}: {
  customCron: string;
  frequency: RepeatFrequency;
  minute: string;
  onCronChange: (cron: string) => void;
  onCronCommit: () => void;
  onDayChange: (day: string) => void;
  onFrequencyChange: (frequency: RepeatFrequency) => void;
  onMinuteChange: (minute: string) => void;
  onOverlapPolicyChange: (policy: ScheduleOverlapPolicy) => void;
  onTimezoneChange: (timezone: string) => void;
  onTimeCommit: () => void;
  onTimeChange: (time: string) => void;
  overlapPolicy: ScheduleOverlapPolicy;
  selectedDay: string;
  time: string;
  timezone: string;
}) {
  const cronIsValid = isValidCronExpression(customCron);
  const normalizedTimezone = normalizeScheduleTimezone(timezone);
  const visibleRepeatFrequencyOptions = repeatFrequencyOptions;

  return (
    <FieldSet>
      <FieldLegend>반복 일정</FieldLegend>
      <FieldGroup className="grid gap-4 md:grid-cols-2">
        <FormField>
          <FieldLabel htmlFor="schedule-frequency">반복 주기</FieldLabel>
          <Select value={frequency} onValueChange={(value) => onFrequencyChange(value as RepeatFrequency)}>
            <SelectTrigger id="schedule-frequency">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {visibleRepeatFrequencyOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        {frequency === "hourly" && (
          <FormField>
            <FieldLabel htmlFor="schedule-minute">실행 분</FieldLabel>
            <Select value={minute} onValueChange={onMinuteChange}>
              <SelectTrigger id="schedule-minute">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {validRepeatMinutes.map((value) => (
                  <SelectItem key={value} value={value}>{value}분</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        )}
        {frequency === "daily" && (
          <ScheduleTimeField time={time} onTimeChange={onTimeChange} onTimeCommit={onTimeCommit} />
        )}
        {frequency === "weekly" && (
          <FormField className="md:col-span-2">
            <FieldLabel>실행 요일</FieldLabel>
            <ToggleGroup aria-label="실행 요일" className="grid grid-cols-7" type="single" value={selectedDay} onValueChange={(value) => value && onDayChange(value)}>
              {validRepeatDays.map((day) => (
                <ToggleGroupItem className="min-w-0 px-2" key={day} value={day}>
                  {day}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </FormField>
        )}
        {frequency === "weekly" && (
          <ScheduleTimeField time={time} onTimeChange={onTimeChange} onTimeCommit={onTimeCommit} />
        )}
        {frequency === "custom" && (
          <FormField>
            <FieldLabel htmlFor="schedule-cron">Cron 표현식</FieldLabel>
            <Input id="schedule-cron" inputMode="numeric" pattern="[0-9*,/\\-\\s]+" value={customCron} onBlur={onCronCommit} onChange={(event) => onCronChange(event.target.value)} onInput={(event) => onCronChange(event.currentTarget.value)} />
          </FormField>
        )}
        <FormField>
          <FieldLabel htmlFor="schedule-timezone">시간대</FieldLabel>
          <Select value={normalizedTimezone} onValueChange={onTimezoneChange}>
            <SelectTrigger id="schedule-timezone">
              <span>{timezoneOptions.find((option) => option.value === normalizedTimezone)?.label}</span>
            </SelectTrigger>
            <SelectContent>
              {timezoneOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField>
          <FieldLabel htmlFor="schedule-overlap-policy">중복 실행 정책</FieldLabel>
          <Select value={overlapPolicy} onValueChange={(value) => onOverlapPolicyChange(value as ScheduleOverlapPolicy)}>
            <SelectTrigger id="schedule-overlap-policy">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(scheduleOverlapPolicyLabels).map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      </FieldGroup>
      {frequency === "custom" && !cronIsValid && (
        <Alert variant="destructive">
          <Info />
          <AlertTitle>Cron 형식을 확인해 주세요.</AlertTitle>
          <AlertDescription>5개 필드 형식만 저장합니다. 예: 0 10 * * 1-5</AlertDescription>
        </Alert>
      )}
    </FieldSet>
  );
}

function ScheduleTimeField({ onTimeChange, onTimeCommit, time }: { onTimeChange: (time: string) => void; onTimeCommit: () => void; time: string; }) {
  return (
    <FormField>
      <FieldLabel htmlFor="schedule-time">실행 시간</FieldLabel>
      <Input id="schedule-time" max="23:59" min="00:00" step="60" type="time" value={normalizeTimeValue(time)} onBlur={onTimeCommit} onChange={(event) => onTimeChange(event.target.value)} onInput={(event) => onTimeChange(event.currentTarget.value)} />
    </FormField>
  );
}

function ScheduleRetrySettings({ onRetryPolicyChange, retryPolicy: value }: { onRetryPolicyChange: (policy: RetryPolicyDraft) => void; retryPolicy: RetryPolicyDraft; }) {
  const retryPolicy = normalizeRetryPolicy(value);
  const retryEnabled = retryPolicy.maxRetries > 0;
  const normalizeNumber = (nextValue: string, fallback: number, min: number, max: number) => {
    const parsed = Number.parseInt(nextValue, 10);
    return Number.isNaN(parsed) ? fallback : Math.min(Math.max(parsed, min), max);
  };
  const updateNumber = (key: "maxRetries" | "maxRetryDelayMinutes", nextValue: string, fallback: number, min: number, max: number) => {
    onRetryPolicyChange({ ...retryPolicy, [key]: normalizeNumber(nextValue, fallback, min, max) });
  };
  const updateInitialDelay = (nextValue: string) => {
    const nextDelay = normalizeNumber(nextValue, 1, 1, 1440);
    onRetryPolicyChange({
      ...retryPolicy,
      initialRetryDelayMinutes: nextDelay,
      maxRetryDelayMinutes: Math.max(retryPolicy.maxRetryDelayMinutes, nextDelay),
      retryIntervalMinutes: nextDelay,
    });
  };
  const blockInvalidNumberKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (["e", "E", "+", "-", "."].includes(event.key)) event.preventDefault();
  };

  return (
    <FieldSet>
      <div className="flex items-center justify-between gap-4">
        <FieldLegend className="mb-0">재시도 정책</FieldLegend>
        <div className="flex items-center gap-3">
          <FieldLabel htmlFor="schedule-retry-enabled">재시도 사용</FieldLabel>
          <Switch
            checked={retryEnabled}
            id="schedule-retry-enabled"
            onCheckedChange={(checked) => onRetryPolicyChange({ ...retryPolicy, maxRetries: checked ? Math.max(retryPolicy.maxRetries, 3) : 0 })}
          />
        </div>
      </div>
      <FieldGroup className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {retryEnabled && (
          <>
            <FormField>
              <FieldLabel htmlFor="schedule-max-retries">최대 재시도</FieldLabel>
              <InputGroup>
                <InputGroupInput id="schedule-max-retries" inputMode="numeric" max="10" min="1" type="number" value={retryPolicy.maxRetries} onChange={(event) => updateNumber("maxRetries", event.target.value, 3, 1, 10)} onKeyDown={blockInvalidNumberKey} />
                <InputGroupAddon><InputGroupText>회</InputGroupText></InputGroupAddon>
              </InputGroup>
            </FormField>
            <FormField>
              <FieldLabel htmlFor="schedule-initial-delay">시작 지연</FieldLabel>
              <InputGroup>
                <InputGroupInput id="schedule-initial-delay" inputMode="numeric" max="1440" min="1" type="number" value={retryPolicy.initialRetryDelayMinutes} onChange={(event) => updateInitialDelay(event.target.value)} onKeyDown={blockInvalidNumberKey} />
                <InputGroupAddon><InputGroupText>분</InputGroupText></InputGroupAddon>
              </InputGroup>
            </FormField>
            <FormField>
              <FieldLabel htmlFor="schedule-max-delay">최대 간격</FieldLabel>
              <InputGroup>
                <InputGroupInput id="schedule-max-delay" inputMode="numeric" max="1440" min={retryPolicy.initialRetryDelayMinutes} type="number" value={retryPolicy.maxRetryDelayMinutes} onChange={(event) => updateNumber("maxRetryDelayMinutes", event.target.value, 30, retryPolicy.initialRetryDelayMinutes, 1440)} onKeyDown={blockInvalidNumberKey} />
                <InputGroupAddon><InputGroupText>분</InputGroupText></InputGroupAddon>
              </InputGroup>
            </FormField>
          </>
        )}
        <FormField className={retryEnabled ? "" : "md:col-span-2 xl:col-span-2"}>
          <FieldLabel htmlFor="schedule-failure-action">최종 실패 처리</FieldLabel>
          <Select value={retryPolicy.failureAction} onValueChange={(failureAction) => onRetryPolicyChange({ ...retryPolicy, failureAction: failureAction as RetryPolicyDraft["failureAction"] })}>
            <SelectTrigger id="schedule-failure-action">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(retryFailureActionLabels).map(([optionValue, label]) => (
                <SelectItem key={optionValue} value={optionValue}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      </FieldGroup>
    </FieldSet>
  );
}
