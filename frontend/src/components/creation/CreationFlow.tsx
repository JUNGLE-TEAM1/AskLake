import type React from "react";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CommandBar } from "@/components/ui/command-bar";
import { KeyValueList } from "@/components/ui/key-value-list";
import { summaryByFlow } from "../../data/appShellData";
import type { FlowId } from "../../types";
import { EtlWizardHeaderActionsPortal } from "../layout/EtlWizardHeaderActionsPortal";

export function CreationFlowLayout({
  actions,
  children,
  className,
  side,
  variant,
}: {
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  side?: React.ReactNode;
  variant?: "permission" | "review";
}) {
  const layoutClassName = ["content-grid", "creation-flow-grid", side ? "" : "creation-flow-grid-no-side", variant === "permission" ? "permission-grid" : "", variant === "review" ? "review-grid" : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      {actions && <EtlWizardHeaderActionsPortal>{actions}</EtlWizardHeaderActionsPortal>}
      <div className={layoutClassName}>
        <div className="content-main">
          {children}
        </div>
        {side ?? null}
      </div>
    </>
  );
}

export function CreationTopActions({
  nextDisabled,
  nextLabel = "다음",
  onNext,
  onPrev,
  prevLabel = "이전",
  showPrev = true,
  split = false,
}: {
  nextDisabled?: boolean;
  nextLabel?: string;
  onNext: () => void;
  onPrev: () => void;
  prevLabel?: string;
  showPrev?: boolean;
  split?: boolean;
}) {
  return (
    <CommandBar className={split ? "creation-top-actions is-split" : "creation-top-actions"} density="compact">
      {showPrev ? <Button className="secondary-button" type="button" variant="outline" onClick={onPrev}>{prevLabel}</Button> : null}
      <Button className="primary-button" type="button" disabled={nextDisabled} onClick={onNext}>{nextLabel}</Button>
    </CommandBar>
  );
}

export function CreationPanelActions({
  nextDisabled,
  nextLabel = "다음 단계로",
  prevLabel = "이전",
  saveLabel = "설정 저장",
  onNext,
  onPrev,
  onSave,
  withDivider,
}: {
  nextDisabled?: boolean;
  nextLabel?: string;
  prevLabel?: string;
  saveLabel?: string;
  onNext: () => void;
  onPrev: () => void;
  onSave: () => void;
  withDivider?: boolean;
}) {
  return (
    <CommandBar className={withDivider ? "summary-actions permission-actions" : "summary-actions"} density="compact">
      <Button className="secondary-button" type="button" variant="outline" onClick={onPrev}>{prevLabel}</Button>
      <Button className="secondary-button" type="button" variant="outline" onClick={onSave}>{saveLabel}</Button>
      <Button className="primary-button" type="button" disabled={nextDisabled} onClick={onNext}>{nextLabel}</Button>
    </CommandBar>
  );
}

export function CreationSummaryPanel({
  flow,
  hint = "저장하면 설정한 구성에 따라 파이프라인이 생성됩니다.",
  nextDisabled,
  nextLabel,
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
  nextDisabled?: boolean;
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
      <KeyValueList
        items={rows.map(([label, value]) => ({
          label,
          value: selected && label === "실행 방식" ? selected : value,
        }))}
      />
      <p className="summary-hint">{hint}</p>
      <CreationPanelActions
        nextDisabled={nextDisabled}
        nextLabel={nextLabel}
        prevLabel={prevLabel}
        saveLabel={saveLabel}
        onNext={onNext}
        onPrev={onPrev}
        onSave={onSave}
      />
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
