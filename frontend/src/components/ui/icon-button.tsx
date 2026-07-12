import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const iconButtonVariants = cva("", {
  defaultVariants: {
    size: "default",
    variant: "ghost",
  },
  variants: {
    size: {
      default: "size-10",
      lg: "size-11",
      sm: "size-9",
      xs: "size-8 [&_svg]:size-3.5",
    },
    variant: {
      destructive: "",
      ghost: "",
      outline: "",
      primary: "",
      secondary: "",
      subtle: "",
    },
  },
});

export interface IconButtonProps
  extends Omit<ButtonProps, "children" | "size" | "variant">,
    VariantProps<typeof iconButtonVariants> {
  children: React.ReactNode;
  label: string;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ children, className, label, size, title, variant = "ghost", ...props }, ref) => (
    <Button
      aria-label={label}
      className={cn(iconButtonVariants({ size, variant }), className)}
      ref={ref}
      size="icon"
      title={title ?? label}
      variant={variant}
      {...props}
    >
      {children}
    </Button>
  ),
);
IconButton.displayName = "IconButton";
