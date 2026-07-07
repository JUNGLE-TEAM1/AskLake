import { useState } from "react";
import type React from "react";
import { Info } from "lucide-react";
import { retryFailureActionLabels } from "../../services/draftPipelineContract";
import type { RetryPolicyDraft } from "../../types";

export function PageTitle({ title, description, icon }: { title: string; description?: string; icon?: React.ReactNode }) {
  return (
    <header className="page-title">
      {icon}
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
    </header>
  );
}

export function Field({ label, value, icon, muted, wide }: { label: string; value: string; icon?: React.ReactNode; muted?: boolean; wide?: boolean }) {
  const compactValue = isCompactFieldValue(value);
  const inputClassName = [muted ? "input muted" : "input", compactValue ? "compact-value" : ""].filter(Boolean).join(" ");

  return (
    <label className={wide ? "field wide" : "field"}>
      <span>{label}</span>
      <div className={inputClassName} title={value}>
        <span className="input-value-text">{value}</span>
        {icon}
      </div>
    </label>
  );
}

function isCompactFieldValue(value: string) {
  const trimmed = value.trim();
  return value.length > 72 || trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.includes("json_path(");
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

const DEFAULT_RETRY_POLICY: RetryPolicyDraft = {
  backoffMultiplier: 2,
  backoffStrategy: "exponential",
  failureAction: "retry_then_fail",
  initialRetryDelayMinutes: 1,
  maxRetries: 3,
  maxRetryDelayMinutes: 30,
  retryIntervalMinutes: 1,
  timeoutMinutes: 60,
};

export function RetryPolicy({ onChange, value }: { onChange?: (policy: RetryPolicyDraft) => void; value?: RetryPolicyDraft }) {
  const retryPolicy: RetryPolicyDraft = {
    ...DEFAULT_RETRY_POLICY,
    ...(value ?? {}),
    backoffMultiplier: DEFAULT_RETRY_POLICY.backoffMultiplier,
    backoffStrategy: DEFAULT_RETRY_POLICY.backoffStrategy,
    initialRetryDelayMinutes: value?.initialRetryDelayMinutes ?? value?.retryIntervalMinutes ?? DEFAULT_RETRY_POLICY.initialRetryDelayMinutes,
    maxRetryDelayMinutes: value?.maxRetryDelayMinutes ?? DEFAULT_RETRY_POLICY.maxRetryDelayMinutes,
    retryIntervalMinutes: value?.retryIntervalMinutes ?? value?.initialRetryDelayMinutes ?? DEFAULT_RETRY_POLICY.retryIntervalMinutes,
    timeoutMinutes: DEFAULT_RETRY_POLICY.timeoutMinutes,
  };
  const updatePolicy = onChange ?? (() => {});
  const retryEnabled = retryPolicy.maxRetries > 0;
  const normalizeNumber = (value: string, fallback: string, min: number, max: number) => {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return fallback;
    return String(Math.min(Math.max(parsed, min), max));
  };
  const updateNumber = (key: "initialRetryDelayMinutes" | "maxRetries" | "maxRetryDelayMinutes" | "retryIntervalMinutes", nextValue: string, fallback: string, min: number, max: number) => {
    updatePolicy({ ...retryPolicy, [key]: Number(normalizeNumber(nextValue, fallback, min, max)) });
  };
  const updateInitialDelay = (nextValue: string) => {
    const nextDelay = Number(normalizeNumber(nextValue, "1", 1, 1440));
    updatePolicy({
      ...retryPolicy,
      initialRetryDelayMinutes: nextDelay,
      maxRetryDelayMinutes: Math.max(retryPolicy.maxRetryDelayMinutes, nextDelay),
      retryIntervalMinutes: nextDelay,
    });
  };
  const toggleRetry = () => {
    updatePolicy({
      ...retryPolicy,
      maxRetries: retryEnabled ? 0 : Math.max(DEFAULT_RETRY_POLICY.maxRetries, 1),
    });
  };
  const blockNumberControlText = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (["e", "E", "+", "-", "."].includes(event.key)) {
      event.preventDefault();
    }
  };

  return (
    <div className="retry-policy">
      <div className="retry-policy-group">
        <h3>실패 재시도</h3>
        <label className="policy-check-row compact">
          <input checked={retryEnabled} type="checkbox" onChange={toggleRetry} />
          <span>
            <strong>재시도 사용</strong>
            <small>{retryEnabled ? "짧게 먼저 재시도한 뒤 실패가 계속되면 2배씩 간격을 늘립니다." : "재시도 없이 최종 실패 처리만 적용합니다."}</small>
          </span>
        </label>
        <div className="form-grid compact">
          {retryEnabled && (
            <>
              <label className="field">
                <span>최대 재시도</span>
                <div className="input-with-unit">
                  <input
                    className="input control-input"
                    inputMode="numeric"
                    max="10"
                    min="0"
                    type="number"
                    value={retryPolicy.maxRetries}
                    onBlur={(event) => updateNumber("maxRetries", event.currentTarget.value, "3", 0, 10)}
                    onChange={(event) => updateNumber("maxRetries", event.target.value, "3", 0, 10)}
                    onInput={(event) => updateNumber("maxRetries", event.currentTarget.value, "3", 0, 10)}
                    onKeyDown={blockNumberControlText}
                  />
                  <span>회</span>
                </div>
              </label>
              <label className="field">
                <span>시작 지연</span>
                <div className="input-with-unit">
                  <input
                    className="input control-input"
                    inputMode="numeric"
                    max="1440"
                    min="1"
                    type="number"
                    value={retryPolicy.initialRetryDelayMinutes}
                    onBlur={(event) => updateInitialDelay(event.currentTarget.value)}
                    onChange={(event) => updateInitialDelay(event.target.value)}
                    onInput={(event) => updateInitialDelay(event.currentTarget.value)}
                    onKeyDown={blockNumberControlText}
                  />
                  <span>분</span>
                </div>
              </label>
              <label className="field">
                <span>최대 간격</span>
                <div className="input-with-unit">
                  <input
                    className="input control-input"
                    inputMode="numeric"
                    max="1440"
                    min={String(retryPolicy.initialRetryDelayMinutes)}
                    type="number"
                    value={retryPolicy.maxRetryDelayMinutes}
                    onBlur={(event) => updateNumber("maxRetryDelayMinutes", event.currentTarget.value, "30", retryPolicy.initialRetryDelayMinutes, 1440)}
                    onChange={(event) => updateNumber("maxRetryDelayMinutes", event.target.value, "30", retryPolicy.initialRetryDelayMinutes, 1440)}
                    onInput={(event) => updateNumber("maxRetryDelayMinutes", event.currentTarget.value, "30", retryPolicy.initialRetryDelayMinutes, 1440)}
                    onKeyDown={blockNumberControlText}
                  />
                  <span>분</span>
                </div>
              </label>
            </>
          )}
          <label className="field wide">
            <span>최종 실패 처리</span>
            <select className="input control-input" value={retryPolicy.failureAction} onChange={(event) => updatePolicy({ ...retryPolicy, failureAction: event.target.value as RetryPolicyDraft["failureAction"] })}>
              {Object.entries(retryFailureActionLabels).map(([optionValue, label]) => (
                <option key={optionValue} value={optionValue}>{label}</option>
              ))}
            </select>
          </label>
        </div>
      </div>
    </div>
  );
}
