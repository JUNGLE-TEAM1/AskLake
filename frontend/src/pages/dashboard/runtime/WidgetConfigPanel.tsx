import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Boxes,
  ChartArea,
  ChartColumn,
  ChartLine,
  ChartPie,
  Check,
  CircleDot,
  CircleGauge,
  Grid3X3,
  Hash,
  Table2,
  type LucideIcon,
} from "lucide-react";
import { HexColorInput, HexColorPicker } from "react-colorful";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { FormFieldGroup, type NativeSelectFieldProps } from "@/components/ui/form-field-group";
import { Input } from "@/components/ui/input";
import { SettingsPanel } from "@/components/ui/settings-panel";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { DashboardFieldCombobox, type DashboardComboboxOption } from "./DashboardFieldCombobox";
import type {
  DashboardRuntimeWidget,
  DashboardRuntimeWidgetConfig,
  DashboardRuntimeWidgetType,
  DashboardWidgetAggregation,
  DashboardWidgetColorConfig,
  DashboardWidgetDateUnit,
  DashboardWidgetFilter,
  DashboardWidgetFormat,
  DashboardWidgetLineCurve,
  DashboardWidgetOrientation,
  DashboardWidgetSortDirection,
} from "../../../types";
import type {
  CreateDraftWidgetFormInput,
  DashboardDatasetColumn,
  DashboardDatasetOption,
  DashboardWidgetColorSlotFocus,
  UpdateDraftWidgetFormInput,
} from "./dashboardRuntimeTypes";
import { WidgetFilterEditor } from "./WidgetFilterEditor";
import {
  applyDashboardWidgetFilters,
  dashboardWidgetFiltersFromConfig,
  normalizeDashboardWidgetFilters,
  reconcileDashboardWidgetFilters,
} from "./widgetFilters";
import { validateWidgetConfig, type WidgetConfigDraft } from "./widgetConfigValidation";
import { dashboardWidgetColorChoices, dashboardWidgetDefinitions, dashboardWidgetTypeOptions, defaultWidgetColorConfig } from "./widgetDefinitions";
import { defaultTimeBucketForColumn } from "./timeSeries";
import { barChartFieldLabels } from "./barChartAxes";

const aggregationOptions: Array<{ label: string; value: DashboardWidgetAggregation }> = [
  { label: "합계", value: "sum" },
  { label: "평균", value: "avg" },
  { label: "최솟값", value: "min" },
  { label: "최댓값", value: "max" },
  { label: "개수", value: "count" },
];

const donutAggregationOptions = aggregationOptions.filter((option) => ["sum", "avg", "count"].includes(option.value));

const formatOptions: Array<{ label: string; value: DashboardWidgetFormat }> = [
  { label: "숫자", value: "number" },
  { label: "통화", value: "currency" },
  { label: "퍼센트", value: "percent" },
];

const dateUnitOptions: Array<{ label: string; value: DashboardWidgetDateUnit | "" }> = [
  { label: "원본 시각", value: "" },
  { label: "1분", value: "minute" },
  { label: "1시간", value: "hour" },
  { label: "일", value: "day" },
  { label: "월", value: "month" },
  { label: "년", value: "year" },
];

const curveOptions: Array<{ label: string; value: DashboardWidgetLineCurve }> = [
  { label: "부드럽게", value: "smooth" },
  { label: "직선", value: "straight" },
  { label: "계단형", value: "stepline" },
];

