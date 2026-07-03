import { Check, CircleUser, RefreshCw, Search } from "lucide-react";
import { navItems, steps } from "../../data/mockData";
import type { NavId, NavItem } from "../../types";

export function Stepper({ activeIndex }: { activeIndex: number }) {
  return (
    <div className="stepper">
      <div className="stepper-inner">
        {steps.map((step, index) => {
          const complete = index < activeIndex;
          const active = index === activeIndex;
          return (
            <div className="stepper-item" key={step}>
              <span className={complete || active ? "step-dot active" : "step-dot"}>
                {complete ? <Check size={14} /> : index + 1}
              </span>
              <span className={active ? "step-label active" : "step-label"}>{step}</span>
              {index < steps.length - 1 && <span className={complete ? "step-line active" : "step-line"} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
