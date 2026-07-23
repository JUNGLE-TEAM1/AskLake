import { FormFieldGroup } from "@/components/ui/form-field-group";
import { Input } from "@/components/ui/input";
import type {
  DashboardWidgetAxisRangeMode,
  DashboardWidgetValueAxisRangeConfig,
} from "../../../types";
import type { WidgetConfigDraft } from "./widgetConfigValidation";
import { WidgetSelectField } from "./WidgetSelectField";

const axisRangeModeOptions: Array<{ label: string; value: DashboardWidgetAxisRangeMode }> = [
  { label: "기본 자동 범위", value: "default" },
  { label: "데이터 차이 강조", value: "data_focus" },
  { label: "직접 입력", value: "manual" },
];
const axisRangeModes = new Set<DashboardWidgetAxisRangeMode>(axisRangeModeOptions.map(({ value }) => value));

export function dashboardAxisRangeModeFromValue(value: unknown) {
  return typeof value === "string" && axisRangeModes.has(value as DashboardWidgetAxisRangeMode)
    ? value as DashboardWidgetAxisRangeMode
    : undefined;
}

export function valueAxisRangeConfigFromDraft(
  config: WidgetConfigDraft,
): DashboardWidgetValueAxisRangeConfig {
  const valueAxisRangeMode = config.valueAxisRangeMode ?? "default";
  return {
    valueAxisRangeMode,
    ...(valueAxisRangeMode === "manual" && config.valueAxisMax !== undefined
      ? { valueAxisMax: config.valueAxisMax }
      : {}),
    ...(valueAxisRangeMode === "manual" && config.valueAxisMin !== undefined
      ? { valueAxisMin: config.valueAxisMin }
      : {}),
  };
}

function optionalNumberInput(value: string) {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function WidgetAxisRangeFields({
  config,
  onChange,
}: {
  config: WidgetConfigDraft;
  onChange: (patch: Partial<WidgetConfigDraft>) => void;
}) {
  return (
    <>
      <WidgetSelectField
        label="값 축 범위"
        value={config.valueAxisRangeMode ?? "default"}
        onChange={(event) => onChange({
          valueAxisRangeMode: event.target.value as DashboardWidgetAxisRangeMode,
        })}
      >
        {axisRangeModeOptions.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </WidgetSelectField>
      {config.valueAxisRangeMode === "data_focus" && (
        <p className="text-xs leading-5 text-slate-500" role="note">
          표시 데이터의 최솟값과 최댓값에 8% 여백을 더해 작은 차이가 잘 보이도록 조정합니다.
        </p>
      )}
      {config.valueAxisRangeMode === "manual" && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <FormFieldGroup label="축 최솟값">
              <Input
                size="sm"
                step="any"
                type="number"
                value={config.valueAxisMin ?? ""}
                onChange={(event) => onChange({ valueAxisMin: optionalNumberInput(event.target.value) })}
              />
            </FormFieldGroup>
            <FormFieldGroup label="축 최댓값">
              <Input
                size="sm"
                step="any"
                type="number"
                value={config.valueAxisMax ?? ""}
                onChange={(event) => onChange({ valueAxisMax: optionalNumberInput(event.target.value) })}
              />
            </FormFieldGroup>
          </div>
          <p className="text-xs leading-5 text-amber-700" role="note">
            한쪽 값만 입력하면 반대쪽은 자동 계산됩니다. 지정 범위 밖의 데이터는 차트에서 잘릴 수 있습니다.
          </p>
        </>
      )}
    </>
  );
}
