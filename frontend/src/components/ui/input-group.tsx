import * as React from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { Input, type InputProps } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export const InputGroup = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    className={cn(
      "flex min-h-10 w-full min-w-0 items-center overflow-hidden rounded-lg border border-slate-200 bg-white text-slate-950 shadow-sm transition-colors focus-within:ring-2 focus-within:ring-blue-500 focus-within:ring-offset-2",
      className,
    )}
    ref={ref}
    {...props}
  />
));
InputGroup.displayName = "InputGroup";

export const InputGroupInput = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...props }, ref) => (
    <Input
      className={cn("h-9 flex-1 border-0 bg-transparent shadow-none focus-visible:ring-0 focus-visible:ring-offset-0", className)}
      ref={ref}
      {...props}
    />
  ),
);
InputGroupInput.displayName = "InputGroupInput";

export const InputGroupAddon = React.forwardRef<
  HTMLSpanElement,
  React.HTMLAttributes<HTMLSpanElement>
>(({ className, ...props }, ref) => (
  <span
    className={cn("inline-flex h-9 shrink-0 items-center gap-2 px-3 text-sm text-slate-500", className)}
    ref={ref}
    {...props}
  />
));
InputGroupAddon.displayName = "InputGroupAddon";

export const InputGroupText = React.forwardRef<
  HTMLSpanElement,
  React.HTMLAttributes<HTMLSpanElement>
>(({ className, ...props }, ref) => (
  <span className={cn("truncate text-sm text-slate-500", className)} ref={ref} {...props} />
));
InputGroupText.displayName = "InputGroupText";

export interface InputGroupButtonProps extends ButtonProps {}

export const InputGroupButton = React.forwardRef<HTMLButtonElement, InputGroupButtonProps>(
  ({ className, size = "sm", variant = "ghost", ...props }, ref) => (
    <Button
      className={cn("mx-1 h-8 shrink-0", className)}
      ref={ref}
      size={size}
      variant={variant}
      {...props}
    />
  ),
);
InputGroupButton.displayName = "InputGroupButton";

