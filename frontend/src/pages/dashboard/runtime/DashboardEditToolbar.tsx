import type { ReactNode } from "react";
import { BarChart3, MousePointer2, Redo2, Type, Undo2 } from "lucide-react";
import askLakeNessiIconUrl from "../../../assets/asklake-nessi-icon.png";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ToolbarDraftWidgetKind } from "./dashboardRuntimeTypes";

function AskLakeNessiIcon({ size = 20 }: { size?: number }) {
  return <img alt="" aria-hidden="true" className="asklake-toolbar-nessi-icon" height={size} src={askLakeNessiIconUrl} width={size} />;
}

export function DashboardEditToolbar({
  assistantActive,
  canRedo,
  canUndo,
  disabled,
  onAssistant,
  onCreateToolbarWidget,
  onCursor,
  onRedo,
  onUndo,
}: {
  assistantActive: boolean;
  canRedo: boolean;
  canUndo: boolean;
  disabled: boolean;
  onAssistant: () => void;
  onCreateToolbarWidget: (kind: ToolbarDraftWidgetKind) => Promise<void> | void;
  onCursor: () => void;
  onRedo: () => void;
  onUndo: () => void;
}) {
  const actionButton = (
    label: string,
    icon: ReactNode,
    onClick: () => void,
    options: { disabled?: boolean } = {},
  ) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          disabled={options.disabled}
          data-icon=""
          size="icon"
          type="button"
          variant="ghost"
          onClick={onClick}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );

  return (
    <TooltipProvider delayDuration={250}>
      <div className="asklake-dashboard-edit-toolbar" role="toolbar" aria-label="대시보드 편집 도구">
        <ToggleGroup
          aria-label="편집 모드"
          type="single"
          value={assistantActive ? "assistant" : "cursor"}
          onValueChange={(value) => {
            if (value === "assistant") onAssistant();
            if (value === "cursor") onCursor();
          }}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <ToggleGroupItem
                aria-label="AskLake 보조 패널"
                className={assistantActive ? "asklake-toolbar-mode-active" : undefined}
                data-icon=""
                size="icon"
                value="assistant"
              >
                <AskLakeNessiIcon />
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent>AskLake 보조 패널</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <ToggleGroupItem
                aria-label="이동 모드"
                className={!assistantActive ? "asklake-toolbar-mode-active" : undefined}
                data-icon=""
                size="icon"
                value="cursor"
              >
                <MousePointer2 />
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent>이동 모드</TooltipContent>
          </Tooltip>
        </ToggleGroup>
        <span className="asklake-toolbar-divider" aria-hidden="true" />
        <ButtonGroup aria-label="위젯 추가">
          {actionButton("시각화 추가", <BarChart3 />, () => void onCreateToolbarWidget("visualization"), { disabled })}
          {actionButton("텍스트 추가", <Type />, () => void onCreateToolbarWidget("text"), { disabled })}
        </ButtonGroup>
        <span className="asklake-toolbar-divider" aria-hidden="true" />
        <ButtonGroup aria-label="편집 기록">
          {actionButton("실행 취소", <Undo2 />, onUndo, { disabled: !canUndo })}
          {actionButton("다시 실행", <Redo2 />, onRedo, { disabled: !canRedo })}
        </ButtonGroup>
      </div>
    </TooltipProvider>
  );
}
