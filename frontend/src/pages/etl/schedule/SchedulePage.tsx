import { useState } from "react";
import type React from "react";
import { Calendar, Clock3, PlayCircle, Repeat2 } from "lucide-react";
import { Field, InfoBox, PageTitle, RetryPolicy } from "../../../components/common";
import { CreationFlowLayout, CreationSummaryPanel } from "../../../components/creation/CreationFlow";
import { Checkbox } from "../../../components/ui/checkbox";
import { Input } from "../../../components/ui/input";
import { NativeSelect } from "../../../components/ui/native-select";
import { SelectableCard } from "../../../components/ui/selectable-card";
import type { DraftPipelinePatch, ScheduleFlowId } from "../../../types";
import type { RetryPolicyDraft } from "../../../types/etl";

type RepeatFrequency = "hourly" | "daily" | "weekly" | "custom";
type RepeatScheduleDraft = {
  cron: string;
  day: string;
  frequency: RepeatFrequency;
  minute: string;
  time: string;
};

export function SchedulePage({
  draftRetryPolicy,
  draftScheduleLabel,
  mode,
  onDraftChange,
  onModeChange,
  onPrev,
  onNext,
  onSave,
}: {
  draftRetryPolicy: RetryPolicyDraft;
  draftScheduleLabel: string;
  mode: ScheduleFlowId;
  onDraftChange: (patch: DraftPipelinePatch) => void;
  onModeChange: (flow: ScheduleFlowId) => void;
  onPrev: () => void;
  onNext: () => void;
  onSave: () => void;
}) {
  const initialRepeat = parseRepeatScheduleLabel(draftScheduleLabel);
  const [repeatFrequency, setRepeatFrequency] = useState<RepeatFrequency>(initialRepeat.frequency);
  const [repeatDay, setRepeatDay] = useState(initialRepeat.day);
  const [repeatTime, setRepeatTime] = useState(initialRepeat.time);
  const [repeatMinute, setRepeatMinute] = useState(initialRepeat.minute);
  const [customCron, setCustomCron] = useState(initialRepeat.cron);
  const [onceDateTime, setOnceDateTime] = useState(parseOnceScheduleLabel(draftScheduleLabel));
  const title = "스케줄링 설정";
  const selected = mode === "repeat" ? "반복 실행" : mode === "manual" ? "수동 실행" : "1회 실행";
  const repeatDraft = { cron: customCron, day: repeatDay, frequency: repeatFrequency, minute: repeatMinute, time: repeatTime };
  const scheduleLabel = formatScheduleLabel(mode, repeatDraft, onceDateTime);
  const updateRetryPolicy = (retryPolicy: RetryPolicyDraft) => {
    onDraftChange({ schedule: { retryPolicy } });
  };
  const applyScheduleDraft = () => {
    const normalizedRepeat = normalizeRepeatScheduleDraft(repeatDraft);
    const normalizedOnceDateTime = normalizeDateTimeLocal(onceDateTime);
    setRepeatDay(normalizedRepeat.day);
    setRepeatTime(normalizedRepeat.time);
    setRepeatMinute(normalizedRepeat.minute);
    setCustomCron(normalizedRepeat.cron);
    setOnceDateTime(normalizedOnceDateTime);
    onDraftChange({ scheduleLabel: formatScheduleLabel(mode, normalizedRepeat, normalizedOnceDateTime) });
  };
  const selectMode = (nextMode: ScheduleFlowId) => {
    onDraftChange({ scheduleLabel: formatScheduleLabel(nextMode, repeatDraft, onceDateTime) });
    onModeChange(nextMode);
  };
  const goNext = () => {
    applyScheduleDraft();
    onNext();
  };
  const saveSchedule = () => {
    applyScheduleDraft();
    onSave();
  };

  return (
    <CreationFlowLayout
      side={<CreationSummaryPanel flow={mode} title="설정 요약" selected={scheduleLabel || selected} onPrev={onPrev} onNext={goNext} onSave={saveSchedule} />}
    >
        <PageTitle title={title} description="파이프라인의 실행 주기 및 재시도 정책을 설정합니다." />
        <section className="panel">
          <div className="section-heading">
            <PlayCircle size={20} />
            <h2>실행 방식 설정</h2>
          </div>
          <div className="option-grid">
            <RunTypeCard active={mode === "manual"} icon={<PlayCircle size={24} />} title="수동 실행" desc="사용자가 직접 트리거할 때만 실행됩니다." onClick={() => selectMode("manual")} />
            <RunTypeCard active={mode === "once"} icon={<Clock3 size={24} />} title="1회 실행" desc="지정된 시간에 단 한 번만 실행됩니다." onClick={() => selectMode("once")} />
            <RunTypeCard active={mode === "repeat"} icon={<Repeat2 size={24} />} title="반복 실행" desc="주기적으로 반복하여 데이터를 처리합니다." onClick={() => selectMode("repeat")} />
          </div>
        </section>
        {mode === "repeat" && <RepeatSettings customCron={customCron} frequency={repeatFrequency} minute={repeatMinute} retryPolicy={draftRetryPolicy} selectedDay={repeatDay} time={repeatTime} onCronChange={(cron) => {
          const sanitizedCron = sanitizeCronInput(cron);
          setCustomCron(sanitizedCron);
          onDraftChange({ scheduleLabel: formatScheduleLabel("repeat", { cron: sanitizedCron, day: repeatDay, frequency: repeatFrequency, minute: repeatMinute, time: repeatTime }, onceDateTime) });
        }} onCronCommit={() => {
          const normalizedCron = normalizeCronExpression(customCron);
          setCustomCron(normalizedCron);
          onDraftChange({ scheduleLabel: formatScheduleLabel("repeat", { cron: normalizedCron, day: repeatDay, frequency: repeatFrequency, minute: repeatMinute, time: repeatTime }, onceDateTime) });
        }} onDayChange={(day) => {
          setRepeatDay(day);
          onDraftChange({ scheduleLabel: formatScheduleLabel("repeat", { cron: customCron, day, frequency: repeatFrequency, minute: repeatMinute, time: repeatTime }, onceDateTime) });
        }} onFrequencyChange={(frequency) => {
          setRepeatFrequency(frequency);
          onDraftChange({ scheduleLabel: formatScheduleLabel("repeat", { cron: customCron, day: repeatDay, frequency, minute: repeatMinute, time: repeatTime }, onceDateTime) });
        }} onMinuteChange={(minute) => {
          setRepeatMinute(minute);
          onDraftChange({ scheduleLabel: formatScheduleLabel("repeat", { cron: customCron, day: repeatDay, frequency: repeatFrequency, minute, time: repeatTime }, onceDateTime) });
        }} onTimeCommit={() => {
          const normalizedTime = normalizeTimeValue(repeatTime);
          setRepeatTime(normalizedTime);
          onDraftChange({ scheduleLabel: formatScheduleLabel("repeat", { cron: customCron, day: repeatDay, frequency: repeatFrequency, minute: repeatMinute, time: normalizedTime }, onceDateTime) });
        }} onTimeChange={(time) => {
          setRepeatTime(time);
          onDraftChange({ scheduleLabel: formatScheduleLabel("repeat", { cron: customCron, day: repeatDay, frequency: repeatFrequency, minute: repeatMinute, time }, onceDateTime) });
        }} onRetryPolicyChange={updateRetryPolicy} />}
        {mode === "manual" && <ManualSettings retryPolicy={draftRetryPolicy} onRetryPolicyChange={updateRetryPolicy} />}
        {mode === "once" && <OnceSettings dateTime={onceDateTime} retryPolicy={draftRetryPolicy} onDateTimeChange={(dateTime) => {
          setOnceDateTime(dateTime);
          onDraftChange({ scheduleLabel: formatScheduleLabel("once", { cron: customCron, day: repeatDay, frequency: repeatFrequency, minute: repeatMinute, time: repeatTime }, dateTime) });
        }} onDateTimeCommit={() => {
          const normalizedDateTime = normalizeDateTimeLocal(onceDateTime);
          setOnceDateTime(normalizedDateTime);
          onDraftChange({ scheduleLabel: formatScheduleLabel("once", repeatDraft, normalizedDateTime) });
        }} onRetryPolicyChange={updateRetryPolicy} />}
    </CreationFlowLayout>
  );
}

