import { useEffect, useMemo, useRef, useState } from "react";
import { Bubble, BubbleContent, BubbleGroup } from "@/components/ui/bubble";
import type { DashboardRuntimeWidget, DashboardRuntimeWidgetConfig } from "../../../types";
import {
  type DashboardAssistantCreateWidgetAction,
  buildDashboardAssistantWidgetContext,
  dashboardAssistantEndpointLabel,
  type DashboardAssistantReportAction,
  type DashboardAssistantResponse,
  type DashboardAssistantUpdateWidgetAction,
  isDashboardAssistantConfigured,
  requestDashboardAssistant,
} from "../../../services/dashboardAssistantService";
import askLakeNessiIconUrl from "../../../assets/asklake-nessi-icon.png";
import type { CreateDraftWidgetFormInput, DashboardDatasetOption, UpdateDraftWidgetFormInput } from "./dashboardRuntimeTypes";
import { VisualizationPromptInput, type VisualizationPromptInputHandle } from "./VisualizationPromptInput";

type DashboardAssistantPanelProps = {
  dashboardId?: string;
  datasets: DashboardDatasetOption[];
  onCreateWidget?: (input: CreateDraftWidgetFormInput) => Promise<void> | void;
  onUpdateWidget?: (widgetId: string, input: UpdateDraftWidgetFormInput) => Promise<void> | void;
  pageId: string | null;
  promptInsertion?: DashboardAssistantPromptInsertion | null;
  selectedWidget: DashboardRuntimeWidget | null;
  widgets: DashboardRuntimeWidget[];
};

export type DashboardAssistantPromptInsertion = {
  id: number;
  text: string;
};

type AssistantMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
};

function AskLakeAssistantMark() {
  return <img alt="" aria-hidden="true" className="asklake-assistant-mark" src={askLakeNessiIconUrl} />;
}

function appendPromptText(currentPrompt: string, nextText: string) {
  const current = currentPrompt.trim();
  const next = nextText.trim();
  if (!next) return currentPrompt;
  if (!current) return next;
  return `${current} ${next}`;
}

export function DashboardAssistantPanel({
  dashboardId,
  datasets,
  onCreateWidget,
  onUpdateWidget,
  pageId,
  promptInsertion,
  selectedWidget,
  widgets,
}: DashboardAssistantPanelProps) {
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const messagesEndRef = useRef<HTMLSpanElement | null>(null);
  const promptInputRef = useRef<VisualizationPromptInputHandle | null>(null);
  const isConfigured = isDashboardAssistantConfigured();
  const targetWidgets = useMemo(() => {
    return selectedWidget ? [selectedWidget] : widgets;
  }, [selectedWidget, widgets]);

  const submitQuestion = async () => {
    const nextPrompt = prompt.trim();
    if (!nextPrompt || isSubmitting) return;

    setError(null);
    setPrompt("");
    setMessages((current) => [
      ...current,
      { id: `user-${Date.now()}`, role: "user", text: nextPrompt },
    ]);

    if (!isConfigured) {
      setMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          text: `${dashboardAssistantEndpointLabel()} 설정 후 실제 LLM API로 전송됩니다.`,
        },
      ]);
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await requestDashboardAssistant({
        dashboardId,
        mode: "dashboard_question",
        pageId,
        prompt: nextPrompt,
        selectedWidgetId: selectedWidget?.id ?? null,
        widgets: targetWidgets.map(buildDashboardAssistantWidgetContext),
      });
      const reportAction = response.actions.find(
        (action): action is DashboardAssistantReportAction => action.type === "report",
      );
      const actionMessages = await applyAssistantWidgetActions({
        datasets,
        onCreateWidget,
        onUpdateWidget,
        response,
        widgets,
      });
      const warningMessage = response.warnings.length > 0
        ? `경고: ${response.warnings.join(" / ")}`
        : "";
      setMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          text: [
            reportAction?.markdown?.trim() || response.message?.trim() || "Assistant 요청을 보냈습니다.",
            ...actionMessages,
            warningMessage,
          ].filter(Boolean).join("\n\n"),
        },
      ]);
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "Assistant 요청에 실패했습니다.";
      setError(message);
      setMessages((current) => [
        ...current,
        { id: `assistant-error-${Date.now()}`, role: "assistant", text: message },
      ]);
    } finally {
      setIsSubmitting(false);
    }
  };

  const hasMessages = messages.length > 0;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  useEffect(() => {
    if (!promptInsertion) return;
    setPrompt((current) => appendPromptText(current, promptInsertion.text));
    promptInputRef.current?.focus();
  }, [promptInsertion]);

  return (
    <section
      aria-busy={isSubmitting || undefined}
      aria-label="AskLake Assistant"
      className={isSubmitting ? "asklake-assistant-panel is-working" : "asklake-assistant-panel"}
    >
      <div className={hasMessages ? "asklake-assistant-chat has-messages" : "asklake-assistant-chat"}>
        {!hasMessages && (
          <div className="asklake-assistant-hero">
            <AskLakeAssistantMark />
            <strong>AskLake</strong>
            <Bubble variant="secondary">
              <BubbleContent>대시보드에 대해 무엇이든 물어보세요.</BubbleContent>
            </Bubble>
          </div>
        )}

        {hasMessages && (
          <BubbleGroup aria-live="polite" className="asklake-assistant-messages">
            {messages.map((message) => (
              <Bubble
                align={message.role === "user" ? "end" : "start"}
                key={message.id}
                variant={message.role === "user" ? "default" : "secondary"}
              >
              <BubbleContent className="whitespace-pre-wrap">{message.text}</BubbleContent>
              </Bubble>
            ))}
            <span ref={messagesEndRef} aria-hidden="true" />
          </BubbleGroup>
        )}
      </div>

      {isSubmitting && (
        <div className="asklake-assistant-working-overlay" role="status" aria-live="polite">
          <AskLakeAssistantMark />
          <strong>Nessie가 답변을 준비하는 중</strong>
        </div>
      )}

      <VisualizationPromptInput
        ariaLabel="AskLake 질문"
        isSubmitting={isSubmitting}
        placeholder="AskLake에게 질문하세요."
        ref={promptInputRef}
        rows={3}
        submitAriaLabel="질문 보내기"
        textareaClassName="min-h-[72px] px-3 py-2 text-sm font-medium"
        value={prompt}
        onSubmit={() => void submitQuestion()}
        onValueChange={setPrompt}
      />

      {error && <span className="asklake-assistant-error">{error}</span>}
    </section>
  );
}

