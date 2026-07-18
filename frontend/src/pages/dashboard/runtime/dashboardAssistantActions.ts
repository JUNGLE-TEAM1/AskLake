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
  onCreateWidget?: (input: CreateDraftWidgetFormInput) => Promise<void | boolean> | void;
  onUpdateWidget?: (widgetId: string, input: UpdateDraftWidgetFormInput) => Promise<void | boolean> | void;
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
  onCreateWidget?: (input: CreateDraftWidgetFormInput) => Promise<void | boolean> | void,
) {
  if (!onCreateWidget) throw new Error("위젯 생성 함수가 연결되지 않아 새 위젯을 추가하지 못했습니다.");
  const applied = await onCreateWidget({
    config: action.widget.config,
    datasetId: action.widget.datasetId,
    title: action.widget.title || "AI 추천 위젯",
    type: action.widget.type,
  });
  if (applied === false) throw new Error("위젯 생성 저장에 실패했습니다. 화면의 오류를 확인해 주세요.");
  return "AI가 제안한 위젯을 추가했습니다.";
}

async function applyUpdateWidgetAction(
  action: DashboardAssistantUpdateWidgetAction,
  datasets: DashboardDatasetOption[],
  widgets: DashboardRuntimeWidget[],
  onUpdateWidget?: (widgetId: string, input: UpdateDraftWidgetFormInput) => Promise<void | boolean> | void,
) {
  if (!onUpdateWidget) throw new Error("위젯 수정 함수가 연결되지 않아 변경사항을 적용하지 못했습니다.");

  const currentWidget = widgets.find((widget) => widget.id === action.widgetId);
  if (!currentWidget && (!action.patch.type || !action.patch.config)) {
    throw new Error("수정 대상 위젯을 찾지 못해 변경사항을 적용하지 못했습니다.");
  }

  const nextDatasetId = action.patch.datasetId ?? currentWidget?.datasetId ?? null;
  const nextRows = nextDatasetId ? datasets.find((dataset) => dataset.id === nextDatasetId)?.rows : undefined;

  const applied = await onUpdateWidget(action.widgetId, {
    config: {
      ...(currentWidget?.config ?? {}),
      ...(action.patch.config ?? {}),
    } as UpdateDraftWidgetFormInput["config"],
    data: nextRows?.length ? nextRows.map((row) => ({ ...row })) : undefined,
    datasetId: nextDatasetId,
    title: action.patch.title ?? currentWidget?.title ?? "제목 없는 위젯",
    type: action.patch.type ?? currentWidget?.type ?? "bar_chart",
  });
  if (applied === false) throw new Error("위젯 변경사항 저장에 실패했습니다. 화면의 오류를 확인해 주세요.");
  return "AI가 제안한 위젯 변경사항을 적용했습니다.";
}
