import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  DashboardRuntimeWidget,
  DashboardRuntimeWidgetConfig,
  DashboardRuntimeWidgetType,
  DashboardWidgetAggregation,
  DashboardWidgetDateUnit,
  DashboardWidgetFormat,
  DashboardWidgetSortDirection,
} from "../../../types";
import type { CreateDraftWidgetFormInput, DashboardDatasetColumn, DashboardDatasetOption, UpdateDraftWidgetFormInput } from "./dashboardRuntimeTypes";

type WidgetConfigDraft = {
  aggregation?: DashboardWidgetAggregation;
  columns?: string[];
  dateUnit?: DashboardWidgetDateUnit;
  format?: DashboardWidgetFormat;
  labelKey?: string;
  limit?: number;
  sortDirection?: DashboardWidgetSortDirection;
  sortKey?: string;
  valueKey?: string;
  xKey?: string;
  yKey?: string;
};

const widgetTypeOptions: Array<{ label: string; value: DashboardRuntimeWidgetType }> = [
  { label: "지표", value: "metric" },
  { label: "테이블", value: "table" },
  { label: "막대 차트", value: "bar_chart" },
  { label: "라인 차트", value: "line_chart" },
  { label: "도넛 차트", value: "donut_chart" },
];

const colorOptions = [
  { label: "Blue", value: "blue" },
  { label: "Green", value: "green" },
  { label: "Slate", value: "slate" },
  { label: "Amber", value: "amber" },
];

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

function configDraftFromWidget(widget: DashboardRuntimeWidget): WidgetConfigDraft {
  const config = widget.config;
  return {
    aggregation: configString(config, "aggregation") as DashboardWidgetAggregation | undefined,
    columns: configStringArray(config, "columns"),
    dateUnit: configString(config, "dateUnit") as DashboardWidgetDateUnit | undefined,
    format: configString(config, "format") as DashboardWidgetFormat | undefined,
    labelKey: configString(config, "labelKey"),
    limit: configNumber(config, "limit"),
    sortDirection: configString(config, "sortDirection") as DashboardWidgetSortDirection | undefined,
    sortKey: configString(config, "sortKey"),
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

  return {
    bar_chart: {
      aggregation: "sum",
      xKey: firstName(dimensionColumns),
      yKey: firstName(numericColumns),
    },
    donut_chart: {
      aggregation: "sum",
      labelKey: firstName(categoricalColumns.length ? categoricalColumns : dimensionColumns),
      valueKey: firstName(numericColumns),
    },
    line_chart: {
      aggregation: "sum",
      dateUnit: timeColumns.length ? "month" : undefined,
      xKey: firstName(lineXAxisColumns),
      yKey: firstName(numericColumns),
    },
    metric: {
      aggregation: "sum",
      format: "number",
      valueKey: firstName(numericColumns),
    },
    table: {
      columns: tableColumns,
      limit: 100,
      sortDirection: "asc",
      sortKey: tableColumns[0] ?? "",
    },
  };
}

function validateConfig(type: DashboardRuntimeWidgetType, config: WidgetConfigDraft) {
  if (type === "metric" && !config.valueKey) return "값 컬럼을 선택해 주세요.";
  if (type === "table" && (!config.columns || config.columns.length === 0)) return "표시할 컬럼을 1개 이상 선택해 주세요.";
  if ((type === "bar_chart" || type === "line_chart") && (!config.xKey || !config.yKey)) {
    return "X축과 Y축 컬럼을 선택해 주세요.";
  }
  if (type === "donut_chart" && (!config.labelKey || !config.valueKey)) return "분류와 값 컬럼을 선택해 주세요.";
  return null;
}

function buildConfig(
  type: DashboardRuntimeWidgetType,
  config: WidgetConfigDraft,
  common: { color: string; description?: string },
): DashboardRuntimeWidgetConfig {
  const base = {
    color: common.color,
    description: common.description,
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
      ...base,
      aggregation: config.aggregation ?? "sum",
      dateUnit: config.dateUnit,
      xKey: config.xKey ?? "",
      yKey: config.yKey ?? "",
    };
  }

  if (type === "donut_chart") {
    return {
      ...base,
      aggregation: config.aggregation ?? "sum",
      labelKey: config.labelKey ?? "",
      valueKey: config.valueKey ?? "",
    };
  }

  return {
    ...base,
    aggregation: config.aggregation ?? "sum",
    xKey: config.xKey ?? "",
    yKey: config.yKey ?? "",
  };
}

