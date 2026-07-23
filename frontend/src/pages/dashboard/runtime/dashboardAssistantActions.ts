import type { DashboardRuntimeWidget } from "../../../types";
import type {
  DashboardAssistantCreateWidgetAction,
  DashboardAssistantResponse,
  DashboardAssistantUpdateWidgetAction,
} from "../../../services/dashboardAssistantService";
import type {
  CreateDraftWidgetFormInput,
  DashboardDatasetOption,
  UpdateDraftWidgetFormInput,
} from "./dashboardRuntimeTypes";

type DashboardAssistantActionHandlers = {
  datasets: DashboardDatasetOption[];
  onCreateWidget?: (input: CreateDraftWidgetFormInput) => Promise<boolean>;
  onUpdateWidget?: (widgetId: string, input: UpdateDraftWidgetFormInput) => Promise<boolean>;
  response: DashboardAssistantResponse;
  widgets: DashboardRuntimeWidget[];
};

export async function applyAssistantWidgetActions({
  datasets,
  onCreateWidget,
  onUpdateWidget,
  response,
  widgets,
}: DashboardAssistantActionHandlers) {
  const messages: string[] = [];
  const mutationActionCount = response.actions.filter(
    (action) => action.type === "create_widget" || action.type === "update_widget",
  ).length;
  if (mutationActionCount > 1) {
    throw new Error("AI가 여러 위젯 변경을 동시에 반환해 안전하게 적용하지 않았습니다.");
  }

  for (const action of response.actions) {
    if (action.type === "report") continue;

    if (action.type === "create_widget") {
      const result = await applyCreateWidgetAction(action, onCreateWidget);
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

export function hasWidgetMutationAction(response: DashboardAssistantResponse) {
  return response.actions.some((action) => action.type === "create_widget" || action.type === "update_widget");
}

async function applyCreateWidgetAction(
  action: DashboardAssistantCreateWidgetAction,
  onCreateWidget?: (input: CreateDraftWidgetFormInput) => Promise<boolean>,
) {
  if (!onCreateWidget) throw new Error("위젯 생성 함수가 연결되지 않아 새 위젯을 추가하지 못했습니다.");
  const applied = await onCreateWidget({
    config: action.widget.config,
    datasetId: action.widget.datasetId,
    title: action.widget.title || "AI 추천 위젯",
    type: action.widget.type,
  });
  if (applied !== true) throw new Error("위젯 생성 저장에 실패했습니다. 화면의 오류를 확인해 주세요.");
  return "AI가 제안한 위젯을 추가했습니다.";
}

async function applyUpdateWidgetAction(
  action: DashboardAssistantUpdateWidgetAction,
  datasets: DashboardDatasetOption[],
  widgets: DashboardRuntimeWidget[],
  onUpdateWidget?: (widgetId: string, input: UpdateDraftWidgetFormInput) => Promise<boolean>,
) {
  if (!onUpdateWidget) throw new Error("위젯 수정 함수가 연결되지 않아 변경사항을 적용하지 못했습니다.");

  const currentWidget = widgets.find((widget) => widget.id === action.widgetId);
  if (!currentWidget) {
    throw new Error("수정 대상 위젯을 찾지 못해 변경사항을 적용하지 못했습니다.");
  }

  const nextDatasetId = action.patch.datasetId ?? currentWidget.datasetId ?? null;
  const nextRows = nextDatasetId ? datasets.find((dataset) => dataset.id === nextDatasetId)?.rows : undefined;
  const changesWidgetType = action.patch.type !== undefined && action.patch.type !== currentWidget.type;
  if (changesWidgetType && action.patch.config === undefined) {
    throw new Error("AI 위젯 타입 변경에는 새 타입의 전체 설정이 필요합니다.");
  }
  const nextConfig = (changesWidgetType
    ? { ...(action.patch.config ?? {}) }
    : {
        ...currentWidget.config,
        ...(action.patch.config ?? {}),
      }) as UpdateDraftWidgetFormInput["config"];
  const nextTitle = action.patch.title ?? currentWidget.title ?? "제목 없는 위젯";
  const nextType = action.patch.type ?? currentWidget.type;

  if (
    nextDatasetId === (currentWidget.datasetId ?? null)
    && nextTitle === (currentWidget.title ?? "제목 없는 위젯")
    && nextType === currentWidget.type
    && stableJson(nextConfig) === stableJson(currentWidget.config)
  ) {
    throw new Error("AI가 제안한 위젯 수정에 실제 변경사항이 없습니다.");
  }

  const applied = await onUpdateWidget(action.widgetId, {
    config: nextConfig,
    data: nextRows?.length ? nextRows.map((row) => ({ ...row })) : undefined,
    datasetId: nextDatasetId,
    title: nextTitle,
    type: nextType,
  });
  if (applied !== true) throw new Error("위젯 변경사항 저장에 실패했습니다. 화면의 오류를 확인해 주세요.");
  return "AI가 제안한 위젯 변경사항을 적용했습니다.";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
