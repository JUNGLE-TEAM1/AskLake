import { Bot, Check, ChevronDown, CircleUser, Database, Plus, Send, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AuditResult, CatalogDataset } from "../../types";
import { generateQueryAiSuggestion, getQueryAiErrorMessage, QUERY_AI_REQUEST_TIMEOUT_MS } from "../../services/queryAiService";

const suggestedQuestions = [
  "이번 주 리뷰 불만을 요약하는 SQL을 만들어줘",
  "평점이 낮은 상품군을 찾는 SQL을 만들어줘",
  "최근 데이터셋 품질을 비교하는 SQL을 만들어줘",
];

type ChatMessage = {
  kind: "assistant" | "user";
  id: string;
  content: string;
  contextNames: string[];
  notices?: string[];
  retrieval?: NonNullable<import("../../services/queryAiService").QueryAiSuggestion["retrieval"]>;
  sources?: import("../../services/queryAiService").QueryAiSuggestion["sources"];
  sql?: string;
};

type Conversation = {
  id: string;
  title: string;
  messages: ChatMessage[];
  draftPrompt: string;
  selectedDatasetIds: string[];
  pending: boolean;
};

type ActiveQueryAiRequest = {
  controller: AbortController;
  conversationId: string;
  requestId: number;
};

function createConversation(): Conversation {
  return {
    id: `conversation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: "새 대화",
    messages: [],
    draftPrompt: "",
    selectedDatasetIds: [],
    pending: false,
  };
}

function titleFromQuestion(question: string) {
  const normalized = question.replace(/\s+/g, " ").trim();
  return normalized.length > 30 ? `${normalized.slice(0, 30)}...` : normalized || "새 대화";
}

export function AiChatPage({
  datasets,
  onAction,
}: {
  datasets: CatalogDataset[];
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
}) {
  const initialConversationRef = useRef<Conversation>(createConversation());
  const [conversations, setConversations] = useState<Conversation[]>(() => [initialConversationRef.current]);
  const [activeConversationId, setActiveConversationId] = useState(initialConversationRef.current.id);
  const [contextOpen, setContextOpen] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const contextPickerRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(false);
  const queryAiRequestRef = useRef<ActiveQueryAiRequest | null>(null);
  const queryAiRequestIdRef = useRef(0);
  const availableDatasets = useMemo(
    () => datasets.filter((dataset) => dataset.status === "available" && dataset.permissions?.canQuery !== false),
    [datasets],
  );
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId) ?? conversations[0];
  const selectedDatasets = availableDatasets.filter((dataset) => activeConversation.selectedDatasetIds.includes(dataset.id));
  const isPending = activeConversation.pending;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queryAiRequestRef.current?.controller.abort();
      queryAiRequestRef.current = null;
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeConversation.id, activeConversation.messages.length, isPending]);

  useEffect(() => {
    if (!contextOpen) return undefined;
    const closeContext = (event: KeyboardEvent | MouseEvent) => {
      if (event instanceof KeyboardEvent && event.key === "Escape") setContextOpen(false);
      if (event instanceof MouseEvent && !contextPickerRef.current?.contains(event.target as Node)) setContextOpen(false);
    };
    document.addEventListener("keydown", closeContext);
    document.addEventListener("mousedown", closeContext);
    return () => {
      document.removeEventListener("keydown", closeContext);
      document.removeEventListener("mousedown", closeContext);
    };
  }, [contextOpen]);

  const updateActiveConversation = (update: (conversation: Conversation) => Conversation) => {
    setConversations((current) => current.map((conversation) => (
      conversation.id === activeConversationId ? update(conversation) : conversation
    )));
  };

  const startNewConversation = () => {
    const nextConversation = createConversation();
    setConversations((current) => [nextConversation, ...current]);
    setActiveConversationId(nextConversation.id);
    setContextOpen(false);
    onAction("ai.chat.new", "/api/ai/conversations", nextConversation.id);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  };

  const selectConversation = (conversationId: string) => {
    setActiveConversationId(conversationId);
    setContextOpen(false);
    onAction("ai.chat.selected", "/api/ai/conversations", conversationId);
  };

  const deleteActiveConversation = () => {
    const deletedConversationId = activeConversation.id;
    setConversations((current) => {
      const remaining = current.filter((conversation) => conversation.id !== deletedConversationId);
      if (remaining.length > 0) {
        setActiveConversationId(remaining[0].id);
        return remaining;
      }
      const replacement = createConversation();
      setActiveConversationId(replacement.id);
      return [replacement];
    });
    setContextOpen(false);
    onAction("ai.chat.deleted", "/api/ai/conversations", deletedConversationId);
  };

  const chooseSuggestedQuestion = (question: string) => {
    if (isPending) return;
    updateActiveConversation((conversation) => ({ ...conversation, draftPrompt: question }));
    window.setTimeout(() => composerRef.current?.focus(), 0);
  };

  const toggleDataset = (datasetId: string) => {
    if (isPending) return;
    updateActiveConversation((conversation) => ({
      ...conversation,
      selectedDatasetIds: conversation.selectedDatasetIds.includes(datasetId)
        ? conversation.selectedDatasetIds.filter((id) => id !== datasetId)
        : [...conversation.selectedDatasetIds, datasetId],
    }));
    onAction("ai.context.dataset_toggled", "/api/ai/context", datasetId);
  };

  const submitPrompt = async () => {
    const question = activeConversation.draftPrompt.trim();
    if (!question || isPending || selectedDatasets.length === 0) return;

    const conversationId = activeConversation.id;
    const contextNames = selectedDatasets.map((dataset) => dataset.name);
    const controller = new AbortController();
    const requestId = queryAiRequestIdRef.current + 1;
    queryAiRequestIdRef.current = requestId;
    const previousRequest = queryAiRequestRef.current;
    queryAiRequestRef.current = { controller, conversationId, requestId };
    previousRequest?.controller.abort();
    const appendAssistantMessage = (message: Omit<ChatMessage, "id" | "kind">) => {
      setConversations((current) => current.map((conversation) => (
        conversation.id === conversationId
          ? {
            ...conversation,
            messages: [...conversation.messages, { ...message, id: `assistant-${Date.now()}`, kind: "assistant" }],
          }
          : conversation
      )));
    };

    setConversations((current) => current.map((conversation) => (
      conversation.id === conversationId
        ? {
          ...conversation,
          title: conversation.messages.length === 0 ? titleFromQuestion(question) : conversation.title,
          messages: [...conversation.messages, {
            id: `user-${Date.now()}`,
            kind: "user",
            content: question,
            contextNames,
          }],
          draftPrompt: "",
          pending: true,
        }
        : conversation
    )));
    setContextOpen(false);
    try {
      const suggestion = await generateQueryAiSuggestion({
        baseDataset: selectedDatasets[0],
        mode: "draft_sql",
        preflightMessages: [],
        prompt: question,
        query: "",
        selectedDatasets,
      }, {
        signal: controller.signal,
        timeoutMs: QUERY_AI_REQUEST_TIMEOUT_MS,
      });
      if (!mountedRef.current || queryAiRequestRef.current?.requestId !== requestId) return;
      appendAssistantMessage({
        content: suggestion.body,
        contextNames,
        notices: suggestion.notices,
        retrieval: suggestion.retrieval ?? undefined,
        sources: suggestion.sources,
        sql: suggestion.sql,
      });
      onAction("ai.chat.suggestion_created", "/api/query/ai-suggestions", selectedDatasets[0].id);
    } catch (error) {
      if (!mountedRef.current || queryAiRequestRef.current?.requestId !== requestId) return;
      appendAssistantMessage({
        content: getQueryAiErrorMessage(error),
        contextNames,
      });
      onAction("ai.chat.suggestion_failed", "/api/query/ai-suggestions", selectedDatasets[0].id, "failed");
    } finally {
      const activeRequest = queryAiRequestRef.current;
      const isCurrentRequest = activeRequest?.requestId === requestId;
      const hasReplacementForConversation = !isCurrentRequest && activeRequest?.conversationId === conversationId;
      if (isCurrentRequest) queryAiRequestRef.current = null;
      if (mountedRef.current && !hasReplacementForConversation) {
        setConversations((current) => current.map((conversation) => (
          conversation.id === conversationId ? { ...conversation, pending: false } : conversation
        )));
      }
    }
  };

  return (
    <section className="ai-chat-page" aria-label="AI 활용">
      <header className="ai-chat-header">
        <div className="ai-chat-title">
          <span><Sparkles size={15} /> AskLake AI</span>
          <h1>AI 활용</h1>
        </div>
        <div className="ai-chat-actions">
          <select aria-label="AI 대화 선택" className="secondary-button ai-conversation-select" value={activeConversation.id} onChange={(event) => selectConversation(event.target.value)}>
            {conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.title}</option>)}
          </select>
            <button aria-label="현재 대화 삭제" className="secondary-button ai-delete-conversation" disabled={isPending} title="현재 대화 삭제" type="button" onClick={deleteActiveConversation}>
            <Trash2 size={15} />
          </button>
          <div className="ai-context-picker" ref={contextPickerRef}>
            <button aria-expanded={contextOpen} className="secondary-button ai-context-trigger" disabled={isPending} type="button" onClick={() => setContextOpen((open) => !open)}>
              <Database size={15} />
              <span>{selectedDatasets.length > 0 ? `데이터셋 ${selectedDatasets.length}` : "데이터셋 선택"}</span>
              <ChevronDown size={14} />
            </button>
            {contextOpen ? (
              <div className="ai-context-menu" role="dialog" aria-label="대화 데이터셋 선택">
                <div className="ai-context-menu-heading">
                  <strong>대화 컨텍스트</strong>
                  <span>질문에 사용할 데이터셋을 선택하세요.</span>
                </div>
                  <div className="ai-context-options">
                    {availableDatasets.map((dataset) => {
                      const selected = activeConversation.selectedDatasetIds.includes(dataset.id);
                    return (
                      <label className={selected ? "ai-context-option selected" : "ai-context-option"} key={dataset.id}>
                        <input checked={selected} type="checkbox" onChange={() => toggleDataset(dataset.id)} />
                        <span className="ai-context-option-check">{selected ? <Check size={14} /> : null}</span>
                        <span className="ai-context-option-copy"><strong>{dataset.name}</strong><small>{dataset.layer} · {dataset.rows}</small></span>
                      </label>
                    );
                  })}
                  {availableDatasets.length === 0 ? <p className="ai-context-empty">선택 가능한 데이터셋이 없습니다.</p> : null}
                </div>
              </div>
            ) : null}
          </div>
          <button className="secondary-button ai-new-conversation" disabled={isPending} type="button" onClick={startNewConversation}>
            <Plus size={15} />
            새 대화
          </button>
        </div>
      </header>

      <div className="ai-chat-scroll">
        <div className={activeConversation.messages.length === 0 ? "ai-chat-thread empty" : "ai-chat-thread"}>
          {activeConversation.messages.length === 0 ? (
            <div className="ai-chat-empty">
              <span className="ai-chat-empty-mark"><Bot size={26} /></span>
              <div>
                <h2>읽기 전용 SQL 초안을 만드세요</h2>
                <p>분석할 AskLake 데이터셋을 선택하면 질문을 바탕으로 SQL 초안을 만듭니다.</p>
              </div>
            </div>
          ) : null}
          {activeConversation.messages.map((message) => (
            <article className={`ai-chat-message ${message.kind}`} key={message.id}>
              {message.kind === "assistant" && <span className="ai-chat-message-avatar"><Bot size={16} /></span>}
              <div>
                <p>{message.content}</p>
                {message.sql ? <pre className="ai-chat-sql"><code>{message.sql}</code></pre> : null}
                {message.retrieval ? (
                  <section className="ai-chat-evidence" aria-label="RAG 근거">
                    <strong>RAG 근거</strong>
                    <span>
                      {(message.retrieval.semanticModelNames ?? []).join(", ") || "연결된 Semantic Model 없음"}
                      {message.retrieval.semanticModelVersions?.some((version) => version !== null && version !== undefined)
                        ? ` · v${message.retrieval.semanticModelVersions.filter((version): version is number => version !== null && version !== undefined).join(", v")}`
                        : ""}
                      {` · ${message.retrieval.status ?? "unknown"} · ${message.retrieval.resultCount ?? message.sources?.length ?? 0}건`}
                    </span>
                    {message.sources?.slice(0, 3).map((source, index) => (
                      <p key={`${source.parentDocumentId ?? "source"}-${index}`}>
                        <b>{index + 1}.</b> {source.body?.trim().slice(0, 220) || source.title || source.datasetId || "source chunk"}
                      </p>
                    ))}
                  </section>
                ) : null}
                {message.notices?.length ? <ul className="ai-chat-notices">{message.notices.map((notice) => <li key={notice}>{notice}</li>)}</ul> : null}
                <span className="ai-message-context">{message.contextNames.join(" · ")}</span>
              </div>
              {message.kind === "user" && <span className="ai-chat-message-avatar"><CircleUser size={16} /></span>}
            </article>
          ))}
          {isPending ? (
            <div className="ai-runtime-pending" role="status">
              <Bot size={16} />
              <span>선택한 데이터셋 기준 SQL 초안을 생성하는 중</span>
            </div>
          ) : null}
          <div ref={messagesEndRef} />
        </div>
      </div>

      <footer className="ai-chat-composer-shell">
        {selectedDatasets.length > 0 ? (
          <div className="ai-selected-context" aria-label="선택된 대화 데이터셋">
            {selectedDatasets.map((dataset) => <span key={dataset.id}><Database size={13} />{dataset.name}</span>)}
          </div>
        ) : null}
        <div className="ai-chat-recommendations" aria-label="추천 질문">
          {suggestedQuestions.map((question) => <button disabled={isPending} key={question} type="button" onClick={() => chooseSuggestedQuestion(question)}>{question}</button>)}
        </div>
        <div className="ai-chat-composer" aria-label="AI 질문 입력">
          <textarea aria-label="AI 질문" disabled={isPending} placeholder="선택한 데이터셋으로 만들 SQL 분석을 설명하세요" ref={composerRef} rows={2} value={activeConversation.draftPrompt} onChange={(event) => updateActiveConversation((conversation) => ({ ...conversation, draftPrompt: event.target.value }))} onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submitPrompt();
            }
          }} />
          <button aria-label="AI 질문 전송" disabled={!activeConversation.draftPrompt.trim() || isPending || selectedDatasets.length === 0} title={selectedDatasets.length === 0 ? "질문에 사용할 데이터셋을 선택하세요." : undefined} type="button" onClick={() => void submitPrompt()}><Send size={18} /></button>
        </div>
      </footer>
    </section>
  );
}