const orientationOptions: Array<{ label: string; value: DashboardWidgetOrientation }> = [
  { label: "세로", value: "vertical" },
  { label: "가로", value: "horizontal" },
];
const multiColorFallbackCount = 6;
function WidgetSelectField({
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

const widgetTypeIcons: Record<DashboardRuntimeWidgetType, LucideIcon> = {
  area_chart: ChartArea,
  bar_chart: ChartColumn,
  donut_chart: CircleDot,
  heatmap_chart: Grid3X3,
  line_chart: ChartLine,
  metric: Hash,
  pie_chart: ChartPie,
  radial_bar_chart: CircleGauge,
  table: Table2,
  treemap_chart: Boxes,
};

function columnNames(columns: DashboardDatasetColumn[]) {
  return columns.map((column) => column.name);
}

function firstName(columns: DashboardDatasetColumn[]) {
  return columns[0]?.name ?? "";
}

function configRecord(config: DashboardRuntimeWidgetConfig) {
  return config as Record<string, unknown>;
}

function configString(config: DashboardRuntimeWidgetConfig, key: string) {
  const value = configRecord(config)[key];
  return typeof value === "string" ? value : undefined;
}

function configNumber(config: DashboardRuntimeWidgetConfig, key: string) {
  const value = configRecord(config)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function configStringArray(config: DashboardRuntimeWidgetConfig, key: string) {
  const value = configRecord(config)[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function configBoolean(config: DashboardRuntimeWidgetConfig, key: string) {
  const value = configRecord(config)[key];
  return typeof value === "boolean" ? value : undefined;
}

function configColor(config: DashboardRuntimeWidgetConfig): DashboardWidgetColorConfig {
  const value = configRecord(config).color;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const colors = Array.isArray(record.colors)
      ? record.colors.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : undefined;
    if (colors?.length) return { colors };

    const customColors = Array.isArray(record.customColors)
      ? record.customColors.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : undefined;
    if (customColors?.length) return { colors: customColors };
  }
  return defaultWidgetColorConfig;
}

function normalizeColorSlots(colors: string[] | undefined, count: number) {
  return Array.from({ length: count }, (_, index) => (
    colors?.[index]
    ?? dashboardWidgetColorChoices[index % dashboardWidgetColorChoices.length]
    ?? defaultWidgetColorConfig.colors[0]
  ));
}

function isDataRow(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueLabelsFromWidget(widget: DashboardRuntimeWidget | null | undefined, key: string | undefined, limit = 8) {
  if (!widget || !key) return [];
  const labels: string[] = [];
  widget.data.filter(isDataRow).forEach((row) => {
    const value = row[key];
    if (value === null || value === undefined || value === "") return;
    const label = String(value);
    if (!labels.includes(label)) labels.push(label);
  });
  return labels.slice(0, limit);
}

function fallbackColorLabels(count: number) {
  return Array.from({ length: count }, (_, index) => `색상 ${index + 1}`);
}

function configDraftFromConfig(config: DashboardRuntimeWidgetConfig): WidgetConfigDraft {
  const runtimeConfig = configRecord(config);
  const sourceConfig = runtimeConfig.sourceConfig;
  const editableConfig = typeof sourceConfig === "object" && sourceConfig !== null && !Array.isArray(sourceConfig)
    ? sourceConfig as DashboardRuntimeWidgetConfig
    : config;
  return {
    aggregation: configString(editableConfig, "aggregation") as DashboardWidgetAggregation | undefined,
    columns: configStringArray(editableConfig, "columns"),
    curve: configString(editableConfig, "curve") as DashboardWidgetLineCurve | undefined,
    dateUnit: configString(editableConfig, "dateUnit") as DashboardWidgetDateUnit | undefined,
    format: configString(editableConfig, "format") as DashboardWidgetFormat | undefined,
    filters: dashboardWidgetFiltersFromConfig(configRecord(editableConfig).filters),
    labelKey: configString(editableConfig, "labelKey"),
    limit: configNumber(editableConfig, "limit"),
    max: configNumber(editableConfig, "max"),
    min: configNumber(editableConfig, "min"),
    orientation: configString(editableConfig, "orientation") as DashboardWidgetOrientation | undefined,
    seriesKey: configString(editableConfig, "seriesKey"),
    sortDirection: configString(editableConfig, "sortDirection") as DashboardWidgetSortDirection | undefined,
    sortKey: configString(editableConfig, "sortKey"),
    stacked: configBoolean(editableConfig, "stacked"),
    valueKey: configString(editableConfig, "valueKey"),
    xKey: configString(editableConfig, "xKey"),
    yKey: configString(editableConfig, "yKey"),
  };
}

function createDefaultConfigs(dataset: DashboardDatasetOption): Record<DashboardRuntimeWidgetType, WidgetConfigDraft> {
  const allColumns = dataset.columns;
  const numericColumns = allColumns.filter((column) => column.type === "number");
  const dimensionColumns = allColumns.filter((column) => column.type === "string" || column.type === "date");
  const categoricalColumns = allColumns.filter((column) => column.type === "string");
  const timeColumns = allColumns.filter((column) => column.type === "date");
  const lineXAxisColumns = timeColumns.length ? timeColumns : dimensionColumns;
  const defaultTimeBucket = defaultTimeBucketForColumn(timeColumns[0]);
  const tableColumns = columnNames(allColumns.slice(0, 5));
  const dimensionFallback = firstName(dimensionColumns);
  const numericFallback = firstName(numericColumns);
  const categoryFallback = firstName(categoricalColumns.length ? categoricalColumns : dimensionColumns);

  return {
    area_chart: {
      aggregation: "sum",
      dateUnit: defaultTimeBucket,
      seriesKey: "",
      stacked: false,
      xKey: firstName(lineXAxisColumns),
      yKey: numericFallback,
    },
    bar_chart: {
      aggregation: "sum",
      groupKey: "",
      orientation: "vertical",
      xKey: dimensionFallback,
      yKey: numericFallback,
    },
    donut_chart: {
      aggregation: "sum",
      labelKey: categoryFallback,
      valueKey: numericFallback,
    },
    heatmap_chart: {
      aggregation: "sum",
      valueKey: numericFallback,
      xKey: dimensionFallback,
      yKey: firstName(categoricalColumns.length > 1 ? categoricalColumns.slice(1) : dimensionColumns),
    },
    line_chart: {
      aggregation: "sum",
      curve: "smooth",
      dateUnit: defaultTimeBucket,
      seriesKey: "",
      xKey: firstName(lineXAxisColumns),
      yKey: numericFallback,
    },
    metric: {
      aggregation: "sum",
      format: "number",
      valueKey: numericFallback,
    },
    pie_chart: {
      aggregation: "sum",
      labelKey: categoryFallback,
      valueKey: numericFallback,
    },
    radial_bar_chart: {
      aggregation: "avg",
      format: "percent",
      labelKey: categoryFallback,
      max: 100,
      min: 0,
      valueKey: numericFallback,
    },
    table: {
      columns: tableColumns,
      limit: 100,
      sortDirection: "asc",
      sortKey: tableColumns[0] ?? "",
    },
    treemap_chart: {
      aggregation: "sum",
      labelKey: categoryFallback,
      valueKey: numericFallback,
    },
  };
}

function buildConfig(
  type: DashboardRuntimeWidgetType,
  config: WidgetConfigDraft,
  common: { color: DashboardWidgetColorConfig; description?: string },
): DashboardRuntimeWidgetConfig {
  const base = {
    description: common.description,
    filters: normalizeDashboardWidgetFilters(config.filters ?? []),
  };
  const chartBase = {
    ...base,
    color: common.color,
  };

  if (type === "metric") {
    return {
      ...base,
      aggregation: config.aggregation ?? "sum",
      format: config.format ?? "number",
      valueKey: config.valueKey ?? "",
    };
  }

  if (type === "table") {
    return {
      ...base,
      columns: config.columns ?? [],
      limit: config.limit,
      sortDirection: config.sortDirection,
      sortKey: config.sortKey || undefined,
    };
  }

  if (type === "line_chart") {
    return {
      ...chartBase,
      aggregation: config.aggregation ?? "sum",
      curve: config.curve ?? "smooth",
      dateUnit: config.dateUnit,
      seriesKey: config.seriesKey || undefined,
      xKey: config.xKey ?? "",
      yKey: config.yKey ?? "",
    };
  }

  if (type === "area_chart") {
    return {
      ...chartBase,
      aggregation: config.aggregation ?? "sum",
      dateUnit: config.dateUnit,
      seriesKey: config.seriesKey || undefined,
      stacked: config.stacked ?? false,
      xKey: config.xKey ?? "",
      yKey: config.yKey ?? "",
    };
  }

  if (type === "donut_chart" || type === "pie_chart" || type === "treemap_chart") {
    return {
      ...chartBase,
      aggregation: config.aggregation ?? "sum",
      labelKey: config.labelKey ?? "",
      valueKey: config.valueKey ?? "",
    };
  }

  if (type === "radial_bar_chart") {
    return {
      ...chartBase,
      aggregation: config.aggregation ?? "avg",
      format: config.format ?? "percent",
      labelKey: config.labelKey || undefined,
      max: config.max ?? 100,
      min: config.min ?? 0,
      valueKey: config.valueKey ?? "",
    };
  }

  if (type === "heatmap_chart") {
    return {
      ...chartBase,
      aggregation: config.aggregation ?? "sum",
      valueKey: config.valueKey ?? "",
      xKey: config.xKey ?? "",
      yKey: config.yKey ?? "",
    };
  }

  return {
    ...chartBase,
    aggregation: config.aggregation ?? "sum",
    groupKey: config.groupKey || undefined,
    orientation: config.orientation ?? "vertical",
    xKey: config.xKey ?? "",
    yKey: config.yKey ?? "",
  };
}

function preserveRuntimeOnlyConfig(
  widget: DashboardRuntimeWidget | null | undefined,
  config: DashboardRuntimeWidgetConfig,
  options: { forPreview?: boolean; preserveVisualizationRequest?: boolean } = {},
): DashboardRuntimeWidgetConfig {
  if (!widget) return config;

  const source = configRecord(widget.config);
  const dataMode = source.dataMode;
  if (options.forPreview && (dataMode === "server_aggregated" || dataMode === "server_preview")) {
    const nextConfig = configRecord(config);
    return {
      ...source,
      ...(nextConfig.color ? { color: nextConfig.color } : {}),
      ...(Object.hasOwn(nextConfig, "description") ? { description: nextConfig.description } : {}),
      sourceConfig: nextConfig,
    } as unknown as DashboardRuntimeWidgetConfig;
  }

  const placeholderKind = source.placeholderKind;
  if (placeholderKind === "text") {
    return {
      ...config,
      placeholderKind,
      ...(typeof source.body === "string" ? { body: source.body } : {}),
    } as DashboardRuntimeWidgetConfig;
  }

  if (placeholderKind !== "visualization_request") return config;
  if (!options.preserveVisualizationRequest) return config;

  return {
    ...config,
    placeholderKind,
    ...(typeof source.prompt === "string" ? { prompt: source.prompt } : {}),
  } as DashboardRuntimeWidgetConfig;
}

function isVisualizationRequestWidget(widget: DashboardRuntimeWidget | null | undefined) {
  return widget ? configRecord(widget.config).placeholderKind === "visualization_request" : false;
}

function cloneDatasetRows(
  dataset: DashboardDatasetOption | null | undefined,
  filters: DashboardWidgetFilter[],
) {
  if (!dataset?.rows) return undefined;
  return applyDashboardWidgetFilters(dataset.rows, filters).map((row) => ({ ...row }));
}

export function WidgetConfigPanel({
  createButtonLabel = "위젯 생성",
  datasets = [],
  editingWidget = null,
  focusedColorSlot = null,
  initialCreateInput = null,
  isCreating = false,
  isUpdating = false,
  onCreateWidget,
  onPreviewWidgetChange,
  onSelectDataset,
  onUpdateWidget,
  selectedDataset,
  selectedDatasetId,
}: {
  createButtonLabel?: string;
  datasets?: DashboardDatasetOption[];
  editingWidget?: DashboardRuntimeWidget | null;
  focusedColorSlot?: DashboardWidgetColorSlotFocus | null;
  initialCreateInput?: CreateDraftWidgetFormInput | null;
  isCreating?: boolean;
  isUpdating?: boolean;
  onCreateWidget: (input: CreateDraftWidgetFormInput) => Promise<void | boolean> | void;
  onPreviewWidgetChange?: (widget: DashboardRuntimeWidget | null) => void;
  onSelectDataset?: (datasetId: string) => void;
  onUpdateWidget?: (widgetId: string, input: UpdateDraftWidgetFormInput) => Promise<void | boolean> | void;
  selectedDataset: DashboardDatasetOption | null;
  selectedDatasetId: string | null;
}) {
  const [color, setColor] = useState<DashboardWidgetColorConfig>(defaultWidgetColorConfig);
  const [configsByType, setConfigsByType] = useState<Partial<Record<DashboardRuntimeWidgetType, WidgetConfigDraft>>>({});
  const [customColorIndex, setCustomColorIndex] = useState(0);
  const [customColorOpen, setCustomColorOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [type, setType] = useState<DashboardRuntimeWidgetType>("bar_chart");
  const descriptionFieldId = useId();
  const titleFieldId = useId();
  const previousEditingWidgetIdRef = useRef<string | null>(null);
  const previousSelectedDatasetIdRef = useRef<string | null>(null);
  const isEditMode = Boolean(editingWidget);
  const isVisualizationRequestEdit = isVisualizationRequestWidget(editingWidget);
  const initialCreateInputKey = initialCreateInput
    ? `${initialCreateInput.datasetId}|${initialCreateInput.type}|${initialCreateInput.title}|${JSON.stringify(initialCreateInput.config)}`
    : "";

  const columnGroups = useMemo(() => {
    const allColumns = selectedDataset?.columns ?? [];
    const numericColumns = allColumns.filter((column) => column.type === "number");
    const dimensionColumns = allColumns.filter((column) => column.type === "string" || column.type === "date");
    const categoricalColumns = allColumns.filter((column) => column.type === "string");
    const timeColumns = allColumns.filter((column) => column.type === "date");

    return {
      allColumns,
      categoricalColumns,
      dimensionColumns,
      lineXAxisColumns: timeColumns.length ? timeColumns : dimensionColumns,
      numericColumns,
    };
  }, [selectedDataset]);

  useEffect(() => {
    const nextEditingWidgetId = editingWidget?.id ?? null;
    const nextSelectedDatasetId = selectedDataset?.id ?? null;
    const shouldResetColorIndex = previousEditingWidgetIdRef.current !== nextEditingWidgetId;
    const shouldResetDatasetConfig = previousSelectedDatasetIdRef.current !== nextSelectedDatasetId;
    previousEditingWidgetIdRef.current = nextEditingWidgetId;
    previousSelectedDatasetIdRef.current = nextSelectedDatasetId;

    setFormError(null);
    if (shouldResetColorIndex) {
      setCustomColorOpen(false);
      setCustomColorIndex(0);
    }
    if (editingWidget) {
      if (!shouldResetColorIndex && !shouldResetDatasetConfig) return;

      setType(editingWidget.type);
      setTitle(editingWidget.title ?? "");
      setDescription(configString(editingWidget.config, "description") ?? "");
      setColor(configColor(editingWidget.config));
      const defaultConfigs: Partial<Record<DashboardRuntimeWidgetType, WidgetConfigDraft>> = selectedDataset
        ? createDefaultConfigs(selectedDataset)
        : {};
      const restoredConfig = configDraftFromConfig(editingWidget.config);
      setConfigsByType({
        ...defaultConfigs,
        [editingWidget.type]: isVisualizationRequestWidget(editingWidget)
          ? defaultConfigs[editingWidget.type] ?? {}
          : {
              ...restoredConfig,
              filters: selectedDataset
                ? reconcileDashboardWidgetFilters(restoredConfig.filters ?? [], selectedDataset.columns)
                : restoredConfig.filters ?? [],
            },
      });
      return;
    }

    const initialInput = initialCreateInput?.datasetId === nextSelectedDatasetId
      ? initialCreateInput
      : null;
    if (initialInput && selectedDataset) {
      const restoredConfig = configDraftFromConfig(initialInput.config);
      setType(initialInput.type);
      setTitle(initialInput.title);
      setDescription(configString(initialInput.config, "description") ?? "");
      setColor(configColor(initialInput.config));
      setConfigsByType({
        ...createDefaultConfigs(selectedDataset),
        [initialInput.type]: {
          ...restoredConfig,
          filters: reconcileDashboardWidgetFilters(
            restoredConfig.filters ?? [],
            selectedDataset.columns,
          ),
        },
      });
      return;
    }

    setColor(defaultWidgetColorConfig);
    setDescription("");
    setTitle("");
    setType("bar_chart");
    setConfigsByType(selectedDataset ? createDefaultConfigs(selectedDataset) : {});
  }, [editingWidget, initialCreateInputKey, selectedDataset]);

  const currentConfig = configsByType[type] ?? {};
  const barChartFields = barChartFieldLabels(currentConfig.orientation ?? "vertical");
  const radialRangeStart = Math.min(currentConfig.min ?? 0, currentConfig.max ?? 100);
  const radialRangeEnd = Math.max(currentConfig.min ?? 0, currentConfig.max ?? 100);
  const radialRangeFloor = Math.min(0, radialRangeStart);
  const radialRangeCeiling = Math.max(100, radialRangeEnd);
  const colorSlotLabels = useMemo(() => {
    if (type === "metric" || type === "table") return [];

    if (type === "donut_chart" || type === "pie_chart" || type === "treemap_chart") {
      const labels = uniqueLabelsFromWidget(editingWidget, currentConfig.labelKey, multiColorFallbackCount);
      return labels.length ? labels : fallbackColorLabels(multiColorFallbackCount);
    }

    if (type === "heatmap_chart") return ["강도 색상"];

    if (type === "radial_bar_chart") {
      const labels = uniqueLabelsFromWidget(editingWidget, currentConfig.labelKey, multiColorFallbackCount);
      return currentConfig.labelKey && labels.length ? labels : ["기본 색상"];
    }

    const seriesKey = type === "bar_chart" ? currentConfig.groupKey : currentConfig.seriesKey;
    const labels = uniqueLabelsFromWidget(editingWidget, seriesKey, multiColorFallbackCount);
    if (seriesKey) return labels.length ? labels : fallbackColorLabels(multiColorFallbackCount);

    return ["기본 색상"];
  }, [
    currentConfig.groupKey,
    currentConfig.labelKey,
    currentConfig.seriesKey,
    editingWidget,
    type,
  ]);

  useEffect(() => {
    if (!colorSlotLabels.length) return;
    if (customColorIndex >= colorSlotLabels.length) setCustomColorIndex(0);
    setColor((current) => ({
      colors: normalizeColorSlots(current.colors, colorSlotLabels.length),
    }));
  }, [colorSlotLabels.length, customColorIndex]);

  useEffect(() => {
    if (!focusedColorSlot || focusedColorSlot.widgetId !== editingWidget?.id || !colorSlotLabels.length) return;
    const nextIndex = Math.max(0, Math.min(focusedColorSlot.slotIndex, colorSlotLabels.length - 1));
    setCustomColorOpen(false);
    setCustomColorIndex(nextIndex);
  }, [colorSlotLabels.length, editingWidget?.id, focusedColorSlot]);

  const requiresDatasetSelection = !isEditMode || isVisualizationRequestEdit;
  const shouldShowDatasetSelect = !isEditMode || isVisualizationRequestEdit;
  const validationMessage = selectedDataset || isEditMode
    ? validateWidgetConfig(type, currentConfig, columnGroups.allColumns)
    : "왼쪽에서 데이터셋을 먼저 선택해 주세요.";
  const canSubmit = Boolean(
    (isEditMode || (selectedDatasetId && selectedDataset))
    && !validationMessage
    && (!requiresDatasetSelection || (selectedDatasetId && selectedDataset))
  );

  const patchCurrentConfig = (patch: WidgetConfigDraft) => {
    setConfigsByType((current) => ({
      ...current,
      [type]: {
        ...(current[type] ?? {}),
        ...patch,
      },
    }));
  };

  const activeColors = normalizeColorSlots(color.colors, Math.max(colorSlotLabels.length, 1));
  const activeCustomColor = activeColors[customColorIndex] ?? activeColors[0] ?? defaultWidgetColorConfig.colors[0];

  const updateColorSlot = (slotIndex: number, nextColor: string) => {
    setColor((current) => {
      const nextColors = normalizeColorSlots(current.colors, Math.max(colorSlotLabels.length, 1));
      nextColors[slotIndex] = nextColor;
      return { colors: nextColors };
    });
  };

  useEffect(() => {
    if (!editingWidget) {
      onPreviewWidgetChange?.(null);
      return;
    }

    onPreviewWidgetChange?.({
      ...editingWidget,
      config: preserveRuntimeOnlyConfig(
        editingWidget,
        buildConfig(type, currentConfig, {
          color,
          description: description.trim() || undefined,
        }),
        { forPreview: true, preserveVisualizationRequest: true },
      ),
      title: title.trim() || "제목 없는 위젯",
      type,
    } as DashboardRuntimeWidget);
  }, [
    color,
    currentConfig,
    description,
    editingWidget,
    onPreviewWidgetChange,
    title,
    type,
  ]);

  const toggleTableColumn = (columnName: string) => {
    const currentColumns = currentConfig.columns ?? [];
    const nextColumns = currentColumns.includes(columnName)
      ? currentColumns.filter((column) => column !== columnName)
      : [...currentColumns, columnName];
    patchCurrentConfig({
      columns: nextColumns,
      sortKey: nextColumns.includes(currentConfig.sortKey ?? "") ? currentConfig.sortKey : nextColumns[0] ?? "",
    });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (requiresDatasetSelection && (!selectedDataset || !selectedDatasetId)) {
      setFormError("왼쪽에서 데이터셋을 먼저 선택해 주세요.");
      return;
    }

    const error = validateWidgetConfig(type, currentConfig, columnGroups.allColumns);
    if (error) {
      setFormError(error);
      return;
    }

    setFormError(null);
    const nextConfig = buildConfig(type, currentConfig, {
      color,
      description: description.trim() || undefined,
    });
    const nextDatasetId = selectedDatasetId ?? editingWidget?.datasetId ?? null;
    const nextInput = {
      config: preserveRuntimeOnlyConfig(editingWidget, nextConfig, {
        preserveVisualizationRequest: !nextDatasetId,
      }),
      title: title.trim() || "제목 없는 위젯",
      type,
    };

    if (editingWidget && onUpdateWidget) {
      await onUpdateWidget(editingWidget.id, {
        ...nextInput,
        data: cloneDatasetRows(selectedDataset, currentConfig.filters ?? []),
        datasetId: nextDatasetId,
      });
      return;
    }

    if (!selectedDatasetId) {
      setFormError("왼쪽에서 데이터셋을 먼저 선택해 주세요.");
      return;
    }

    await onCreateWidget({
      ...nextInput,
      data: cloneDatasetRows(selectedDataset, currentConfig.filters ?? []),
      datasetId: selectedDatasetId,
    });
    setTitle("");
    setDescription("");
  };

  if (selectedDataset?.status === "preparing" && !editingWidget) {
    return (
      <SettingsPanel
        className="asklake-widget-config-panel empty"
        description="연결된 Job의 첫 실행이 완료되면 실제 데이터로 차트를 만들 수 있습니다."
        headerClassName="asklake-widget-config-heading asklake-widget-config-empty-heading"
        title="출력 Dataset을 준비하고 있습니다"
      />
    );
  }

  if (!selectedDataset && !editingWidget) {
    return (
      <SettingsPanel
        className="asklake-widget-config-panel empty"
        description="왼쪽에서 데이터셋을 선택하면 위젯 설정을 만들 수 있습니다."
        headerClassName="asklake-widget-config-heading asklake-widget-config-empty-heading"
        title="데이터셋을 선택해 주세요"
      />
    );
  }

  return (
    <SettingsPanel
      bodyClassName="contents"
      className="asklake-widget-config-panel"
      header={(
        <div className="asklake-widget-config-heading">
          <div>
            <span>{isEditMode ? "선택된 위젯" : "데이터셋"}</span>
            <strong className="min-w-0 max-w-full break-words">
              {isEditMode ? editingWidget?.title || "제목 없는 위젯" : selectedDataset?.name}
            </strong>
          </div>
        </div>
      )}
    >
        <form className="asklake-widget-config-form" onSubmit={(event) => void handleSubmit(event)}>
          <FieldGroup className="contents">
            {shouldShowDatasetSelect ? (
              <DashboardFieldCombobox
                disabled={!datasets.length || !onSelectDataset}
                fieldClassName="asklake-widget-dataset-field"
                label="데이터셋"
                options={datasets.map((dataset) => ({ label: dataset.name, value: dataset.id }))}
                placeholder="데이터셋 선택"
                value={selectedDatasetId ?? ""}
                onValueChange={(value) => onSelectDataset?.(value)}
              />
            ) : null}
          <Field>
            <FieldLabel htmlFor={titleFieldId}>위젯 제목</FieldLabel>
            <Input
              id={titleFieldId}
              size="sm"
              placeholder="제목 없는 위젯"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor={descriptionFieldId}>설명</FieldLabel>
            <Textarea
              id={descriptionFieldId}
              placeholder="이 위젯에 대한 설명을 짧게 적어주세요."
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel>위젯 타입</FieldLabel>
            <TooltipProvider delayDuration={150}>
              <ToggleGroup
                aria-label="위젯 타입"
                className="grid w-full grid-cols-5 gap-3 bg-transparent p-0"
                type="single"
                value={type}
                onValueChange={(nextType) => {
                  if (!nextType) return;
                  setCustomColorIndex(0);
                  setType(nextType as DashboardRuntimeWidgetType);
                }}
              >
                {dashboardWidgetTypeOptions.map((option) => {
                  const definition = dashboardWidgetDefinitions[option.value];
                  const Icon = widgetTypeIcons[option.value];
                  const label = `${definition.label}: ${definition.description}`;
                  return (
                    <Tooltip key={option.value}>
                      <TooltipTrigger asChild>
                        <ToggleGroupItem
                          aria-label={label}
                          className="h-11 w-full border border-slate-200 bg-white text-slate-500 data-[state=on]:border-blue-600 data-[state=on]:bg-blue-50 data-[state=on]:text-blue-700"
                          size="icon"
                          value={option.value}
                        >
                          <Icon aria-hidden="true" />
                        </ToggleGroupItem>
                      </TooltipTrigger>
                      <TooltipContent side="top">{label}</TooltipContent>
                    </Tooltip>
                  );
                })}
              </ToggleGroup>
            </TooltipProvider>
          </Field>

        {colorSlotLabels.length > 0 && (
          <div className="asklake-widget-palette-field">
            <span>색상</span>
            <div className="asklake-widget-color-slots">
              {colorSlotLabels.map((label, index) => (
                <Button
                  key={`${label}-${index}`}
                  className={`asklake-widget-color-slot${customColorIndex === index ? " selected" : ""}`}
                  type="button"
                  onClick={() => setCustomColorIndex(index)}
                >
                  <i style={{ backgroundColor: activeColors[index] }} />
                  <span>{label}</span>
                </Button>
              ))}
            </div>

            <div className="asklake-widget-color-choice-panel">
              <div className="asklake-widget-color-choice-list" aria-label={`${colorSlotLabels[customColorIndex] ?? "선택 색상"} 색상 선택`}>
                {dashboardWidgetColorChoices.map((choice) => {
                  const isSelected = activeCustomColor.toLowerCase() === choice.toLowerCase();
                  return (
                    <Button
                      key={choice}
                      className={`asklake-widget-color-choice${isSelected ? " selected" : ""}`}
                      style={{ backgroundColor: choice }}
                      type="button"
                      onClick={() => {
                        setCustomColorOpen(false);
                        updateColorSlot(customColorIndex, choice);
                      }}
                    >
                      {isSelected && <Check aria-hidden="true" size={15} strokeWidth={3.5} />}
                    </Button>
                  );
                })}
                <Button
                  aria-label="직접 색상 만들기"
                  className={`asklake-widget-color-choice custom${customColorOpen ? " selected" : ""}`}
                  type="button"
                  onClick={() => setCustomColorOpen((open) => !open)}
                >
                  {customColorOpen && <Check aria-hidden="true" size={15} strokeWidth={3.5} />}
                </Button>
              </div>

              {customColorOpen && (
                <div className="asklake-widget-custom-color-panel">
                  <HexColorPicker color={activeCustomColor} onChange={(nextColor) => updateColorSlot(customColorIndex, nextColor)} />
                  <FormFieldGroup className="asklake-widget-hex-input" label="HEX">
                    <HexColorInput
                      prefixed
                      color={activeCustomColor}
                      onChange={(nextColor) => updateColorSlot(customColorIndex, nextColor)}
                    />
                  </FormFieldGroup>
                </div>
              )}
            </div>

            <small>
              {colorSlotLabels.length === 1
                ? "선택한 색상 하나가 차트에 적용됩니다."
                : "위 항목을 하나씩 선택해서 각 요소의 색상을 바꿀 수 있습니다."}
            </small>
          </div>
        )}

        {type === "metric" && (
          <>
            <WidgetSelectField label="값" value={currentConfig.valueKey ?? ""} onChange={(event) => patchCurrentConfig({ valueKey: event.target.value })}>
                {columnGroups.numericColumns.map((column) => (
                  <option key={column.name} value={column.name}>{column.name}</option>
                ))}
            </WidgetSelectField>
            <WidgetSelectField label="집계 방식" value={currentConfig.aggregation ?? "sum"} onChange={(event) => patchCurrentConfig({ aggregation: event.target.value as DashboardWidgetAggregation })}>
                {aggregationOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
            </WidgetSelectField>
            <WidgetSelectField label="표시 형식" value={currentConfig.format ?? "number"} onChange={(event) => patchCurrentConfig({ format: event.target.value as DashboardWidgetFormat })}>
                {formatOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
            </WidgetSelectField>
          </>
        )}

        {type === "table" && (
          <>
            <fieldset className="asklake-widget-column-picker">
              <legend>컬럼</legend>
              {columnGroups.allColumns.map((column) => (
                <label key={column.name}>
                  <Checkbox
                    checked={(currentConfig.columns ?? []).includes(column.name)}
                    onCheckedChange={() => toggleTableColumn(column.name)}
                  />
                  <span>{column.name}</span>
                </label>
              ))}
            </fieldset>
            <WidgetSelectField label="기본 정렬 컬럼" value={currentConfig.sortKey ?? ""} onChange={(event) => patchCurrentConfig({ sortKey: event.target.value })}>
                <option value="">선택 안 함</option>
                {(currentConfig.columns ?? []).map((column) => (
                  <option key={column} value={column}>{column}</option>
                ))}
            </WidgetSelectField>
            <WidgetSelectField label="정렬 방향" value={currentConfig.sortDirection ?? "asc"} onChange={(event) => patchCurrentConfig({ sortDirection: event.target.value as DashboardWidgetSortDirection })}>
                <option value="asc">오름차순</option>
                <option value="desc">내림차순</option>
            </WidgetSelectField>
            <FormFieldGroup label="행 개수 제한">
              <Input
                size="sm"
                min={1}
                type="number"
                value={currentConfig.limit ?? 100}
                onChange={(event) => patchCurrentConfig({ limit: Number(event.target.value) || 100 })}
              />
            </FormFieldGroup>
          </>
        )}

        {(type === "bar_chart" || type === "line_chart" || type === "area_chart") && (
          <>
            {type === "bar_chart" && (
              <WidgetSelectField label="방향" value={currentConfig.orientation ?? "vertical"} onChange={(event) => patchCurrentConfig({ orientation: event.target.value as DashboardWidgetOrientation })}>
                  {orientationOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
              </WidgetSelectField>
            )}
            <WidgetSelectField label={type === "bar_chart" ? barChartFields.category : "X축"} value={currentConfig.xKey ?? ""} onChange={(event) => patchCurrentConfig({ xKey: event.target.value })}>
                {columnGroups.allColumns.map((column) => (
                  <option key={column.name} value={column.name}>{column.name}</option>
                ))}
            </WidgetSelectField>
            <WidgetSelectField label={type === "bar_chart" ? barChartFields.value : "Y축"} value={currentConfig.yKey ?? ""} onChange={(event) => patchCurrentConfig({ yKey: event.target.value })}>
                {columnGroups.numericColumns.map((column) => (
                  <option key={column.name} value={column.name}>{column.name}</option>
                ))}
            </WidgetSelectField>
            <WidgetSelectField label="집계 방식" value={currentConfig.aggregation ?? "sum"} onChange={(event) => patchCurrentConfig({ aggregation: event.target.value as DashboardWidgetAggregation })}>
                {aggregationOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
            </WidgetSelectField>
            {type === "bar_chart" && (
              <>
                <WidgetSelectField label="그룹 컬럼" value={currentConfig.groupKey ?? ""} onChange={(event) => patchCurrentConfig({ groupKey: event.target.value })}>
                    <option value="">선택 안 함</option>
                    {columnGroups.dimensionColumns.map((column) => (
                      <option key={column.name} value={column.name}>{column.name}</option>
                    ))}
                </WidgetSelectField>
              </>
            )}
            {(type === "line_chart" || type === "area_chart") && (
              <>
                <WidgetSelectField label="시리즈 컬럼" value={currentConfig.seriesKey ?? ""} onChange={(event) => patchCurrentConfig({ seriesKey: event.target.value })}>
                    <option value="">선택 안 함</option>
                    {columnGroups.dimensionColumns.map((column) => (
                      <option key={column.name} value={column.name}>{column.name}</option>
                    ))}
                </WidgetSelectField>
              <WidgetSelectField label="시간 묶음" value={currentConfig.dateUnit ?? ""} onChange={(event) => patchCurrentConfig({ dateUnit: event.target.value ? event.target.value as DashboardWidgetDateUnit : undefined })}>
                  {dateUnitOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
              </WidgetSelectField>
              </>
            )}
            {type === "line_chart" && (
              <WidgetSelectField label="선 모양" value={currentConfig.curve ?? "smooth"} onChange={(event) => patchCurrentConfig({ curve: event.target.value as DashboardWidgetLineCurve })}>
                  {curveOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
              </WidgetSelectField>
            )}
            {type === "area_chart" && (
              <label className="asklake-widget-checkbox-row">
                <Checkbox
                  checked={currentConfig.stacked ?? false}
                  onCheckedChange={(checked) => patchCurrentConfig({ stacked: checked === true })}
                />
                <span>누적 영역으로 표시</span>
              </label>
            )}
          </>
        )}

        {(type === "donut_chart" || type === "pie_chart" || type === "treemap_chart") && (
          <>
            <WidgetSelectField label="분류" value={currentConfig.labelKey ?? ""} onChange={(event) => patchCurrentConfig({ labelKey: event.target.value })}>
                {(columnGroups.categoricalColumns.length ? columnGroups.categoricalColumns : columnGroups.dimensionColumns).map((column) => (
                  <option key={column.name} value={column.name}>{column.name}</option>
                ))}
            </WidgetSelectField>
            <WidgetSelectField label="값" value={currentConfig.valueKey ?? ""} onChange={(event) => patchCurrentConfig({ valueKey: event.target.value })}>
                {columnGroups.numericColumns.map((column) => (
                  <option key={column.name} value={column.name}>{column.name}</option>
                ))}
            </WidgetSelectField>
            <WidgetSelectField label="집계 방식" value={currentConfig.aggregation ?? "sum"} onChange={(event) => patchCurrentConfig({ aggregation: event.target.value as DashboardWidgetAggregation })}>
                {donutAggregationOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
            </WidgetSelectField>
          </>
        )}

        {type === "radial_bar_chart" && (
          <>
            <WidgetSelectField label="값" value={currentConfig.valueKey ?? ""} onChange={(event) => patchCurrentConfig({ valueKey: event.target.value })}>
                {columnGroups.numericColumns.map((column) => (
                  <option key={column.name} value={column.name}>{column.name}</option>
                ))}
            </WidgetSelectField>
            <WidgetSelectField label="분류" value={currentConfig.labelKey ?? ""} onChange={(event) => patchCurrentConfig({ labelKey: event.target.value })}>
                <option value="">선택 안 함</option>
                {columnGroups.dimensionColumns.map((column) => (
                  <option key={column.name} value={column.name}>{column.name}</option>
                ))}
            </WidgetSelectField>
            <WidgetSelectField label="집계 방식" value={currentConfig.aggregation ?? "avg"} onChange={(event) => patchCurrentConfig({ aggregation: event.target.value as DashboardWidgetAggregation })}>
                {aggregationOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
            </WidgetSelectField>
            <FormFieldGroup label="표시 범위">
              <div className="grid gap-3">
                <div className="flex items-center justify-between text-sm font-semibold text-slate-600">
                  <span>최솟값 {radialRangeStart}</span>
                  <span>최댓값 {radialRangeEnd}</span>
                </div>
                <Slider
                  aria-label="radial chart 표시 범위"
                  max={radialRangeCeiling}
                  min={radialRangeFloor}
                  minStepsBetweenThumbs={1}
                  onValueChange={([min = 0, max = 100]) => patchCurrentConfig({ min, max })}
                  step={1}
                  value={[radialRangeStart, radialRangeEnd]}
                />
              </div>
            </FormFieldGroup>
          </>
        )}

        {type === "heatmap_chart" && (
          <>
            <WidgetSelectField label="X축" value={currentConfig.xKey ?? ""} onChange={(event) => patchCurrentConfig({ xKey: event.target.value })}>
                {columnGroups.dimensionColumns.map((column) => (
                  <option key={column.name} value={column.name}>{column.name}</option>
                ))}
            </WidgetSelectField>
            <WidgetSelectField label="Y축" value={currentConfig.yKey ?? ""} onChange={(event) => patchCurrentConfig({ yKey: event.target.value })}>
                {columnGroups.dimensionColumns.map((column) => (
                  <option key={column.name} value={column.name}>{column.name}</option>
                ))}
            </WidgetSelectField>
            <WidgetSelectField label="값" value={currentConfig.valueKey ?? ""} onChange={(event) => patchCurrentConfig({ valueKey: event.target.value })}>
                {columnGroups.numericColumns.map((column) => (
                  <option key={column.name} value={column.name}>{column.name}</option>
                ))}
            </WidgetSelectField>
            <WidgetSelectField label="집계 방식" value={currentConfig.aggregation ?? "sum"} onChange={(event) => patchCurrentConfig({ aggregation: event.target.value as DashboardWidgetAggregation })}>
                {aggregationOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
            </WidgetSelectField>
          </>
        )}

        {selectedDataset ? (
          <WidgetFilterEditor
            dataset={selectedDataset}
            filters={currentConfig.filters ?? []}
            onChange={(filters) => patchCurrentConfig({ filters })}
          />
        ) : null}

        {(formError || validationMessage) && <FieldError>{formError ?? validationMessage}</FieldError>}

        <div className="asklake-widget-config-actions">
          <Button className="asklake-widget-create-button" disabled={!canSubmit || isCreating || isUpdating} type="submit">
            {isEditMode ? (isUpdating ? "저장 중" : "변경사항 저장") : (isCreating ? "생성 중" : createButtonLabel)}
          </Button>
        </div>
          </FieldGroup>
        </form>
    </SettingsPanel>
  );
}
