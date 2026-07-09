import type React from "react";

import { DialogShell, type DialogShellProps } from "@/components/ui/dialog-shell";
import { cn } from "@/lib/utils";

export interface PickerDialogProps
  extends Pick<
    DialogShellProps,
    "bodyClassName" | "contentClassName" | "footerClassName" | "headerClassName"
  > {
  children: React.ReactNode;
  description?: React.ReactNode;
  error?: React.ReactNode;
  footer: React.ReactNode;
  onClose: () => void;
  title: React.ReactNode;
  toolbar?: React.ReactNode;
}

export function PickerDialog({
  bodyClassName,
  children,
  contentClassName,
  description,
  error,
  footer,
  footerClassName,
  headerClassName,
  onClose,
  title,
  toolbar,
}: PickerDialogProps) {
  return (
    <DialogShell
      bodyClassName={cn("contents", bodyClassName)}
      closeLabel="선택 창 닫기"
      contentClassName={cn("w-[min(calc(100vw-2rem),61rem)]", contentClassName)}
      description={description}
      footer={footer}
      footerClassName={footerClassName}
      headerClassName={headerClassName}
      onClose={onClose}
      size="xl"
      title={title}
    >
      {toolbar}
      {error}
      {children}
    </DialogShell>
  );
}