async function applyAssistantWidgetActions({
  datasets,
  onCreateWidget,
  onUpdateWidget,
  response,
  widgets,
}: {
  datasets: DashboardDatasetOption[];
  onCreateWidget?: (input: CreateDraftWidgetFormInput) => Promise<void> | void;
  onUpdateWidget?: (widgetId: string, input: UpdateDraftWidgetFormInput) => Promise<void> | void;
  response: DashboardAssistantResponse;
  widgets: DashboardRuntimeWidget[];
}) {
  const messages: string[] = [];

  for (const action of response.actions) {
    if (action.type === "report") continue;

    if (action.type === "create_widget") {
      const result = await applyCreateWidgetAction(action, datasets, onCreateWidget);
      if (result) messages.push(result);
      continue;
    }

    if (action.type === "update_widget") {
      const result = await applyUpdateWidgetAction(action, datasets, widgets, onUpdateWidget);
      if (result) messages.push(result);
    }
  }

  if (messages.length === 0 && response.actions.some((action) => action.type !== "report")) {
    messages.push("위젯 변경 action을 받았지만 화면에 적용하지 못했습니다.");
  }

  return messages;
}

async function applyCreateWidgetAction(
  action: DashboardAssistantCreateWidgetAction,
  datasets: DashboardDatasetOption[],
  onCreateWidget?: (input: CreateDraftWidgetFormInput) => Promise<void> | void,
) {
  if (!onCreateWidget) return "위젯 생성 함수가 연결되지 않아 새 위젯을 추가하지 못했습니다.";
  const dataset = resolveAssistantDataset(action.widget.datasetId, datasets);
  if (!dataset) return "사용 가능한 데이터소스가 없어 AI 추천 위젯을 추가하지 못했습니다.";
  await onCreateWidget({
    config: sanitizeAssistantWidgetConfig(action.widget.config, action.widget.type, dataset),
    data: cloneDatasetRows(dataset),
    datasetId: dataset.id,
    title: action.widget.title || "AI 추천 위젯",
    type: action.widget.type,
  });
  return "AI가 제안한 위젯을 추가했습니다.";
}

