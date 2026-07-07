import { Check } from "lucide-react";
import { steps } from "../../data/appShellData";

type StepperProps = {
  activeIndex: number;
  onStepSelect?: (stepIndex: number) => void;
};

export function Stepper({ activeIndex, onStepSelect }: StepperProps) {
  return (
    <div className="stepper">
      <div className="stepper-inner">
        {steps.map((step, index) => {
          const complete = index < activeIndex;
          const active = index === activeIndex;
          const stepTriggerClassName = ["step-trigger", complete ? "complete" : "", active ? "active" : ""].filter(Boolean).join(" ");
          return (
            <div className="stepper-item" key={step}>
              <button
                aria-current={active ? "step" : undefined}
                aria-label={`${step} 단계로 이동`}
                className={stepTriggerClassName}
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
