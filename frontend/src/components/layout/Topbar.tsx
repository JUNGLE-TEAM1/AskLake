import { useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Languages, Moon, type LucideIcon } from "lucide-react";

import { IconButton } from "@/components/ui/icon-button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type TopbarSection = {
  icon: LucideIcon;
  label: string;
};

const pageHeaderActionsId = "app-page-header-actions";

export function PageHeaderActions({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    setTarget(document.getElementById(pageHeaderActionsId));
  }, []);

  return target ? createPortal(children, target) : null;
}

export function Topbar({ section }: { section?: TopbarSection | null }) {
  if (!section) return null;

  const SectionIcon = section?.icon;

  return (
    <header className="topbar">
      <div className="topbar-section">
        <span aria-hidden="true" className="topbar-section-icon">
          <SectionIcon />
        </span>
        <h1>{section.label}</h1>
      </div>
      <div className="topbar-end">
        <TooltipProvider delayDuration={300}>
          <div aria-label="화면 설정" className="topbar-tools">
            <Tooltip>
              <TooltipTrigger asChild>
                <IconButton className="topbar-tool-button" label="다크 모드" size="sm" type="button">
                  <Moon aria-hidden="true" />
                </IconButton>
              </TooltipTrigger>
              <TooltipContent>다크 모드</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <IconButton className="topbar-tool-button" label="한국어·영어 전환" size="sm" type="button">
                  <Languages aria-hidden="true" />
                </IconButton>
              </TooltipTrigger>
              <TooltipContent>한국어·영어 전환</TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
        <div className="topbar-page-actions" id={pageHeaderActionsId} />
      </div>
    </header>
  );
}
