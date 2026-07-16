import { PanelHeader, type PanelHeaderProps } from "@/components/ui/panel";
import { cn } from "@/lib/utils";

export type EtlSectionHeaderTone = "default" | "success" | "warning" | "danger";

type EtlSectionHeaderProps = Omit<PanelHeaderProps, "iconClassName" | "iconVariant" | "size"> & {
  density?: "default" | "compact";
  tone?: EtlSectionHeaderTone;
};

const headerToneClasses: Record<EtlSectionHeaderTone, string> = {
  danger: "border-red-200 bg-red-50/50",
  default: "border-blue-200 bg-blue-50/50",
  success: "border-emerald-200 bg-emerald-50/50",
  warning: "border-amber-200 bg-amber-50/50",
};

const iconToneClasses: Record<EtlSectionHeaderTone, string> = {
  danger: "bg-red-100 text-red-600",
  default: "bg-blue-100 text-blue-600",
  success: "bg-emerald-100 text-emerald-600",
  warning: "bg-amber-100 text-amber-600",
};

const iconToneVariants: Record<EtlSectionHeaderTone, PanelHeaderProps["iconVariant"]> = {
  danger: "neutral",
  default: "default",
  success: "success",
  warning: "warning",
};

export function EtlSectionHeader({
  className,
  density = "default",
  tone = "default",
  ...props
}: EtlSectionHeaderProps) {
  const compact = density === "compact";

  return (
    <PanelHeader
      className={cn(
        "etl-section-header [&_h2]:text-slate-950",
        compact ? "min-h-14 px-4 py-3" : "min-h-[68px] px-5 py-3.5",
        headerToneClasses[tone],
        className,
      )}
      iconClassName={cn(
        iconToneClasses[tone],
        compact && "size-9 rounded-md [&_svg]:size-[18px]",
      )}
      iconVariant={iconToneVariants[tone]}
      size={compact ? "section" : "default"}
      {...props}
    />
  );
}