function RunTypeCard({ active, icon, title, desc, onClick }: { active: boolean; icon: React.ReactNode; title: string; desc: string; onClick: () => void }) {
  return (
    <SelectableCard
      className="run-card"
      description={desc}
      icon={<span className="run-icon">{icon}</span>}
      selected={active}
      selectedIndicator={<span className="run-selected-dot" />}
      title={title}
      onClick={onClick}
    />
  );
}

const DEFAULT_REPEAT_DAY = "목";
const DEFAULT_REPEAT_TIME = "10:30";
const DEFAULT_REPEAT_MINUTE = "00";
const DEFAULT_CUSTOM_CRON = "0 10 * * 1-5";
const DEFAULT_ONCE_DATE_TIME = "2026-07-05T10:00";
const validRepeatMinutes = ["00", "15", "30", "45"];
const validRepeatDays = ["월", "화", "수", "목", "금", "토", "일"];
const repeatFrequencyLabels: Record<RepeatFrequency, string> = {
  hourly: "매시간",
  daily: "매일",
  weekly: "매주",
  custom: "커스텀",
};

function formatScheduleLabel(mode: ScheduleFlowId, repeat: RepeatScheduleDraft, onceDateTime: string) {
  const normalizedRepeat = normalizeRepeatScheduleDraft(repeat);
  if (mode === "manual") return "수동 실행";
  if (mode === "once") return `${formatDateTimeLocalLabel(onceDateTime)} 1회 실행`;
  if (normalizedRepeat.frequency === "hourly") return `매시간 ${normalizedRepeat.minute}분`;
  if (normalizedRepeat.frequency === "daily") return `매일 ${normalizedRepeat.time}`;
  if (normalizedRepeat.frequency === "custom") return `커스텀: ${normalizedRepeat.cron}`;
  return `매주 ${normalizedRepeat.day}요일 ${normalizedRepeat.time}`;
}

