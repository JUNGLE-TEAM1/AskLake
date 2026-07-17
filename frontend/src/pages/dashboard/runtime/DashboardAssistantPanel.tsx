import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Bubble, BubbleContent, BubbleGroup } from "@/components/ui/bubble";
import { cn } from "@/lib/utils";
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
import type { CreateDraftWidgetFormInput, DashboardDatasetOption, UpdateDraftWidgetFormInput } from "./dashboardRuntimeTypes";
import { VisualizationPromptInput, type VisualizationPromptInputHandle } from "./VisualizationPromptInput";

type DashboardAssistantPanelProps = {
  currentDatasetId?: string | null;
  dashboardId?: string;
  datasets: DashboardDatasetOption[];
  onCreateWidget?: (input: CreateDraftWidgetFormInput) => Promise<void | boolean> | void;
  onUpdateWidget?: (widgetId: string, input: UpdateDraftWidgetFormInput) => Promise<void | boolean> | void;
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

function isWidgetMutationPrompt(prompt: string) {
  const hasWidgetTarget = /(위젯|차트|그래프|시각화|막대|꺾은선|선형|영역|도넛|원형|파이|트리맵|히트맵|지표|메트릭|표|테이블|widget|chart|graph|visuali[sz]|bar|line|area|donut|pie|treemap|heatmap|metric|table)/i.test(prompt);
  const hasMutationVerb = /(바꿔|변경|수정|만들|추가|생성|업데이트|전환|구성|설정|그려|해줘|보여|change|update|create|add|make|draw|show)/i.test(prompt);
  return hasWidgetTarget && hasMutationVerb;
}

function semanticRetrievalSummary(response: DashboardAssistantResponse) {
  const retrieval = response.retrieval;
  if (!retrieval || (response.sources?.length ?? 0) === 0) return "";
  const resultCount = retrieval.resultCount ?? response.sources?.length ?? 0;
  const modelNames = retrieval.semanticModelNames ?? [];
  const modelVersions = retrieval.semanticModelVersions ?? [];
  const modelSummary = modelNames.map((name, index) => `${name}${modelVersions[index] ? ` v${modelVersions[index]}` : ""}`).join(", ");
  const datasetSummary = (retrieval.datasetIds ?? []).slice(0, 3).join(", ");
  const sourceTitles = (response.sources ?? [])
    .map((source) => source.title || source.body?.trim().slice(0, 120) || source.datasetId)
    .filter((title): title is string => Boolean(title))
    .slice(0, 3);
  const evidence = sourceTitles.length > 0 ? ` · 근거: ${sourceTitles.join(" / ")}` : "";
  const fallback = (retrieval.fallbackEvidenceCount ?? 0) > 0
    ? ` · 임베딩 전용 청킹 폴백 ${retrieval.fallbackEvidenceCount}건`
    : "";
  const planner = retrieval.queryPlannerProvider || retrieval.queryPlannerModel
    ? ` · 계획: ${[retrieval.queryPlannerProvider, retrieval.queryPlannerModel].filter(Boolean).join(" · ")}`
    : "";
  const embeddings = Object.values(retrieval.queryEmbeddings ?? {})
    .map((item) => [item.provider, item.model, item.dimensions ? `${item.dimensions}차원` : null].filter(Boolean).join(" · "))
    .filter(Boolean);
  const embedding = embeddings.length > 0 ? ` · 임베딩: ${Array.from(new Set(embeddings)).join(", ")}` : "";
  const relevance = retrieval.relevanceProvider || retrieval.relevanceModel
    ? ` · 관련성: ${[retrieval.relevanceProvider, retrieval.relevanceModel].filter(Boolean).join(" · ")}`
    : "";
  return `RAG 근거 · ${modelSummary || "semantic model 없음"} · Dataset: ${datasetSummary || "-"} · ${retrieval.status ?? "unknown"} · ${resultCount}건${planner}${embedding}${relevance}${fallback}${evidence}`;
}

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
  currentDatasetId,
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
  const shouldReduceMotion = useReducedMotion();
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
      const mode = isWidgetMutationPrompt(nextPrompt) ? "visualization_request" : "dashboard_question";
      const response = await requestDashboardAssistant({
        dashboardId,
        currentDatasetId,
        mode,
        pageId,
        prompt: nextPrompt,
        selectedWidgetId: selectedWidget?.id ?? null,
        widgets: targetWidgets.map(buildDashboardAssistantWidgetContext),
      });
      if (mode === "visualization_request" && !hasWidgetMutationAction(response)) {
        throw new Error(response.message?.trim() || "AI가 적용 가능한 위젯 변경을 생성하지 못했습니다.");
      }
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
      const retrievalMessage = semanticRetrievalSummary(response);
      const provenanceMessage = response.provider && !["local-input-guard", "unavailable"].includes(response.provider)
        ? `AI 모델 · ${[response.provider, response.model].filter(Boolean).join(" · ")}`
        : "";
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
            provenanceMessage,
            retrievalMessage,
            warningMessage,
          ].filter(Boolean).join("\n\n"),
        },
      ]);
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "Assistant 요청에 실패했습니다.";
      setError(message);
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
              <motion.div
                animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
                className={cn(
                  "flex w-full",
                  message.role === "user" ? "justify-end" : "justify-start",
                )}
                initial={shouldReduceMotion
                  ? false
                  : {
                    opacity: 0,
                    scale: 0.97,
                    x: message.role === "user" ? 28 : -28,
                    y: 6,
                  }}
                key={message.id}
                transition={shouldReduceMotion
                  ? { duration: 0 }
                  : { damping: 28, mass: 0.8, stiffness: 260, type: "spring" }}
              >
                <Bubble
                  align={message.role === "user" ? "end" : "start"}
                  variant={message.role === "user" ? "default" : "secondary"}
                >
                  <BubbleContent className="whitespace-pre-wrap">{message.text}</BubbleContent>
                </Bubble>
              </motion.div>
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
  onCreateWidget?: (input: CreateDraftWidgetFormInput) => Promise<void | boolean> | void;
  onUpdateWidget?: (widgetId: string, input: UpdateDraftWidgetFormInput) => Promise<void | boolean> | void;
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
      const result = await applyUpdateWidgetAction(action, datasets, widgets, onUpdateWidget);
      if (result) messages.push(result);
    }
  }

  if (messages.length === 0 && response.actions.some((action) => action.type !== "report")) {
    messages.push("위젯 변경 action을 받았지만 화면에 적용하지 못했습니다.");
  }

  return messages;
}

function hasWidgetMutationAction(response: DashboardAssistantResponse) {
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
