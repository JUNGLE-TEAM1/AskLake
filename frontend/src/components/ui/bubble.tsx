import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "@radix-ui/react-slot"

import { cn } from "@/lib/utils"

function BubbleGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="bubble-group"
      className={cn("flex min-w-0 flex-col gap-2", className)}
      {...props}
    />
  )
}

const bubbleVariants = cva(
  "group/bubble relative flex w-fit max-w-[80%] min-w-0 flex-col gap-1 group-data-[align=end]/message:self-end data-[align=end]:self-end data-[variant=ghost]:max-w-full",
  {
    variants: {
      variant: {
        default:
          "*:data-[slot=bubble-content]:bg-blue-600 *:data-[slot=bubble-content]:text-white [&>[data-slot=bubble-content]:is(button,a):hover]:bg-blue-700",
        secondary:
          "*:data-[slot=bubble-content]:border-slate-200 *:data-[slot=bubble-content]:bg-white *:data-[slot=bubble-content]:text-slate-900 *:data-[slot=bubble-content]:shadow-sm [&>[data-slot=bubble-content]:is(button,a):hover]:bg-slate-50",
        muted:
          "*:data-[slot=bubble-content]:bg-slate-100 *:data-[slot=bubble-content]:text-slate-700 [&>[data-slot=bubble-content]:is(button,a):hover]:bg-slate-200",
        tinted:
          "*:data-[slot=bubble-content]:bg-blue-50 *:data-[slot=bubble-content]:text-blue-950 [&>[data-slot=bubble-content]:is(button,a):hover]:bg-blue-100",
        outline:
          "*:data-[slot=bubble-content]:border-slate-200 *:data-[slot=bubble-content]:bg-white *:data-[slot=bubble-content]:text-slate-900 [&>[data-slot=bubble-content]:is(button,a):hover]:bg-slate-50",
        ghost:
          "border-none *:data-[slot=bubble-content]:rounded-none *:data-[slot=bubble-content]:bg-transparent *:data-[slot=bubble-content]:p-0 *:data-[slot=bubble-content]:text-slate-900 [&>[data-slot=bubble-content]:is(button,a):hover]:bg-slate-100",
        destructive:
          "*:data-[slot=bubble-content]:border-red-200 *:data-[slot=bubble-content]:bg-red-50 *:data-[slot=bubble-content]:text-red-700 [&>[data-slot=bubble-content]:is(button,a):hover]:bg-red-100",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Bubble({
  variant = "default",
  align = "start",
  className,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof bubbleVariants> & {
    align?: "start" | "end"
  }) {
  return (
    <div
      data-slot="bubble"
      data-variant={variant}
      data-align={align}
      className={cn(bubbleVariants({ variant }), className)}
      {...props}
    />
  )
}

function BubbleContent({
  asChild = false,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  asChild?: boolean
}) {
  const Comp = asChild ? Slot : "div"

  return (
    <Comp
      data-slot="bubble-content"
      className={cn(
        "w-fit max-w-full min-w-0 overflow-hidden rounded-xl border border-transparent px-3 py-2 text-sm leading-relaxed wrap-break-word group-data-[align=end]/bubble:self-end [button]:text-left [button,a]:transition-colors [button,a]:outline-none [button,a]:focus-visible:border-blue-500 [button,a]:focus-visible:ring-3 [button,a]:focus-visible:ring-blue-500/30",
        className
      )}
      {...props}
    />
  )
}

const bubbleReactionsVariants = cva(
  "absolute z-10 flex w-fit shrink-0 items-center justify-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-sm text-slate-900 ring-3 ring-white has-[button]:p-0",
  {
    variants: {
      side: {
        top: "top-0 -translate-y-3/4",
        bottom: "bottom-0 translate-y-3/4",
      },
      align: {
        start: "left-3",
        end: "right-3",
      },
    },
    defaultVariants: {
      side: "bottom",
      align: "end",
    },
  }
)

function BubbleReactions({
  side = "bottom",
  align = "end",
  className,
  ...props
}: React.ComponentProps<"div"> & {
  align?: "start" | "end"
  side?: "top" | "bottom"
}) {
  return (
    <div
      data-slot="bubble-reactions"
      data-align={align}
      data-side={side}
      className={cn(bubbleReactionsVariants({ side, align }), className)}
      {...props}
    />
  )
}

export { BubbleGroup, Bubble, BubbleContent, BubbleReactions }
