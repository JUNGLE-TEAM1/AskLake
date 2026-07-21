import type { ReactNode } from "react";
import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

export const ETL_WIZARD_HEADER_ACTIONS_ID = "etl-wizard-header-actions";

export function EtlWizardHeaderActionsPortal({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    setTarget(document.getElementById(ETL_WIZARD_HEADER_ACTIONS_ID));
    return () => setTarget(null);
  }, []);

  return target ? createPortal(children, target) : null;
}
