import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Bubble, BubbleContent, BubbleGroup } from "@/components/ui/bubble";
import { cn } from "@/lib/utils";
import type { DashboardRuntimeWidget } from "../../../types";
import {
  buildDashboardAssistantWidgetContext,
  dashboardAssistantEndpointLabel,
  type DashboardAssistantReportAction,
  type DashboardAssistantResponse,
  isDashboardAssistantConfigured,
  requestDashboardAssistant,
} from "../../../services/dashboardAssistantService";
import askLakeNessiIconUrl from "../../../assets/asklake-nessi-icon.png";
import type { CreateDraftWidgetFormInput, DashboardDatasetOption, UpdateDraftWidgetFormInput } from "./dashboardRuntimeTypes";
import { applyAssistantWidgetActions, hasWidgetMutationAction } from "./dashboardAssistantActions";
import { dashboardAssistantWidgetContextSignature } from "./dashboardAssistantContextSignature";
import {
  buildDashboardAssistantRequestPrompt,
  classifyDashboardAssistantMode,
  resolveDashboardAssistantMutationTarget,
} from "./dashboardAssistantIntent";
import { beginDashboardAssistantRequest, useDashboardAssistantRequestGate } from "./useDashboardAssistantRequestGate";
import { VisualizationPromptInput, type VisualizationPromptInputHandle } from "./VisualizationPromptInput";

type DashboardAssistantPanelProps = {
  currentDatasetId?: string | null;
  dashboardId?: string;
  datasets: DashboardDatasetOption[];
  onCreateWidget?: (input: CreateDraftWidgetFormInput) => Promise<boolean>;
  onUpdateWidget?: (widgetId: string, input: UpdateDraftWidgetFormInput) => Promise<boolean>;
  pageId: string | null;
  promptInsertion?: DashboardAssistantPromptInsertion | null;
  selectedDatasetIds?: string[];
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

function semanticRetrievalSummary(response: DashboardAssistantResponse) {
  const retrieval = response.retrieval;
  if (!retrieval || (response.sources?.length ?? 0) === 0) return "";
  const resultCount = retrieval.resultCount ?? response.sources?.length ?? 0;
  const modelNames = retrieval.semanticModelNames ?? [];
  const modelVersions = retrieval.semanticModelVersions ?? [];
  const modelSummary = modelNames.map((name, index) => `${name}${modelVersions[index] ? ` v${modelVersions[index]}` : ""}`).join(", ");
  const datasetSummary = (retrieval.datasetIds ?? []).join(", ");
  const sourceTitles = (response.sources ?? [])
    .map((source) => source.title || source.body?.trim().slice(0, 120) || source.datasetId)
    .filter((title): title is string => Boolean(title));
  const evidence = sourceTitles.length > 0 ? ` · 근거: ${sourceTitles.join(" / ")}` : "";
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
  return `RAG 근거 · ${modelSummary || "semantic model 없음"} · Dataset: ${datasetSummary || "-"} · ${retrieval.status ?? "unknown"} · ${resultCount}건${planner}${embedding}${relevance}${evidence}`;
}

function assistantResponseText(response: DashboardAssistantResponse, actionMessages: string[]) {
  const reportAction = response.actions.find(
    (action): action is DashboardAssistantReportAction => action.type === "report",
  );
  const provenance = response.provider && !["local-input-guard", "local-join-guard", "unavailable"].includes(response.provider)
    ? `AI 모델 · ${[response.provider, response.model].filter(Boolean).join(" · ")}`
    : "";
  const warning = response.warnings.length > 0 ? `경고: ${response.warnings.join(" / ")}` : "";
  return [
    reportAction?.markdown?.trim() || response.message?.trim() || "Assistant 요청을 보냈습니다.",
    ...actionMessages,
    provenance,
    semanticRetrievalSummary(response),
    warning,
  ].filter(Boolean).join("\n\n");
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

function buildAssistantRequestIntent(
  prompt: string,
  messages: AssistantMessage[],
  hasSelectedWidget: boolean,
) {
  const previousUserPrompts = messages
    .filter((message) => message.role === "user")
    .map((message) => message.text);
  return {
    mode: classifyDashboardAssistantMode(prompt, { hasSelectedWidget, previousUserPrompts }),
    requestPrompt: buildDashboardAssistantRequestPrompt(prompt, previousUserPrompts),
  };
}

export function DashboardAssistantPanel({
  currentDatasetId,
  dashboardId,
  datasets,
  onCreateWidget,
  onUpdateWidget,
  pageId,
  promptInsertion,
  selectedDatasetIds = [],
  selectedWidget,
  widgets,
}: DashboardAssistantPanelProps) {
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const messagesEndRef = useRef<HTMLSpanElement | null>(null);
  const promptInputRef = useRef<VisualizationPromptInputHandle | null>(null);
  const surfaceKey = JSON.stringify([dashboardId, pageId]);
  const surfaceKeyRef = useRef(surfaceKey);
  surfaceKeyRef.current = surfaceKey;
  const requests = useDashboardAssistantRequestGate(JSON.stringify([
    currentDatasetId,
    dashboardId,
    pageId,
    selectedWidget?.id,
    selectedDatasetIds,
    dashboardAssistantWidgetContextSignature(widgets),
  ]), () => setIsSubmitting(false));
  const isConfigured = isDashboardAssistantConfigured();
  const shouldReduceMotion = useReducedMotion();
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
    const { mode, requestPrompt } = buildAssistantRequestIntent(nextPrompt, messages, Boolean(selectedWidget));
    const selectedWidgetId = mode === "visualization_request"
      ? resolveDashboardAssistantMutationTarget(nextPrompt, selectedWidget?.id)
      : selectedWidget?.id ?? null;
    const targetWidgets = selectedWidgetId
      ? widgets.filter((widget) => widget.id === selectedWidgetId)
      : widgets;
    const submissionSurfaceKey = surfaceKey;
    const lease = beginDashboardAssistantRequest(requests.current, { resource: "dashboard-assistant", version: pageId, params: { currentDatasetId, dashboardId, mode, prompt: requestPrompt, selectedWidgetId } });
    try {
      const response = await requestDashboardAssistant({
        dashboardId,
        currentDatasetId,
        mode,
        pageId,
        prompt: requestPrompt,
        selectedDatasetIds,
        selectedWidgetId,
        widgets: targetWidgets.map(buildDashboardAssistantWidgetContext),
      }, { signal: lease.signal });
      if (!requests.current.isCurrent(lease)) return;
      if (mode === "visualization_request" && !hasWidgetMutationAction(response)) {
        throw new Error(response.message?.trim() || "AI가 적용 가능한 위젯 변경을 생성하지 못했습니다.");
      }
      const actionMessages = await applyAssistantWidgetActions({
        datasets,
        onCreateWidget,
        onUpdateWidget,
        response,
        widgets,
      });
      if (surfaceKeyRef.current !== submissionSurfaceKey) return;
      setMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          text: assistantResponseText(response, actionMessages),
        },
      ]);
    } catch (requestError) {
      if (!requests.current.isCurrent(lease)) return;
      const message = requestError instanceof Error ? requestError.message : "Assistant 요청에 실패했습니다.";
      setError(message);
    } finally {
      if (requests.current.complete(lease)) setIsSubmitting(false);
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