export function WidgetConfigPanel({
  editingWidget = null,
  isCreating = false,
  isUpdating = false,
  onCancelEdit,
  onCreateWidget,
  onUpdateWidget,
  selectedDataset,
  selectedDatasetId,
}: {
  editingWidget?: DashboardRuntimeWidget | null;
  isCreating?: boolean;
  isUpdating?: boolean;
  onCancelEdit?: () => void;
  onCreateWidget: (input: CreateDraftWidgetFormInput) => Promise<void> | void;
  onUpdateWidget?: (widgetId: string, input: UpdateDraftWidgetFormInput) => Promise<void> | void;
  selectedDataset: DashboardDatasetOption | null;
  selectedDatasetId: string | null;
}) {
  const [color, setColor] = useState("blue");
  const [configsByType, setConfigsByType] = useState<Partial<Record<DashboardRuntimeWidgetType, WidgetConfigDraft>>>({});
  const [description, setDescription] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [type, setType] = useState<DashboardRuntimeWidgetType>("bar_chart");
  const isEditMode = Boolean(editingWidget);

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
    setFormError(null);
    if (editingWidget) {
      setType(editingWidget.type);
      setTitle(editingWidget.title ?? "");
      setDescription(configString(editingWidget.config, "description") ?? "");
      setColor(configString(editingWidget.config, "color") ?? "blue");
      setConfigsByType({
        ...(selectedDataset ? createDefaultConfigs(selectedDataset) : {}),
        [editingWidget.type]: configDraftFromWidget(editingWidget),
      });
      return;
    }

    setColor("blue");
    setDescription("");
    setTitle("");
    setType("bar_chart");
    setConfigsByType(selectedDataset ? createDefaultConfigs(selectedDataset) : {});
  }, [editingWidget, selectedDataset]);

  const currentConfig = configsByType[type] ?? {};
  const validationMessage = selectedDataset || isEditMode
    ? validateConfig(type, currentConfig)
    : "왼쪽에서 Gold 데이터셋을 먼저 선택해 주세요.";
  const canSubmit = Boolean((isEditMode || (selectedDatasetId && selectedDataset)) && !validationMessage);

  const patchCurrentConfig = (patch: WidgetConfigDraft) => {
    setConfigsByType((current) => ({
      ...current,
      [type]: {
        ...(current[type] ?? {}),
        ...patch,
      },
    }));
  };

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
    if (!isEditMode && (!selectedDataset || !selectedDatasetId)) {
      setFormError("왼쪽에서 Gold 데이터셋을 먼저 선택해 주세요.");
      return;
    }

    const error = validateConfig(type, currentConfig);
    if (error) {
      setFormError(error);
      return;
    }

    setFormError(null);
    const nextInput = {
      config: buildConfig(type, currentConfig, {
        color,
        description: description.trim() || undefined,
      }),
      title: title.trim() || "제목 없는 위젯",
      type,
    };

    if (editingWidget && onUpdateWidget) {
      await onUpdateWidget(editingWidget.id, {
        ...nextInput,
        datasetId: selectedDatasetId ?? editingWidget.datasetId ?? null,
      });
      return;
    }

    if (!selectedDatasetId) {
      setFormError("왼쪽에서 Gold 데이터셋을 먼저 선택해 주세요.");
      return;
    }

    await onCreateWidget({
      ...nextInput,
      datasetId: selectedDatasetId,
    });
    setTitle("");
    setDescription("");
  };

  if (!selectedDataset && !editingWidget) {
    return (
      <section className="asklake-widget-config-panel empty">
        <strong>데이터셋을 선택해 주세요</strong>
        <span>왼쪽에서 Gold 데이터셋을 선택하면 위젯 설정을 만들 수 있습니다.</span>
      </section>
    );
  }

  return (
    <section className="asklake-widget-config-panel">
      <div className="asklake-widget-config-heading">
        <div>
          <span>{isEditMode ? "Selected widget" : "Dataset widget"}</span>
          <strong>{isEditMode ? editingWidget?.title || "제목 없는 위젯" : selectedDataset?.name}</strong>
        </div>
      </div>

      <form className="asklake-widget-config-form" onSubmit={(event) => void handleSubmit(event)}>
        <label>
          <span>위젯 제목</span>
          <input
            placeholder="제목 없는 위젯"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        <label>
          <span>설명</span>
          <textarea
            placeholder="이 위젯이 보여줄 지표를 짧게 적어주세요."
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>

        <label>
          <span>위젯 타입</span>
          <select value={type} onChange={(event) => setType(event.target.value as DashboardRuntimeWidgetType)}>
            {widgetTypeOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>

        <label>
          <span>색상</span>
          <select value={color} onChange={(event) => setColor(event.target.value)}>
            {colorOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>

        {type === "metric" && (
          <>
            <label>
              <span>값</span>
              <select value={currentConfig.valueKey ?? ""} onChange={(event) => patchCurrentConfig({ valueKey: event.target.value })}>
                {columnGroups.numericColumns.map((column) => (
                  <option key={column.name} value={column.name}>{column.name}</option>
                ))}
              </select>
            </label>
            <label>
              <span>집계 방식</span>
              <select value={currentConfig.aggregation ?? "sum"} onChange={(event) => patchCurrentConfig({ aggregation: event.target.value as DashboardWidgetAggregation })}>
                {aggregationOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>표시 형식</span>
              <select value={currentConfig.format ?? "number"} onChange={(event) => patchCurrentConfig({ format: event.target.value as DashboardWidgetFormat })}>
                {formatOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
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
            <label>
              <span>기본 정렬 컬럼</span>
              <select value={currentConfig.sortKey ?? ""} onChange={(event) => patchCurrentConfig({ sortKey: event.target.value })}>
                <option value="">선택 안 함</option>
                {(currentConfig.columns ?? []).map((column) => (
                  <option key={column} value={column}>{column}</option>
                ))}
              </select>
            </label>
            <label>
              <span>정렬 방향</span>
              <select value={currentConfig.sortDirection ?? "asc"} onChange={(event) => patchCurrentConfig({ sortDirection: event.target.value as DashboardWidgetSortDirection })}>
                <option value="asc">오름차순</option>
                <option value="desc">내림차순</option>
              </select>
            </label>
            <label>
              <span>행 개수 제한</span>
              <input
                min={1}
                type="number"
                value={currentConfig.limit ?? 100}
                onChange={(event) => patchCurrentConfig({ limit: Number(event.target.value) || 100 })}
              />
            </label>
          </>
        )}

        {(type === "bar_chart" || type === "line_chart") && (
          <>
            <label>
              <span>X축</span>
              <select value={currentConfig.xKey ?? ""} onChange={(event) => patchCurrentConfig({ xKey: event.target.value })}>
                {(type === "line_chart" ? columnGroups.lineXAxisColumns : columnGroups.dimensionColumns).map((column) => (
                  <option key={column.name} value={column.name}>{column.name}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Y축</span>
              <select value={currentConfig.yKey ?? ""} onChange={(event) => patchCurrentConfig({ yKey: event.target.value })}>
                {columnGroups.numericColumns.map((column) => (
                  <option key={column.name} value={column.name}>{column.name}</option>
                ))}
              </select>
            </label>
            <label>
              <span>집계 방식</span>
              <select value={currentConfig.aggregation ?? "sum"} onChange={(event) => patchCurrentConfig({ aggregation: event.target.value as DashboardWidgetAggregation })}>
                {aggregationOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            {type === "line_chart" && (
              <label>
                <span>날짜 단위</span>
                <select value={currentConfig.dateUnit ?? "month"} onChange={(event) => patchCurrentConfig({ dateUnit: event.target.value as DashboardWidgetDateUnit })}>
                  {dateUnitOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}

        {type === "donut_chart" && (
          <>
            <label>
              <span>분류</span>
              <select value={currentConfig.labelKey ?? ""} onChange={(event) => patchCurrentConfig({ labelKey: event.target.value })}>
                {(columnGroups.categoricalColumns.length ? columnGroups.categoricalColumns : columnGroups.dimensionColumns).map((column) => (
                  <option key={column.name} value={column.name}>{column.name}</option>
                ))}
              </select>
            </label>
            <label>
              <span>값</span>
              <select value={currentConfig.valueKey ?? ""} onChange={(event) => patchCurrentConfig({ valueKey: event.target.value })}>
                {columnGroups.numericColumns.map((column) => (
                  <option key={column.name} value={column.name}>{column.name}</option>
                ))}
              </select>
            </label>
            <label>
              <span>집계 방식</span>
              <select value={currentConfig.aggregation ?? "sum"} onChange={(event) => patchCurrentConfig({ aggregation: event.target.value as DashboardWidgetAggregation })}>
                {donutAggregationOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          </>
        )}

        {(formError || validationMessage) && <p className="asklake-widget-config-error">{formError ?? validationMessage}</p>}

        <div className="asklake-widget-config-actions">
          {isEditMode && (
            <button className="asklake-widget-secondary-button" type="button" onClick={onCancelEdit}>
              새 위젯 만들기
            </button>
          )}
          <button className="asklake-widget-create-button" disabled={!canSubmit || isCreating || isUpdating} type="submit">
            {isEditMode ? (isUpdating ? "저장 중" : "변경사항 저장") : (isCreating ? "생성 중" : "위젯 생성")}
          </button>
        </div>
      </form>
    </section>
  );
}
