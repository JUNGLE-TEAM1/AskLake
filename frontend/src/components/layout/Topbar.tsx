import { Languages, Moon } from "lucide-react";

import { IconButton } from "@/components/ui/icon-button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export function Topbar() {
  return (
    <header className="topbar">
      <TooltipProvider delayDuration={300}>
        <div className="topbar-actions">
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton className="topbar-action-button" label="다크 모드" size="sm" type="button">
                <Moon aria-hidden="true" />
              </IconButton>
            </TooltipTrigger>
            <TooltipContent>다크 모드</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton className="topbar-action-button" label="한국어·영어 전환" size="sm" type="button">
                <Languages aria-hidden="true" />
              </IconButton>
            </TooltipTrigger>
            <TooltipContent>한국어·영어 전환</TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>
    </header>
  );
}
