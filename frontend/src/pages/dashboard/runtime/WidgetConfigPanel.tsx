import { useEffect, useMemo, useRef, useState, type ComponentProps, type FormEvent } from "react";
import { createPortal } from "react-dom";
import {
  Boxes,
  ChartArea,
  ChartColumn,
  ChartLine,
  ChartPie,
  CircleDot,
  CircleGauge,
  Grid3X3,
  Hash,
  Table2,
  type LucideIcon,
} from "lucide-react";
import { HexColorInput, HexColorPicker } from "react-colorful";
import { Button } from "@/components/ui/button";
import { ColorPalettePicker } from "@/components/ui/color-palette-picker";
import { FormFieldGroup, NativeSelectField } from "@/components/ui/form-field-group";
import { IconOptionGrid } from "@/components/ui/icon-option-grid";
import { Input } from "@/components/ui/input";
import { SettingsPanel } from "@/components/ui/settings-panel";
import { cn } from "@/lib/utils";
import type {
  DashboardRuntimeWidget,
  DashboardRuntimeWidgetConfig,
  DashboardRuntimeWidgetType,
  DashboardWidgetAggregation,
  DashboardWidgetColorConfig,
  DashboardWidgetDateUnit,
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
import { dashboardWidgetColorChoices, dashboardWidgetDefinitions, dashboardWidgetTypeOptions, defaultWidgetColorConfig } from "./widgetDefinitions";

type WidgetConfigDraft = {
  aggregation?: DashboardWidgetAggregation;
  columns?: string[];
  curve?: DashboardWidgetLineCurve;
  dateUnit?: DashboardWidgetDateUnit;
  format?: DashboardWidgetFormat;
  groupKey?: string;
  labelKey?: string;
  limit?: number;
  max?: number;
  min?: number;
  orientation?: DashboardWidgetOrientation;
  seriesKey?: string;
  sortDirection?: DashboardWidgetSortDirection;
  sortKey?: string;
  stacked?: boolean;
  valueKey?: string;
  xKey?: string;
  yKey?: string;
};

type WidgetTypeTooltip = {
  left: number;
  text: string;
  top: number;
};

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

const dateUnitOptions: Array<{ label: string; value: DashboardWidgetDateUnit }> = [
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

function WidgetSelectField({ selectClassName, ...props }: ComponentProps<typeof NativeSelectField>) {
  return <NativeSelectField selectClassName={cn("asklake-widget-select", selectClassName)} {...props} />;
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

function createWidgetTypeTooltip(target: HTMLElement, text: string): WidgetTypeTooltip {
  const rect = target.getBoundingClientRect();
  const halfTooltipWidth = 150;
  const safeLeft = Math.min(
    Math.max(rect.left + rect.width / 2, halfTooltipWidth),
    window.innerWidth - halfTooltipWidth,
  );

  return {
    left: safeLeft,
    text,
    top: Math.max(rect.top - 10, 12),
  };
}

function configDraftFromWidget(widget: DashboardRuntimeWidget): WidgetConfigDraft {
  const config = widget.config;
  return {
    aggregation: configString(config, "aggregation") as DashboardWidgetAggregation | undefined,
    columns: configStringArray(config, "columns"),
    curve: configString(config, "curve") as DashboardWidgetLineCurve | undefined,
    dateUnit: configString(config, "dateUnit") as DashboardWidgetDateUnit | undefined,
    format: configString(config, "format") as DashboardWidgetFormat | undefined,
    labelKey: configString(config, "labelKey"),
    limit: configNumber(config, "limit"),
    max: configNumber(config, "max"),
    min: configNumber(config, "min"),
    orientation: configString(config, "orientation") as DashboardWidgetOrientation | undefined,
    seriesKey: configString(config, "seriesKey"),
    sortDirection: configString(config, "sortDirection") as DashboardWidgetSortDirection | undefined,
    sortKey: configString(config, "sortKey"),
    stacked: configBoolean(config, "stacked"),
    valueKey: configString(config, "valueKey"),
    xKey: configString(config, "xKey"),
    yKey: configString(config, "yKey"),
  };
}

function createDefaultConfigs(dataset: DashboardDatasetOption): Record<DashboardRuntimeWidgetType, WidgetConfigDraft> {
  const allColumns = dataset.columns;
  const numericColumns = allColumns.filter((column) => column.type === "number");
  const dimensionColumns = allColumns.filter((column) => column.type === "string" || column.type === "date");
  const categoricalColumns = allColumns.filter((column) => column.type === "string");
  const timeColumns = allColumns.filter((column) => column.type === "date");
  const lineXAxisColumns = timeColumns.length ? timeColumns : dimensionColumns;
  const tableColumns = columnNames(allColumns.slice(0, 5));
  const dimensionFallback = firstName(dimensionColumns);
  const numericFallback = firstName(numericColumns);
  const categoryFallback = firstName(categoricalColumns.length ? categoricalColumns : dimensionColumns);

  return {
    area_chart: {
      aggregation: "sum",
      dateUnit: timeColumns.length ? "month" : undefined,
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
      dateUnit: timeColumns.length ? "month" : undefined,
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

function validateConfig(type: DashboardRuntimeWidgetType, config: WidgetConfigDraft) {
  const usesCount = config.aggregation === "count";
  if (type === "metric" && !usesCount && !config.valueKey) return "값 컬럼을 선택해 주세요.";
  if (type === "table" && (!config.columns || config.columns.length === 0)) return "표시할 컬럼을 1개 이상 선택해 주세요.";
  if ((type === "bar_chart" || type === "line_chart" || type === "area_chart") && (!config.xKey || (!usesCount && !config.yKey))) {
    return "X축과 Y축 컬럼을 선택해 주세요.";
  }
  if ((type === "donut_chart" || type === "pie_chart" || type === "treemap_chart") && (!config.labelKey || (!usesCount && !config.valueKey))) {
    return "분류와 값 컬럼을 선택해 주세요.";
  }
  if (type === "radial_bar_chart" && !usesCount && !config.valueKey) return "값 컬럼을 선택해 주세요.";
  if (type === "heatmap_chart" && (!config.xKey || !config.yKey || (!usesCount && !config.valueKey))) {
    return "X축, Y축, 값 컬럼을 선택해 주세요.";
  }
  return null;
}

function buildConfig(
  type: DashboardRuntimeWidgetType,
  config: WidgetConfigDraft,
  common: { color: DashboardWidgetColorConfig; description?: string },
): DashboardRuntimeWidgetConfig {
  const base = {
    description: common.description,
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
      columns: config.columns ?? [],
      description: common.description,
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
  options: { preserveVisualizationRequest?: boolean } = {},
): DashboardRuntimeWidgetConfig {
  if (!widget) return config;

  const source = configRecord(widget.config);
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

function cloneDatasetRows(dataset: DashboardDatasetOption | null | undefined) {
  return dataset?.rows?.map((row) => ({ ...row }));
}

export function WidgetConfigPanel({
  datasets = [],
  editingWidget = null,
  focusedColorSlot = null,
  isCreating = false,
  isUpdating = false,
  onCreateWidget,
  onPreviewWidgetChange,
  onSelectDataset,
  onUpdateWidget,
  selectedDataset,
  selectedDatasetId,
}: {
  datasets?: DashboardDatasetOption[];
  editingWidget?: DashboardRuntimeWidget | null;
  focusedColorSlot?: DashboardWidgetColorSlotFocus | null;
  isCreating?: boolean;
  isUpdating?: boolean;
  onCreateWidget: (input: CreateDraftWidgetFormInput) => Promise<void> | void;
  onPreviewWidgetChange?: (widget: DashboardRuntimeWidget | null) => void;
  onSelectDataset?: (datasetId: string) => void;
  onUpdateWidget?: (widgetId: string, input: UpdateDraftWidgetFormInput) => Promise<void> | void;
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
  const [widgetTypeTooltip, setWidgetTypeTooltip] = useState<WidgetTypeTooltip | null>(null);
  const previousEditingWidgetIdRef = useRef<string | null>(null);
  const previousSelectedDatasetIdRef = useRef<string | null>(null);
  const isEditMode = Boolean(editingWidget);
  const isVisualizationRequestEdit = isVisualizationRequestWidget(editingWidget);

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
      setConfigsByType({
        ...defaultConfigs,
        [editingWidget.type]: isVisualizationRequestWidget(editingWidget)
          ? defaultConfigs[editingWidget.type] ?? {}
          : configDraftFromWidget(editingWidget),
      });
      return;
    }

    setColor(defaultWidgetColorConfig);
    setDescription("");
    setTitle("");
    setType("bar_chart");
    setConfigsByType(selectedDataset ? createDefaultConfigs(selectedDataset) : {});
  }, [editingWidget, selectedDataset]);

  const currentConfig = configsByType[type] ?? {};
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
    ? validateConfig(type, currentConfig)
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
        { preserveVisualizationRequest: true },
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

    const error = validateConfig(type, currentConfig);
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
        data: cloneDatasetRows(selectedDataset),
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
      data: cloneDatasetRows(selectedDataset),
      datasetId: selectedDatasetId,
    });
    setTitle("");
    setDescription("");
  };

  if (!selectedDataset && !editingWidget) {
    return (
      <SettingsPanel
        className="asklake-widget-config-panel empty"
        description="왼쪽에서 데이터셋을 선택하면 위젯 설정을 만들 수 있습니다."
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
            <strong>{isEditMode ? editingWidget?.title || "제목 없는 위젯" : selectedDataset?.name}</strong>
          </div>
        </div>
      )}
    >
      <form className="asklake-widget-config-form" onSubmit={(event) => void handleSubmit(event)}>
        {shouldShowDatasetSelect ? (
          <WidgetSelectField
            fieldClassName="asklake-widget-dataset-field"
            label="데이터셋"
            disabled={!datasets.length || !onSelectDataset}
            value={selectedDatasetId ?? ""}
            onChange={(event) => {
              if (event.target.value) onSelectDataset?.(event.target.value);
            }}
          >
            <option value="">데이터셋 선택</option>
            {datasets.map((dataset) => (
              <option key={dataset.id} value={dataset.id}>
                {dataset.name}
              </option>
            ))}
          </WidgetSelectField>
        ) : null}
        <FormFieldGroup label="위젯 제목">
          <Input
            size="sm"
            placeholder="제목 없는 위젯"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </FormFieldGroup>

        <FormFieldGroup label="설명">
          <textarea
            placeholder="이 위젯에 대한 설명을 짧게 적어주세요."
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </FormFieldGroup>

        <div className="asklake-widget-type-field">
          <span>위젯 타입</span>
          <IconOptionGrid
            ariaLabel="위젯 타입"
            buttonClassName="asklake-widget-type-button"
            className="asklake-widget-type-grid"
            items={dashboardWidgetTypeOptions.map((option) => {
              const definition = dashboardWidgetDefinitions[option.value];
              const Icon = widgetTypeIcons[option.value];
              return {
                description: definition.description,
                icon: <Icon aria-hidden="true" size={18} strokeWidth={2.3} />,
                label: definition.label,
                value: option.value,
              };
            })}
            value={type}
            onOptionBlur={() => setWidgetTypeTooltip(null)}
            onOptionFocus={(event, option) => setWidgetTypeTooltip(createWidgetTypeTooltip(event.currentTarget, `${option.label}: ${option.description}`))}
            onOptionMouseEnter={(event, option) => setWidgetTypeTooltip(createWidgetTypeTooltip(event.currentTarget, `${option.label}: ${option.description}`))}
            onOptionMouseLeave={() => setWidgetTypeTooltip(null)}
            onValueChange={(nextType) => {
              setCustomColorIndex(0);
              setType(nextType);
            }}
          />
        </div>

        <ColorPalettePicker
          activeColor={activeCustomColor}
          choiceListAriaLabel={`${colorSlotLabels[customColorIndex] ?? "선택 색상"} 색상 선택`}
          choices={dashboardWidgetColorChoices}
          colors={activeColors}
          customOpen={customColorOpen}
          customPanel={(
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
          helperText={colorSlotLabels.length === 1
            ? "선택한 색상 하나가 차트에 적용됩니다."
            : "위 항목을 하나씩 선택해서 각 요소의 색상을 바꿀 수 있습니다."}
          selectedSlotIndex={customColorIndex}
          slotLabels={colorSlotLabels}
          onSelectChoice={(choice) => {
            setCustomColorOpen(false);
            updateColorSlot(customColorIndex, choice);
          }}
          onSelectSlot={setCustomColorIndex}
          onToggleCustom={() => setCustomColorOpen((open) => !open)}
        />

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
                  <input
                    checked={(currentConfig.columns ?? []).includes(column.name)}
                    type="checkbox"
                    onChange={() => toggleTableColumn(column.name)}
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
            <WidgetSelectField label="X축" value={currentConfig.xKey ?? ""} onChange={(event) => patchCurrentConfig({ xKey: event.target.value })}>
                {columnGroups.allColumns.map((column) => (
                  <option key={column.name} value={column.name}>{column.name}</option>
                ))}
            </WidgetSelectField>
            <WidgetSelectField label="Y축" value={currentConfig.yKey ?? ""} onChange={(event) => patchCurrentConfig({ yKey: event.target.value })}>
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
                <WidgetSelectField label="방향" value={currentConfig.orientation ?? "vertical"} onChange={(event) => patchCurrentConfig({ orientation: event.target.value as DashboardWidgetOrientation })}>
                    {orientationOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
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
              <WidgetSelectField label="날짜 단위" value={currentConfig.dateUnit ?? "month"} onChange={(event) => patchCurrentConfig({ dateUnit: event.target.value as DashboardWidgetDateUnit })}>
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
                <input
                  checked={currentConfig.stacked ?? false}
                  type="checkbox"
                  onChange={(event) => patchCurrentConfig({ stacked: event.target.checked })}
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
            <FormFieldGroup label="최솟값">
              <Input size="sm" type="number" value={currentConfig.min ?? 0} onChange={(event) => patchCurrentConfig({ min: Number(event.target.value) || 0 })} />
            </FormFieldGroup>
            <FormFieldGroup label="최댓값">
              <Input size="sm" type="number" value={currentConfig.max ?? 100} onChange={(event) => patchCurrentConfig({ max: Number(event.target.value) || 100 })} />
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

        {(formError || validationMessage) && <p className="asklake-widget-config-error">{formError ?? validationMessage}</p>}

        <div className="asklake-widget-config-actions">
          <Button className="asklake-widget-create-button" disabled={!canSubmit || isCreating || isUpdating} type="submit">
            {isEditMode ? (isUpdating ? "저장 중" : "변경사항 저장") : (isCreating ? "생성 중" : "위젯 생성")}
          </Button>
        </div>
      </form>
      {widgetTypeTooltip && typeof document !== "undefined" && createPortal(
        <div
          className="asklake-widget-type-tooltip-layer"
          role="tooltip"
          style={{
            left: widgetTypeTooltip.left,
            top: widgetTypeTooltip.top,
          }}
        >
          {widgetTypeTooltip.text}
        </div>,
        document.body,
      )}
    </SettingsPanel>
  );
}
