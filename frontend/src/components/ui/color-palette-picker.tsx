import * as React from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface ColorPalettePickerProps {
  activeColor: string;
  choiceListAriaLabel?: string;
  choices: string[];
  className?: string;
  colors: string[];
  customOpen?: boolean;
  customPanel?: React.ReactNode;
  helperText?: React.ReactNode;
  label?: React.ReactNode;
  onSelectChoice: (color: string) => void;
  onSelectSlot: (index: number) => void;
  onToggleCustom: () => void;
  selectedSlotIndex: number;
  slotLabels: string[];
}

export function ColorPalettePicker({
  activeColor,
  choiceListAriaLabel,
  choices,
  className = "asklake-widget-palette-field",
  colors,
  customOpen = false,
  customPanel,
  helperText,
  label = "색상",
  onSelectChoice,
  onSelectSlot,
  onToggleCustom,
  selectedSlotIndex,
  slotLabels,
}: ColorPalettePickerProps) {
  if (slotLabels.length === 0) return null;

  return (
    <div className={className}>
      <span>{label}</span>
      <div className="asklake-widget-color-slots">
        {slotLabels.map((slotLabel, index) => (
          <Button
            key={`${slotLabel}-${index}`}
            className={`asklake-widget-color-slot${selectedSlotIndex === index ? " selected" : ""}`}
            type="button"
            onClick={() => onSelectSlot(index)}
          >
            <i style={{ backgroundColor: colors[index] }} />
            <span>{slotLabel}</span>
          </Button>
        ))}
      </div>

      <div className="asklake-widget-color-choice-panel">
        <div className="asklake-widget-color-choice-list" aria-label={choiceListAriaLabel}>
          {choices.map((choice) => {
            const isSelected = activeColor.toLowerCase() === choice.toLowerCase();
            return (
              <Button
                key={choice}
                className={`asklake-widget-color-choice${isSelected ? " selected" : ""}`}
                style={{ backgroundColor: choice }}
                type="button"
                onClick={() => onSelectChoice(choice)}
              >
                {isSelected && <Check aria-hidden="true" size={15} strokeWidth={3.5} />}
              </Button>
            );
          })}
          <Button
            aria-label="직접 색상 만들기"
            className={`asklake-widget-color-choice custom${customOpen ? " selected" : ""}`}
            type="button"
            onClick={onToggleCustom}
          >
            {customOpen && <Check aria-hidden="true" size={15} strokeWidth={3.5} />}
          </Button>
        </div>

        {customOpen && customPanel}
      </div>

      {helperText ? <small>{helperText}</small> : null}
    </div>
  );
}
