import { useMemo, useState, type FormEvent } from "react";
import { Loader2, Send } from "lucide-react";
import type { DashboardRuntimeWidget } from "../../../types";
import {
  buildDashboardAssistantWidgetContext,
  dashboardAssistantEndpointLabel,
  isDashboardAssistantConfigured,
  requestDashboardAssistant,
} from "../../../services/dashboardAssistantService";
import askLakeNessiIconUrl from "../../../assets/asklake-nessi-icon.png";

type DashboardAssistantPanelProps = {
  dashboardId?: string;
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
      setMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          text: response.message?.trim() || "Assistant 요청을 보냈습니다.",
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
