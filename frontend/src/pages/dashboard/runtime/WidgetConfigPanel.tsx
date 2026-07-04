import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { DashboardRuntimeWidgetType } from "../../../types";
import type { CreateDraftWidgetFormInput, DashboardDatasetOption } from "./dashboardRuntimeTypes";

const widgetTypeOptions: Array<{ label: string; value: DashboardRuntimeWidgetType }> = [
  { label: "지표", value: "metric" },
  { label: "막대", value: "bar_chart" },
  { label: "라인", value: "line_chart" },
  { label: "도넛", value: "donut_chart" },
  { label: "테이블", value: "table" },
];

const colorOptions = [
  { label: "Blue", value: "blue" },
  { label: "Green", value: "green" },
  { label: "Slate", value: "slate" },
  { label: "Amber", value: "amber" },
];

function hasColumn(dataset: DashboardDatasetOption, key: string) {
  return dataset.columns.some((column) => column.name === key);
}

export function WidgetConfigPanel({
  isCreating = false,
  onCreateWidget,
  selectedDataset,
  selectedDatasetId,
}: {
  isCreating?: boolean;
  onCreateWidget: (input: CreateDraftWidgetFormInput) => Promise<void> | void;
  selectedDataset: DashboardDatasetOption | null;
  selectedDatasetId: string | null;
}) {
  const [color, setColor] = useState("blue");
  const [description, setDescription] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [type, setType] = useState<DashboardRuntimeWidgetType>("bar_chart");
  const [xKey, setXKey] = useState("");
  const [yKey, setYKey] = useState("");

  const xAxisColumns = useMemo(
    () => selectedDataset?.columns.filter((column) => column.type === "string" || column.type === "date") ?? [],
    [selectedDataset],
  );
  const yAxisColumns = useMemo(
    () => selectedDataset?.columns.filter((column) => column.type === "number") ?? [],
    [selectedDataset],
  );

  useEffect(() => {
    setFormError(null);
    if (!selectedDataset) {
      setXKey("");
      setYKey("");
      return;
    }

    setXKey(xAxisColumns[0]?.name ?? "");
    setYKey(yAxisColumns[0]?.name ?? "");
  }, [selectedDataset, xAxisColumns, yAxisColumns]);

  const canCreate = Boolean(selectedDatasetId && selectedDataset && xKey && yKey);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedDataset || !selectedDatasetId) {
      setFormError("왼쪽에서 Gold 데이터셋을 먼저 선택해 주세요.");
      return;
    }
    if (!xKey || !yKey || !hasColumn(selectedDataset, xKey) || !hasColumn(selectedDataset, yKey)) {
      setFormError("x축과 y축 컬럼을 다시 선택해 주세요.");
      return;
    }

    setFormError(null);
    await onCreateWidget({
      color,
      datasetId: selectedDatasetId,
      description: description.trim() || undefined,
      title: title.trim() || "제목 없는 위젯",
      type,
      xKey,
      yKey,
    });
    setTitle("");
    setDescription("");
  };

  if (!selectedDataset) {
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
          <span>Dataset widget</span>
          <strong>{selectedDataset.name}</strong>
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
          <span>차트 타입</span>
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

        <label>
          <span>x축</span>
          <select value={xKey} onChange={(event) => setXKey(event.target.value)}>
            {xAxisColumns.map((column) => (
              <option key={column.name} value={column.name}>{column.name}</option>
            ))}
          </select>
        </label>

        <label>
          <span>y축</span>
          <select value={yKey} onChange={(event) => setYKey(event.target.value)}>
            {yAxisColumns.map((column) => (
              <option key={column.name} value={column.name}>{column.name}</option>
            ))}
          </select>
        </label>

        {formError && <p className="asklake-widget-config-error">{formError}</p>}

        <button className="asklake-widget-create-button" disabled={!canCreate || isCreating} type="submit">
          {isCreating ? "생성 중" : "위젯 생성"}
        </button>
      </form>
    </section>
  );
}
