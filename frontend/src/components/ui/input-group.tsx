import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

export const inputGroupVariants = cva(
  "flex w-full items-center overflow-hidden rounded-lg border bg-white text-slate-950 shadow-sm transition-colors focus-within:ring-2 focus-within:ring-blue-500 focus-within:ring-offset-2",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "min-h-10 text-sm",
        lg: "min-h-11 text-base",
        sm: "min-h-9 text-sm",
      },
      variant: {
        default: "border-slate-200",
        error: "border-red-300 focus-within:ring-red-500",
        ghost: "border-transparent bg-slate-50 shadow-none",
      },
    },
  },
);

export interface InputGroupProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof inputGroupVariants> {}

export const InputGroup = React.forwardRef<HTMLDivElement, InputGroupProps>(
  ({ className, size, variant, ...props }, ref) => (
    <div className={cn(inputGroupVariants({ className, size, variant }))} ref={ref} {...props} />
  ),
);
InputGroup.displayName = "InputGroup";

export const InputGroupAddon = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => (
    <span
      className={cn("inline-flex shrink-0 items-center gap-2 px-3 text-slate-500 [&_svg]:size-4", className)}
      ref={ref}
      {...props}
    />
  ),
);
InputGroupAddon.displayName = "InputGroupAddon";

export const InputGroupInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      className={cn(
        "min-w-0 flex-1 border-0 bg-transparent px-0 py-2 text-sm outline-none placeholder:text-slate-400 disabled:cursor-not-allowed disabled:text-slate-500",
        className,
      )}
      ref={ref}
      type={type}
      {...props}
    />
  ),
);
InputGroupInput.displayName = "InputGroupInput";

export const InputGroupText = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => (
    <span className={cn("text-sm text-slate-500", className)} ref={ref} {...props} />
  ),
);
InputGroupText.displayName = "InputGroupText";

export const InputGroupButton = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ className, type = "button", ...props }, ref) => (
    <button
      className={cn(
        "inline-flex min-h-8 shrink-0 items-center justify-center gap-2 rounded-md px-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4",
        className,
      )}
      ref={ref}
      type={type}
      {...props}
    />
  ),
);
InputGroupButton.displayName = "InputGroupButton";
