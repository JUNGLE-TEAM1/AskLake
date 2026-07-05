import type React from "react";
import { FileText } from "lucide-react";
import { summaryByFlow } from "../../data/mockData";
import type { FlowId } from "../../types";

export function CreationFlowLayout({
  children,
  side,
  variant,
}: {
  children: React.ReactNode;
  side: React.ReactNode;
  variant?: "permission" | "review";
}) {
  const className = ["content-grid", "creation-flow-grid", variant === "permission" ? "permission-grid" : "", variant === "review" ? "review-grid" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={className}>
      <div className="content-main">{children}</div>
      {side}
    </div>
  );
}

export function CreationPanelActions({
  nextLabel = "다음 단계로",
  prevLabel = "이전",
  saveLabel = "설정 저장",
  onNext,
  onPrev,
  onSave,
  withDivider,
}: {
  nextLabel?: string;
  prevLabel?: string;
  saveLabel?: string;
  onNext: () => void;
  onPrev: () => void;
  onSave: () => void;
  withDivider?: boolean;
}) {
  return (
    <div className={withDivider ? "summary-actions permission-actions" : "summary-actions"}>
      <button className="secondary-button" type="button" onClick={onPrev}>{prevLabel}</button>
      <button className="secondary-button" type="button" onClick={onSave}>{saveLabel}</button>
      <button className="primary-button" type="button" onClick={onNext}>{nextLabel}</button>
    </div>
  );
}

export function CreationSummaryPanel({
  flow,
  hint = "저장하면 설정한 구성에 따라 파이프라인이 생성됩니다.",
  nextLabel = "다음 단계로",
  onNext,
  onPrev,
  onSave,
  prevLabel,
  saveLabel,
  selected,
  summaryRows,
  title,
}: {
  flow: FlowId;
  hint?: string;
  nextLabel?: string;
  onNext: () => void;
  onPrev: () => void;
  onSave: () => void;
  prevLabel?: string;
  saveLabel?: string;
  selected?: string;
  summaryRows?: Array<[string, string]>;
  title: string;
}) {
  const rows = summaryRows ?? summaryByFlow[flow];
  return (
    <aside className="summary-panel">
      <div className="summary-header">
        <FileText size={18} />
        <h2>{title}</h2>
      </div>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{selected && label === "실행 방식" ? selected : value}</dd>
          </div>
        ))}
      </dl>
      <p className="summary-hint">{hint}</p>
      <CreationPanelActions nextLabel={nextLabel} prevLabel={prevLabel} saveLabel={saveLabel} onNext={onNext} onPrev={onPrev} onSave={onSave} />
    </aside>
  );
}

export function CreationValidationPanel({
  actions,
  children,
  className,
  title,
}: {
  actions: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  title: string;
}) {
  return (
    <aside className={className ? `validation-panel ${className}` : "validation-panel"}>
      <h2>{title}</h2>
      {children}
      {actions}
    </aside>
  );
}
