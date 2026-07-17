import { Check } from "lucide-react";
import { steps as defaultSteps } from "../../data/appShellData";

type StepperProps = {
  activeIndex: number;
  isStepDisabled?: (stepIndex: number) => boolean;
  onStepSelect?: (stepIndex: number) => void;
  steps?: string[];
};

export function Stepper({ activeIndex, isStepDisabled, onStepSelect, steps = defaultSteps }: StepperProps) {
  return (
    <div className="stepper">
      <div className="stepper-inner">
        {steps.map((step, index) => {
          const complete = index < activeIndex;
          const active = index === activeIndex;
          const disabled = isStepDisabled?.(index) ?? false;
          const stepTriggerClassName = ["step-trigger", complete ? "complete" : "", active ? "active" : "", disabled ? "disabled" : ""].filter(Boolean).join(" ");
          return (
            <div className="stepper-item" key={step}>
              <button
                aria-current={active ? "step" : undefined}
                aria-label={disabled ? `${step} 단계 잠김` : `${step} 단계로 이동`}
                className={stepTriggerClassName}
                disabled={disabled}
                onClick={() => onStepSelect?.(index)}
                type="button"
              >
                <span className={complete || active ? "step-dot active" : "step-dot"}>
                  {complete ? <Check size={14} /> : index + 1}
                </span>
                <span className={active ? "step-label active" : "step-label"}>{step}</span>
              </button>
              {index < steps.length - 1 && <span className={complete ? "step-line active" : "step-line"} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
