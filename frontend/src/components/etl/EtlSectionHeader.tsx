import { PanelHeader, type PanelHeaderProps } from "@/components/ui/panel";
import { cn } from "@/lib/utils";

export type EtlSectionHeaderTone = "default" | "success" | "warning" | "danger";

type EtlSectionHeaderProps = Omit<PanelHeaderProps, "iconClassName" | "iconVariant" | "size"> & {
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
  tone = "default",
  ...props
}: EtlSectionHeaderProps) {
  return (
    <PanelHeader
      className={cn(
        "etl-section-header min-h-[68px] px-5 py-3.5 [&_h2]:text-slate-950",
        headerToneClasses[tone],
        className,
      )}
      iconClassName={iconToneClasses[tone]}
      iconVariant={iconToneVariants[tone]}
      size="default"
      {...props}
    />
  );
}
