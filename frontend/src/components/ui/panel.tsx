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
  "inline-grid shrink-0 place-items-center rounded-lg",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "size-11 [&_svg]:size-[22px]",
        section: "size-11 [&_svg]:size-[22px]",
      },
      variant: {
        default: "bg-blue-50 text-blue-600",
        neutral: "bg-slate-100 text-slate-600",
        outline: "border border-blue-100 bg-white text-blue-700 shadow-sm",
        success: "bg-emerald-50 text-emerald-600",
        warning: "bg-amber-50 text-amber-600",
      },
    },
  },
);

const panelHeaderVariants = cva(
  "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 bg-white",
  {
    defaultVariants: {
      size: "default",
    },
    variants: {
      size: {
        default: "min-h-[72px] px-5 py-4",
        section: "min-h-[52px] px-4 py-2.5",
      },
    },
  },
);

const panelHeaderTitleVariants = cva(
  "m-0 font-semibold leading-tight tracking-normal text-slate-900 [overflow-wrap:anywhere]",
  {
    defaultVariants: {
      size: "default",
    },
    variants: {
      size: {
        default: "text-xl",
        section: "text-base",
      },
    },
  },
);

const panelHeaderDescriptionVariants = cva(
  "m-0 font-normal leading-snug tracking-normal text-slate-500 [overflow-wrap:anywhere]",
  {
    defaultVariants: {
      size: "default",
    },
    variants: {
      size: {
        default: "text-sm",
        section: "text-xs",
      },
    },
  },
);

export interface PanelHeaderProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title">,
    VariantProps<typeof panelHeaderVariants> {
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
      size,
      title,
      ...props
    },
    ref,
  ) => (
    <div
      className={cn(
        panelHeaderVariants({ size }),
        bordered && "border-b border-slate-200",
        className,
      )}
      ref={ref}
      {...props}
    >
      {icon ? (
        <span className={cn(panelHeaderIconVariants({ size, variant: iconVariant }), iconClassName)}>
          {icon}
        </span>
      ) : null}
      <div className="grid min-w-0 gap-0.5">
        <h2 className={panelHeaderTitleVariants({ size })} data-slot="panel-title">
          {title}
        </h2>
        {description ? (
          <p className={panelHeaderDescriptionVariants({ size })} data-slot="panel-description">
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
