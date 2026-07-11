import * as React from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

type DialogShellSize = "sm" | "md" | "lg" | "xl" | "wide" | "fullscreen";

const dialogShellSizeClassName: Record<DialogShellSize, string> = {
  fullscreen: "h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-none",
  lg: "w-[min(calc(100vw-2rem),48rem)]",
  md: "w-[min(calc(100vw-2rem),36rem)]",
  sm: "w-[min(calc(100vw-2rem),28rem)]",
  wide: "w-[min(calc(100vw-2rem),73.75rem)]",
  xl: "w-[min(calc(100vw-2rem),64rem)]",
};

export interface DialogShellProps {
  "aria-label"?: string;
  bodyClassName?: string;
  bodyScrollArea?: boolean;
  children: React.ReactNode;
  closeLabel?: string;
  contentClassName?: string;
  description?: React.ReactNode;
  eyebrow?: React.ReactNode;
  footer?: React.ReactNode;
  footerClassName?: string;
  headerActions?: React.ReactNode;
  headerClassName?: string;
  onClose?: () => void;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  showCloseButton?: boolean;
  size?: DialogShellSize;
  title: React.ReactNode;
  titleClassName?: string;
}

export function DialogShell({
  "aria-label": ariaLabel,
  bodyClassName,
  bodyScrollArea = false,
  children,
  closeLabel = "닫기",
  contentClassName,
  description,
  eyebrow,
  footer,
  footerClassName,
  headerActions,
  headerClassName,
  onClose,
  onOpenChange,
  open = true,
  showCloseButton = true,
  size = "md",
  title,
  titleClassName,
}: DialogShellProps) {
  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange?.(nextOpen);
    if (!nextOpen) onClose?.();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        aria-label={ariaLabel}
        className={cn(
          "max-h-[calc(100vh-2rem)] gap-0 overflow-hidden p-0",
          dialogShellSizeClassName[size],
          contentClassName,
        )}
        closeLabel={closeLabel}
        showCloseButton={showCloseButton && !headerActions}
      >
        <header
          className={cn(
            "flex min-w-0 items-start justify-between gap-4 border-b border-slate-200 px-6 py-5",
            headerClassName,
          )}
        >
          <div className="grid min-w-0 gap-1.5">
            {eyebrow ? (
              <span className="text-xs font-black uppercase tracking-normal text-blue-600">
                {eyebrow}
              </span>
            ) : null}
            <DialogTitle className={cn("leading-tight", titleClassName)}>
              {title}
            </DialogTitle>
            {description ? (
              <DialogDescription>{description}</DialogDescription>
            ) : null}
          </div>
          {headerActions ? (
            <div className="inline-flex shrink-0 items-center gap-2">
              {headerActions}
            </div>
          ) : null}
        </header>
        {bodyScrollArea ? (
          <ScrollArea className={cn("min-h-0 px-6 py-5", bodyClassName)}>
            {children}
          </ScrollArea>
        ) : (
          <div className={cn("min-h-0 overflow-y-auto px-6 py-5", bodyClassName)}>
            {children}
          </div>
        )}
        {footer ? (
          <footer
            className={cn(
              "flex min-w-0 items-center justify-end gap-2 border-t border-slate-200 px-6 py-4",
              footerClassName,
            )}
          >
            {footer}
          </footer>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
