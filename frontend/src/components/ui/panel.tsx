import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

export const panelVariants = cva(
  "rounded-lg border border-slate-200 bg-white text-slate-950 shadow-[0_1px_2px_rgb(15_23_42_/_3%)]",
  {
    defaultVariants: {
      overflow: "hidden",
      variant: "default",
    },
    variants: {
      overflow: {
        hidden: "overflow-hidden",
        visible: "overflow-visible",
      },
      variant: {
        default: "",
        muted: "bg-slate-50",
        plain: "shadow-none",
      },
    },
  },
);

export interface PanelProps
  extends React.HTMLAttributes<HTMLElement>,
    VariantProps<typeof panelVariants> {
  asChild?: boolean;
}

export const Panel = React.forwardRef<HTMLElement, PanelProps>(
  ({ asChild = false, className, overflow, variant, ...props }, ref) => {
    const Comp = asChild ? Slot : "section";

    return (
      <Comp
        className={cn(panelVariants({ className, overflow, variant }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Panel.displayName = "Panel";

const panelHeaderIconVariants = cva(
  "inline-grid size-11 shrink-0 place-items-center rounded-lg [&_svg]:size-[22px]",
  {
    defaultVariants: {
      variant: "default",
    },
    variants: {
      variant: {
        default: "bg-blue-50 text-blue-600",
        neutral: "bg-slate-100 text-slate-600",
        success: "bg-emerald-50 text-emerald-600",
        warning: "bg-amber-50 text-amber-600",
      },
    },
  },
);

export interface PanelHeaderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  actions?: React.ReactNode;
  bordered?: boolean;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  iconClassName?: string;
  iconVariant?: VariantProps<typeof panelHeaderIconVariants>["variant"];
  meta?: React.ReactNode;
  title: React.ReactNode;
}

export const PanelHeader = React.forwardRef<HTMLDivElement, PanelHeaderProps>(
  (
    {
      actions,
      bordered = true,
      className,
      description,
      icon,
      iconClassName,
      iconVariant,
      meta,
      title,
      ...props
    },
    ref,
  ) => (
    <div
      className={cn(
        "grid min-h-[72px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 bg-white px-5 py-4",
        bordered && "border-b border-slate-200",
        className,
      )}
      ref={ref}
      {...props}
    >
      {icon ? (
        <span className={cn(panelHeaderIconVariants({ variant: iconVariant }), iconClassName)}>
          {icon}
        </span>
      ) : null}
      <div className="grid min-w-0 gap-0.5">
        <h2 className="m-0 text-xl font-[850] leading-tight tracking-normal text-slate-900 [overflow-wrap:anywhere]">
          {title}
        </h2>
        {description ? (
          <p className="m-0 text-sm font-bold leading-snug tracking-normal text-slate-500 [overflow-wrap:anywhere]">
            {description}
          </p>
        ) : null}
      </div>
      {meta || actions ? (
        <div className="inline-flex min-w-0 items-center justify-end gap-2">
          {meta}
          {actions}
        </div>
      ) : null}
    </div>
  ),
);
PanelHeader.displayName = "PanelHeader";
