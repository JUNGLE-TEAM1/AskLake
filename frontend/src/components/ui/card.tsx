import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

export const cardVariants = cva(
  "rounded-lg border border-slate-200 bg-white text-slate-950",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "p-6",
        lg: "p-8",
        none: "p-0",
        sm: "p-4",
      },
      variant: {
        default: "shadow-sm",
        elevated: "shadow-md",
        interactive: "shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50",
        muted: "bg-slate-50 shadow-none",
      },
    },
  },
);

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, size, variant, ...props }, ref) => (
    <div
      className={cn(cardVariants({ className, size, variant }))}
      ref={ref}
      {...props}
    />
  ),
);
Card.displayName = "Card";

export const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div className={cn("grid gap-1.5", className)} ref={ref} {...props} />
  ),
);
CardHeader.displayName = "CardHeader";

export const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      className={cn("text-base font-semibold leading-none tracking-normal text-slate-950", className)}
      ref={ref}
      {...props}
    />
  ),
);
CardTitle.displayName = "CardTitle";

export const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p
      className={cn("text-sm leading-6 text-slate-500", className)}
      ref={ref}
      {...props}
    />
  ),
);
CardDescription.displayName = "CardDescription";

export const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div className={cn("pt-6", className)} ref={ref} {...props} />
  ),
);
CardContent.displayName = "CardContent";

export const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div className={cn("flex items-center gap-2 pt-6", className)} ref={ref} {...props} />
  ),
);
CardFooter.displayName = "CardFooter";
