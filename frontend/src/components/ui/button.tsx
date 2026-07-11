import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-semibold tracking-normal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    defaultVariants: {
      shape: "default",
      size: "default",
      variant: "primary",
    },
    variants: {
      shape: {
        compact: "rounded-md",
        default: "rounded-lg",
      },
      size: {
        content: "h-auto",
        default: "h-10 px-4 py-2",
        icon: "size-10",
        iconSm: "size-8",
        lg: "h-11 px-5",
        sm: "h-9 px-3 text-xs",
      },
      variant: {
        destructive: "bg-red-600 text-white shadow-sm hover:bg-red-700",
        ghost: "text-slate-700 hover:bg-slate-100 hover:text-slate-950",
        link: "h-auto px-0 py-0 text-blue-700 underline-offset-4 hover:underline",
        outline: "border border-slate-200 bg-white text-slate-900 shadow-sm hover:bg-slate-50",
        primary: "bg-blue-600 text-white shadow-sm hover:bg-blue-700",
        secondary: "bg-slate-100 text-slate-900 hover:bg-slate-200",
        subtle: "bg-blue-50 text-blue-700 hover:bg-blue-100",
      },
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ asChild = false, className, shape, size, variant, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";

    return (
      <Comp
        className={cn(buttonVariants({ className, shape, size, variant }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