async function applyUpdateWidgetAction(
  action: DashboardAssistantUpdateWidgetAction,
  datasets: DashboardDatasetOption[],
  widgets: DashboardRuntimeWidget[],
  onUpdateWidget?: (widgetId: string, input: UpdateDraftWidgetFormInput) => Promise<void> | void,
) {
  if (!onUpdateWidget) return "위젯 수정 함수가 연결되지 않아 변경사항을 적용하지 못했습니다.";

  const currentWidget = widgets.find((widget) => widget.id === action.widgetId);
  if (!currentWidget && (!action.patch.type || !action.patch.config)) {
    return "수정 대상 위젯을 찾지 못해 변경사항을 적용하지 못했습니다.";
  }

  const dataset = resolveAssistantDataset(action.patch.datasetId ?? currentWidget?.datasetId ?? null, datasets);
  if (!dataset) return "사용 가능한 데이터소스가 없어 AI 추천 변경사항을 적용하지 못했습니다.";
  const nextType = action.patch.type ?? currentWidget?.type ?? "bar_chart";
  const nextConfig = sanitizeAssistantWidgetConfig({
    ...(currentWidget?.config ?? {}),
    ...(action.patch.config ?? {}),
  } as DashboardRuntimeWidgetConfig, nextType, dataset);

  await onUpdateWidget(action.widgetId, {
    config: nextConfig,
    data: cloneDatasetRows(dataset),
    datasetId: dataset.id,
    title: action.patch.title ?? currentWidget?.title ?? "제목 없는 위젯",
    type: nextType,
  });
  return "AI가 제안한 위젯 변경사항을 적용했습니다.";
}

function resolveAssistantDataset(datasetId: string | null | undefined, datasets: DashboardDatasetOption[]) {
  return datasets.find((dataset) => dataset.id === datasetId) ?? datasets[0] ?? null;
}

function cloneDatasetRows(dataset: DashboardDatasetOption) {
  return dataset.rows?.map((row) => ({ ...row }));
}

function firstColumn(columns: DashboardDatasetOption["columns"], current: unknown, allowEmpty = false) {
  if (typeof current === "string" && columns.some((column) => column.name === current)) return current;
  if (allowEmpty && !current) return "";
  return columns[0]?.name ?? "";
}

function sanitizeAssistantWidgetConfig(
  config: DashboardRuntimeWidgetConfig,
  type: DashboardRuntimeWidget["type"],
  dataset: DashboardDatasetOption,
): DashboardRuntimeWidgetConfig {
  const record = { ...(config as Record<string, unknown>) };
  const allColumns = dataset.columns;
  const numericColumns = allColumns.filter((column) => column.type === "number");
  const dimensionColumns = allColumns.filter((column) => column.type === "string" || column.type === "date");
  const categoryColumns = allColumns.filter((column) => column.type === "string");
  const usesCount = record.aggregation === "count";

  if (Array.isArray(record.columns)) {
    const columns = record.columns.filter((column): column is string => (
      typeof column === "string" && allColumns.some((datasetColumn) => datasetColumn.name === column)
    ));
    record.columns = columns.length ? columns : allColumns.slice(0, 5).map((column) => column.name);
  }
  if (typeof record.sortKey === "string" && !allColumns.some((column) => column.name === record.sortKey)) {
    record.sortKey = Array.isArray(record.columns) && typeof record.columns[0] === "string" ? record.columns[0] : undefined;
  }

  if (type === "metric") {
    record.valueKey = usesCount ? firstColumn(numericColumns, record.valueKey, true) : firstColumn(numericColumns, record.valueKey);
  } else if (type === "bar_chart") {
    record.xKey = firstColumn(allColumns, record.xKey);
    record.yKey = usesCount ? firstColumn(numericColumns, record.yKey, true) : firstColumn(numericColumns, record.yKey);
    record.groupKey = firstColumn(dimensionColumns, record.groupKey, true);
  } else if (type === "line_chart" || type === "area_chart") {
    const timeColumns = allColumns.filter((column) => column.type === "date");
    const xColumns = timeColumns.length ? timeColumns : dimensionColumns.length ? dimensionColumns : allColumns;
    record.xKey = firstColumn(xColumns, record.xKey);
    record.yKey = usesCount ? firstColumn(numericColumns, record.yKey, true) : firstColumn(numericColumns, record.yKey);
    record.seriesKey = firstColumn(dimensionColumns, record.seriesKey, true);
  } else if (type === "donut_chart" || type === "pie_chart" || type === "treemap_chart") {
    record.labelKey = firstColumn(categoryColumns.length ? categoryColumns : dimensionColumns, record.labelKey);
    record.valueKey = usesCount ? firstColumn(numericColumns, record.valueKey, true) : firstColumn(numericColumns, record.valueKey);
  } else if (type === "radial_bar_chart") {
    record.labelKey = firstColumn(dimensionColumns, record.labelKey, true);
    record.valueKey = usesCount ? firstColumn(numericColumns, record.valueKey, true) : firstColumn(numericColumns, record.valueKey);
  } else if (type === "heatmap_chart") {
    record.xKey = firstColumn(dimensionColumns, record.xKey);
    record.yKey = firstColumn(dimensionColumns, record.yKey);
    record.valueKey = usesCount ? firstColumn(numericColumns, record.valueKey, true) : firstColumn(numericColumns, record.valueKey);
  }

  return record as DashboardRuntimeWidgetConfig;
}
