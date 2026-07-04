import { useState } from "react";
import type React from "react";
import { Info } from "lucide-react";
import { retryFailureActionLabels } from "../../services/draftPipelineContract";
import type { RetryPolicyDraft } from "../../types";

export function PageTitle({ title, description, icon }: { title: string; description: string; icon?: React.ReactNode }) {
  return (
    <header className="page-title">
      {icon}
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
    </header>
  );
}

export function Field({ label, value, icon, muted, wide }: { label: string; value: string; icon?: React.ReactNode; muted?: boolean; wide?: boolean }) {
  return (
    <label className={wide ? "field wide" : "field"}>
      <span>{label}</span>
      <div className={muted ? "input muted" : "input"}>
        {value}
        {icon}
      </div>
    </label>
  );
}

export function InfoBox({ title, body }: { title: string; body: string }) {
  return (
    <div className="info-box">
      <Info size={18} />
      <div>
        <strong>{title}</strong>
        <p>{body}</p>
      </div>
    </div>
  );
}

export function StatusTile({ label, value, status }: { label: string; value: string; status: string }) {
  return (
    <article className="status-tile">
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{status}</em>
    </article>
  );
}

export function RetryPolicy({ onChange, value }: { onChange: (policy: RetryPolicyDraft) => void; value: RetryPolicyDraft }) {
  const normalizeNumber = (value: string, fallback: string, min: number, max: number) => {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return fallback;
    return String(Math.min(Math.max(parsed, min), max));
  };
  const updateNumber = (key: "maxRetries" | "retryIntervalMinutes" | "timeoutMinutes", nextValue: string, fallback: string, min: number, max: number) => {
    onChange({ ...value, [key]: Number(normalizeNumber(nextValue, fallback, min, max)) });
  };
  const blockNumberControlText = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (["e", "E", "+", "-", "."].includes(event.key)) {
      event.preventDefault();
    }
  };

  return (
    <div className="retry-policy">
      <h3>실패 처리 정책</h3>
      <div className="form-grid compact">
        <label className="field">
          <span>최대 재시도</span>
          <div className="input-with-unit">
            <input
              className="input control-input"
              inputMode="numeric"
              max="10"
              min="0"
              type="number"
              value={value.maxRetries}
              onBlur={(event) => updateNumber("maxRetries", event.currentTarget.value, "3", 0, 10)}
              onChange={(event) => updateNumber("maxRetries", event.target.value, "3", 0, 10)}
              onInput={(event) => updateNumber("maxRetries", event.currentTarget.value, "3", 0, 10)}
              onKeyDown={blockNumberControlText}
            />
            <span>회</span>
          </div>
        </label>
        <label className="field">
          <span>재시도 간격</span>
          <div className="input-with-unit">
            <input
              className="input control-input"
              inputMode="numeric"
              max="1440"
              min="1"
              type="number"
              value={value.retryIntervalMinutes}
              onBlur={(event) => updateNumber("retryIntervalMinutes", event.currentTarget.value, "10", 1, 1440)}
              onChange={(event) => updateNumber("retryIntervalMinutes", event.target.value, "10", 1, 1440)}
              onInput={(event) => updateNumber("retryIntervalMinutes", event.currentTarget.value, "10", 1, 1440)}
              onKeyDown={blockNumberControlText}
            />
            <span>분</span>
          </div>
        </label>
        <label className="field">
          <span>실행 제한 시간</span>
          <div className="input-with-unit">
            <input
              className="input control-input"
              inputMode="numeric"
              max="1440"
              min="1"
              type="number"
              value={value.timeoutMinutes}
              onBlur={(event) => updateNumber("timeoutMinutes", event.currentTarget.value, "60", 1, 1440)}
              onChange={(event) => updateNumber("timeoutMinutes", event.target.value, "60", 1, 1440)}
              onInput={(event) => updateNumber("timeoutMinutes", event.currentTarget.value, "60", 1, 1440)}
              onKeyDown={blockNumberControlText}
            />
            <span>분</span>
          </div>
        </label>
        <label className="field wide">
          <span>최종 실패 처리</span>
          <select className="input control-input" value={value.failureAction} onChange={(event) => onChange({ ...value, failureAction: event.target.value as RetryPolicyDraft["failureAction"] })}>
            {Object.entries(retryFailureActionLabels).map(([optionValue, label]) => (
              <option key={optionValue} value={optionValue}>{label}</option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
