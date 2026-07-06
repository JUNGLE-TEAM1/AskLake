import { useMemo, useState, type FormEvent } from "react";
import { Loader2, Send } from "lucide-react";
import type { DashboardRuntimeWidget } from "../../../types";
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
import type { CreateDraftWidgetFormInput, UpdateDraftWidgetFormInput } from "./dashboardRuntimeTypes";

type DashboardAssistantPanelProps = {
  dashboardId?: string;
  onCreateWidget?: (input: CreateDraftWidgetFormInput) => Promise<void> | void;
  onUpdateWidget?: (widgetId: string, input: UpdateDraftWidgetFormInput) => Promise<void> | void;
  pageId: string | null;
  selectedWidget: DashboardRuntimeWidget | null;
  widgets: DashboardRuntimeWidget[];
};

type AssistantMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
};

function AskLakeAssistantMark() {
  return <img alt="" aria-hidden="true" className="asklake-assistant-mark" src={askLakeNessiIconUrl} />;
}

export function DashboardAssistantPanel({
  dashboardId,
  onCreateWidget,
  onUpdateWidget,
  pageId,
  selectedWidget,
  widgets,
}: DashboardAssistantPanelProps) {
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const isConfigured = isDashboardAssistantConfigured();
  const targetWidgets = useMemo(() => {
    return selectedWidget ? [selectedWidget] : widgets;
  }, [selectedWidget, widgets]);

  const submitQuestion = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
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

  return (
    <section className="asklake-assistant-panel" aria-label="AskLake Assistant">
      <div className="asklake-assistant-chat">
        <div className="asklake-assistant-hero">
          <AskLakeAssistantMark />
          <strong>AskLake</strong>
          <span>AI로 질문하세요</span>
        </div>

        {messages.length > 0 && (
          <div className="asklake-assistant-messages" aria-live="polite">
            {messages.map((message) => (
              <p className={message.role} key={message.id}>{message.text}</p>
            ))}
          </div>
        )}
      </div>

      <form className="asklake-assistant-form" onSubmit={(event) => void submitQuestion(event)}>
        <textarea
          aria-label="AskLake 질문"
          placeholder="AskLake에게 질문하세요."
          rows={3}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <button aria-label="질문 보내기" disabled={!prompt.trim() || isSubmitting} type="submit">
          {isSubmitting ? <Loader2 className="spin" size={16} /> : <Send size={16} />}
        </button>
      </form>

      {error && <span className="asklake-assistant-error">{error}</span>}
    </section>
  );
}

async function applyAssistantWidgetActions({
  onCreateWidget,
  onUpdateWidget,
  response,
  widgets,
}: {
  onCreateWidget?: (input: CreateDraftWidgetFormInput) => Promise<void> | void;
  onUpdateWidget?: (widgetId: string, input: UpdateDraftWidgetFormInput) => Promise<void> | void;
  response: DashboardAssistantResponse;
  widgets: DashboardRuntimeWidget[];
}) {
  const messages: string[] = [];

  for (const action of response.actions) {
    if (action.type === "report") continue;

    if (action.type === "create_widget") {
      const result = await applyCreateWidgetAction(action, onCreateWidget);
      if (result) messages.push(result);
      continue;
    }

    if (action.type === "update_widget") {
      const result = await applyUpdateWidgetAction(action, widgets, onUpdateWidget);
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
  onCreateWidget?: (input: CreateDraftWidgetFormInput) => Promise<void> | void,
) {
  if (!onCreateWidget) return "위젯 생성 함수가 연결되지 않아 새 위젯을 추가하지 못했습니다.";
  await onCreateWidget({
    config: action.widget.config,
    datasetId: action.widget.datasetId,
    title: action.widget.title || "AI 추천 위젯",
    type: action.widget.type,
  });
  return "AI가 제안한 위젯을 추가했습니다.";
}

async function applyUpdateWidgetAction(
  action: DashboardAssistantUpdateWidgetAction,
  widgets: DashboardRuntimeWidget[],
  onUpdateWidget?: (widgetId: string, input: UpdateDraftWidgetFormInput) => Promise<void> | void,
) {
  if (!onUpdateWidget) return "위젯 수정 함수가 연결되지 않아 변경사항을 적용하지 못했습니다.";

  const currentWidget = widgets.find((widget) => widget.id === action.widgetId);
  if (!currentWidget && (!action.patch.type || !action.patch.config)) {
    return "수정 대상 위젯을 찾지 못해 변경사항을 적용하지 못했습니다.";
  }

  await onUpdateWidget(action.widgetId, {
    config: {
      ...(currentWidget?.config ?? {}),
      ...(action.patch.config ?? {}),
    } as UpdateDraftWidgetFormInput["config"],
    datasetId: action.patch.datasetId ?? currentWidget?.datasetId ?? null,
    title: action.patch.title ?? currentWidget?.title ?? "제목 없는 위젯",
    type: action.patch.type ?? currentWidget?.type ?? "bar_chart",
  });
  return "AI가 제안한 위젯 변경사항을 적용했습니다.";
}