export function getScheduleFlowFromLabel(label: string): ScheduleFlowId {
  if (label.includes("수동")) return "manual";
  if (label.includes("1회")) return "once";
  return "repeat";
}

function parseOnceScheduleLabel(label: string) {
  if (!label.includes("1회")) return DEFAULT_ONCE_DATE_TIME;
  return normalizeDateTimeLocal(label.replace(/\s*1회 실행\s*$/, "").trim());
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

function normalizeDateTimeLocal(value: string) {
  const normalizedValue = value.replace(".", "-").replace(".", "-").replace(" ", "T");
  return /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(normalizedValue) ? normalizedValue : DEFAULT_ONCE_DATE_TIME;
}

function formatDateTimeLocalLabel(value: string) {
  return normalizeDateTimeLocal(value).replace("T", " ").replaceAll("-", ".");
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
  onRetryPolicyChange,
  onTimeCommit,
  onTimeChange,
  retryPolicy,
  selectedDay,
  time,
}: {
  customCron: string;
  frequency: RepeatFrequency;
  minute: string;
  onCronChange: (cron: string) => void;
  onCronCommit: () => void;
  onDayChange: (day: string) => void;
  onFrequencyChange: (frequency: RepeatFrequency) => void;
  onMinuteChange: (minute: string) => void;
  onRetryPolicyChange: (policy: RetryPolicyDraft) => void;
  onTimeCommit: () => void;
  onTimeChange: (time: string) => void;
  retryPolicy: RetryPolicyDraft;
  selectedDay: string;
  time: string;
}) {
  const cronIsValid = isValidCronExpression(customCron);
  const preview = frequency === "hourly"
    ? `매시간 ${minute}분에 실행됩니다. 다음 실행 예정: 2026.07.05 11:${minute}`
    : frequency === "daily"
      ? `매일 ${time}에 실행됩니다. 다음 실행 예정: 2026.07.06 ${time}`
      : frequency === "custom"
        ? `Cron ${customCron || DEFAULT_CUSTOM_CRON} 기준으로 실행됩니다.`
        : `매주 ${selectedDay}요일 ${time}에 실행됩니다. 다음 실행 예정: 2026.07.09 ${time}`;

  return (
    <section className="panel">
      <div className="panel-header">
        <Repeat2 size={18} />
        <h2>반복 실행 상세 설정</h2>
      </div>
      <div className="form-grid">
        <label className="field">
          <span>반복 주기</span>
          <NativeSelect className="input control-input" value={frequency} onChange={(event) => onFrequencyChange(event.target.value as RepeatFrequency)}>
            {Object.entries(repeatFrequencyLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </NativeSelect>
        </label>
        {frequency === "hourly" && (
          <label className="field">
            <span>실행 분</span>
            <NativeSelect className="input control-input" value={minute} onChange={(event) => onMinuteChange(event.target.value)}>
              {validRepeatMinutes.map((value) => (
                <option key={value} value={value}>{value}분</option>
              ))}
            </NativeSelect>
          </label>
        )}
        {frequency === "daily" && (
          <label className="field">
            <span>실행 시간</span>
            <Input className="input control-input" max="23:59" min="00:00" step="60" type="time" value={normalizeTimeValue(time)} onBlur={onTimeCommit} onChange={(event) => onTimeChange(event.target.value)} onInput={(event) => onTimeChange(event.currentTarget.value)} />
          </label>
        )}
        {frequency === "weekly" && (
          <div className="field wide">
            <span>실행 요일</span>
            <div className="weekday-group">
              {validRepeatDays.map((day) => (
                <button className={day === selectedDay ? "weekday active" : "weekday"} key={day} type="button" onClick={() => onDayChange(day)}>
                  {day}
                </button>
              ))}
            </div>
          </div>
        )}
        {frequency === "weekly" && (
          <label className="field">
            <span>실행 시간</span>
            <Input className="input control-input" max="23:59" min="00:00" step="60" type="time" value={normalizeTimeValue(time)} onBlur={onTimeCommit} onChange={(event) => onTimeChange(event.target.value)} onInput={(event) => onTimeChange(event.currentTarget.value)} />
          </label>
        )}
        {frequency === "custom" && (
          <label className="field wide">
            <span>Cron 표현식</span>
            <Input className="input control-input" inputMode="numeric" pattern="[0-9*,/\\-\\s]+" value={customCron} onBlur={onCronCommit} onChange={(event) => onCronChange(event.target.value)} onInput={(event) => onCronChange(event.currentTarget.value)} />
          </label>
        )}
        <Field label="시간대" value="(GMT+09:00) Seoul, Tokyo" />
        <Field label="시작 날짜" value="07/02/2026" icon={<Calendar size={16} />} />
        <Field label="종료 날짜" value="mm/dd/yyyy" icon={<Calendar size={16} />} muted />
      </div>
      <InfoBox title="실행 미리보기" body={preview} />
      {frequency === "custom" && !cronIsValid && <InfoBox title="Cron 형식 확인" body="5개 필드 형식만 저장합니다. 예: 0 10 * * 1-5" />}
      <label className="policy-check-row">
        <Checkbox defaultChecked />
        <span>
          <strong>과거 데이터 소급 (Backfill)</strong>
          <small>파이프라인 생성 시점 이전의 누락된 구간 데이터를 자동으로 처리합니다.</small>
        </span>
      </label>
      <RetryPolicy value={retryPolicy} onChange={onRetryPolicyChange} />
    </section>
  );
}

function ManualSettings({ onRetryPolicyChange, retryPolicy }: { onRetryPolicyChange: (policy: RetryPolicyDraft) => void; retryPolicy: RetryPolicyDraft }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <PlayCircle size={18} />
        <h2>수동 실행 상세 설정</h2>
      </div>
      <InfoBox title="자동 스케줄 없음" body="이 파이프라인은 저장 후 사용자가 직접 실행할 때만 동작합니다. 테스트 실행이나 필요할 때만 데이터를 적재하는 작업에 적합합니다." />
      <div className="policy-section">
        <h3>실행 정책</h3>
        <label className="policy-check-row compact">
          <Checkbox defaultChecked />
          <span>
            <strong>실패 시 재시도 활성화</strong>
            <small>수동 실행 중 오류가 발생하면 지정한 정책에 따라 자동 재시도합니다.</small>
          </span>
        </label>
      </div>
      <RetryPolicy value={retryPolicy} onChange={onRetryPolicyChange} />
      <InfoBox title="자동 실행 예정 없음" body="저장 후 필요할 때 직접 실행할 수 있으며, 다음 실행 일시는 생성되지 않습니다." />
    </section>
  );
}

function OnceSettings({
  dateTime,
  onDateTimeChange,
  onDateTimeCommit,
  onRetryPolicyChange,
  retryPolicy,
}: {
  dateTime: string;
  onDateTimeChange: (dateTime: string) => void;
  onDateTimeCommit: () => void;
  onRetryPolicyChange: (policy: RetryPolicyDraft) => void;
  retryPolicy: RetryPolicyDraft;
}) {
  return (
    <section className="panel">
      <div className="panel-header">
        <Clock3 size={18} />
        <h2>1회 실행 상세 설정</h2>
      </div>
      <div className="form-grid">
        <label className="field">
          <span>실행 예정 일시</span>
          <Input className="input control-input" min="2026-07-04T00:00" type="datetime-local" value={normalizeDateTimeLocal(dateTime)} onBlur={onDateTimeCommit} onChange={(event) => onDateTimeChange(event.target.value)} onInput={(event) => onDateTimeChange(event.currentTarget.value)} />
        </label>
        <Field label="시간대" value="Asia/Seoul (GMT+09:00)" icon={<Clock3 size={16} />} />
      </div>
      <InfoBox title="실행 미리보기" body={`${formatDateTimeLocalLabel(dateTime)}에 한 번 실행됩니다. 실행 완료 후 반복되지 않습니다.`} />
      <div className="policy-section">
        <h3>실행 정책</h3>
        <label className="policy-check-row compact">
          <Checkbox defaultChecked />
          <span>
            <strong>실패 시 재시도</strong>
            <small>예약 실행 실패 시 재시도 정책을 적용합니다.</small>
          </span>
        </label>
      </div>
      <RetryPolicy value={retryPolicy} onChange={onRetryPolicyChange} />
    </section>
  );
}
