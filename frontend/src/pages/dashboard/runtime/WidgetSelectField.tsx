import {
  Children,
  isValidElement,
  type ChangeEvent,
  type ReactNode,
} from "react";
import type { NativeSelectFieldProps } from "@/components/ui/form-field-group";
import { cn } from "@/lib/utils";
import { DashboardFieldCombobox, type DashboardComboboxOption } from "./DashboardFieldCombobox";

export function WidgetSelectField({
  children,
  onChange,
  selectClassName,
  value,
  ...props
}: Omit<NativeSelectFieldProps, "children" | "onChange" | "value"> & {
  children: ReactNode;
  onChange?: (event: ChangeEvent<HTMLSelectElement>) => void;
  value: string;
}) {
  const options = Children.toArray(children).flatMap((child): DashboardComboboxOption[] => {
    if (!isValidElement<{ children?: ReactNode; value?: string }>(child) || child.type !== "option") return [];
    const label = typeof child.props.children === "string" ? child.props.children : String(child.props.value ?? "");
    return [{ label, value: child.props.value ?? label }];
  });
  return (
    <DashboardFieldCombobox
      className={cn("asklake-widget-select", selectClassName)}
      disabled={props.disabled}
      fieldClassName={props.fieldClassName}
      label={String(props.label)}
      options={options}
      value={value}
      onValueChange={(nextValue) => onChange?.({ target: { value: nextValue } } as ChangeEvent<HTMLSelectElement>)}
    />
  );
}
