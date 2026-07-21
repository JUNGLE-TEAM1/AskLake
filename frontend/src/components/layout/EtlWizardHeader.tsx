import { Check, ChevronDown, ChevronRight, LockKeyhole } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

type EtlWizardHeaderProps = {
  activeIndex: number;
  isStepDisabled: (stepIndex: number) => boolean;
  onBack: () => void;
  onStepSelect: (stepIndex: number) => void;
  steps: string[];
};

export function EtlWizardHeader({
  activeIndex,
  isStepDisabled,
  onBack,
  onStepSelect,
  steps,
}: EtlWizardHeaderProps) {
  const activeStep = steps[activeIndex] ?? steps[0] ?? "단계";

  return (
    <header className="etl-wizard-header">
      <nav aria-label="탐색 경로" className="etl-wizard-breadcrumb">
        <button className="etl-wizard-breadcrumb-link" onClick={onBack} type="button">
          수집/처리
        </button>
        <ChevronRight aria-hidden="true" size={14} />
        <span>새 수집/처리 생성</span>
        <ChevronRight aria-hidden="true" size={14} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label={`현재 단계: ${activeIndex + 1}. ${activeStep}. 단계 목록 열기`}
              className="etl-wizard-step-trigger"
              type="button"
            >
              <span>{activeIndex + 1}. {activeStep}</span>
              <span className="etl-wizard-step-count">{activeIndex + 1}/{steps.length}</span>
              <ChevronDown aria-hidden="true" size={14} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-64">
            <DropdownMenuLabel>수집/처리 생성 단계</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {steps.map((step, index) => {
              const active = index === activeIndex;
              const complete = index < activeIndex;
              const disabled = isStepDisabled(index);

              return (
                <DropdownMenuItem
                  aria-current={active ? "step" : undefined}
                  className={active ? "bg-blue-50 font-semibold text-blue-700 focus:bg-blue-50 focus:text-blue-700" : ""}
                  disabled={disabled}
                  key={`${index}-${step}`}
                  onSelect={() => onStepSelect(index)}
                >
                  <span aria-hidden="true" className="etl-wizard-step-status">
                    {complete ? <Check size={14} /> : disabled ? <LockKeyhole size={13} /> : index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{step}</span>
                  {active && <span className="etl-wizard-current-label">현재</span>}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>
    </header>
  );
}
