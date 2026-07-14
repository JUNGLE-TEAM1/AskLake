import type { ReactNode } from "react";

import { PanelHeader } from "@/components/ui/panel";
import { cn } from "@/lib/utils";

type EtlStepHeaderProps = {
  className?: string;
  description?: ReactNode;
  icon: ReactNode;
  title: ReactNode;
};

export function EtlStepHeader({ className, description, icon, title }: EtlStepHeaderProps) {
  return (
    <PanelHeader
      className={cn("etl-step-header min-h-[68px] px-5 py-3.5", className)}
      description={description}
      icon={icon}
      iconClassName="border border-slate-200 bg-white text-blue-700 shadow-sm"
      title={title}
    />
  );
}
