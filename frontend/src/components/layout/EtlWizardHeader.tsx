import { ChevronRight } from "lucide-react";

import { Stepper } from "./Stepper";

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
  return (
    <header className="etl-wizard-header">
      <nav aria-label="탐색 경로" className="etl-wizard-breadcrumb">
        <button className="etl-wizard-breadcrumb-link" onClick={onBack} type="button">
          수집/처리
        </button>
        <ChevronRight aria-hidden="true" size={14} />
        <span aria-current="page">새 데이터 소스 생성</span>
      </nav>
      <Stepper
        activeIndex={activeIndex}
        density="compact"
        isStepDisabled={isStepDisabled}
        onStepSelect={onStepSelect}
        steps={steps}
      />
    </header>
  );
}
