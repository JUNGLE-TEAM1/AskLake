import type React from "react";
import { Info } from "lucide-react";

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

export function RetryPolicy() {
  return (
    <div className="retry-policy">
      <h3>실패 처리 정책</h3>
      <div className="form-grid compact">
        <Field label="최대 재시도" value="3회" />
        <Field label="재시도 간격" value="10분" />
        <Field label="실행 제한 시간" value="60분" />
      </div>
    </div>
  );
}
