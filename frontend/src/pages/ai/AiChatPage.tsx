import { Bot, Check, ChevronDown, CircleUser, Database, Plus, Send, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type AuditResult, type CatalogDataset } from "../../types";
import type { AiConversation } from "../../types/ai";
import {
  createAiConversation,
  createAiConversationMessage,
  deleteAiConversation,
  listAiConversations,
  updateAiConversation,
} from "../../services/aiConversationApi";
import { apiConfig } from "../../services/apiClient";
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
  sql?: string;
};

type Conversation = {
  id: string;
  title: string;
  messages: ChatMessage[];
  draftPrompt: string;
  selectedDatasetIds: string[];
  pending: boolean;
  version: number;
};

type ActiveQueryAiRequest = {
  controller: AbortController;
  conversationId: string;
  requestId: number;
};

type RetryMessageRequest = {
  content: string;
  id: string;
};

function createMockConversation(): Conversation {
  return {
    id: `conversation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: "새 대화",
    messages: [],
    draftPrompt: "",
    selectedDatasetIds: [],
    pending: false,
    version: 1,
  };
}

function conversationFromApi(
  conversation: AiConversation,
  previous?: Conversation,
  clearDraft = false,
): Conversation {
  return {
    id: conversation.id,
    title: conversation.title,
    messages: conversation.messages.map((message) => ({
      id: message.id,
      kind: message.role,
      content: message.content,
      contextNames: message.contextNames,
      notices: message.notices,
      sql: message.sql ?? undefined,
    })),
    draftPrompt: clearDraft ? "" : previous?.draftPrompt ?? "",
    selectedDatasetIds: conversation.selectedDatasetIds,
    pending: false,
    version: conversation.version,
  };
}

function titleFromQuestion(question: string) {
  const normalized = question.replace(/\s+/g, " ").trim();
  return normalized.length > 30 ? `${normalized.slice(0, 30)}...` : normalized || "새 대화";
}

function createClientRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `ai-message-${crypto.randomUUID()}`;
  }
  return `ai-message-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function persistenceErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiError && (error.code === "CONFLICT" || error.status === 409)) {
    return "다른 화면에서 대화가 변경되었습니다. 최신 상태를 불러왔으니 다시 시도해 주세요.";
  }
  if (error instanceof ApiError && error.status === 404) {
    return "대화 또는 선택한 데이터셋이 삭제되었습니다. 대화 컨텍스트를 다시 확인해 주세요.";
  }
  if (error instanceof ApiError && error.status === 403) {
    return "선택한 데이터셋을 AI 대화에서 사용할 권한이 없습니다.";
  }
  if (error instanceof ApiError && error.status === 422) {
    return "선택한 데이터셋 상태 또는 요청 내용을 확인한 뒤 다시 시도해 주세요.";
  }
  if (error instanceof ApiError && error.message.trim()) return error.message;
  return fallback;
}

export function AiChatPage({
  datasets,
  onAction,
}: {
  datasets: CatalogDataset[];
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
}) {
  const mockInitialConversationRef = useRef<Conversation>(createMockConversation());
  const [conversations, setConversations] = useState<Conversation[]>(() => (
    apiConfig.useMock ? [mockInitialConversationRef.current] : []
  ));
  const [activeConversationId, setActiveConversationId] = useState(
    apiConfig.useMock ? mockInitialConversationRef.current.id : "",
  );
  const [contextOpen, setContextOpen] = useState(false);
  const [hydratePending, setHydratePending] = useState(!apiConfig.useMock);
  const [pageMutationPending, setPageMutationPending] = useState(false);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const contextPickerRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(false);
  const hydratePromiseRef = useRef<Promise<AiConversation[]> | null>(null);
  const queryAiRequestRef = useRef<ActiveQueryAiRequest | null>(null);
  const queryAiRequestIdRef = useRef(0);
  const retryMessageRequestRef = useRef(new Map<string, RetryMessageRequest>());
  const availableDatasets = useMemo(
    () => datasets.filter((dataset) => dataset.status === "available" && dataset.permissions?.canQuery !== false),
    [datasets],
  );
  const availableDatasetIds = useMemo(
    () => new Set(availableDatasets.map((dataset) => dataset.id)),
    [availableDatasets],
  );
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId)
    ?? conversations[0]
    ?? null;
  const selectedDatasets = activeConversation
    ? availableDatasets.filter((dataset) => activeConversation.selectedDatasetIds.includes(dataset.id))
    : [];
  const hasUnavailableSelectedDataset = Boolean(activeConversation?.selectedDatasetIds.some(
    (datasetId) => !availableDatasetIds.has(datasetId),
  ));
  const isPending = hydratePending || pageMutationPending || Boolean(activeConversation?.pending);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queryAiRequestRef.current?.controller.abort();
      queryAiRequestRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (apiConfig.useMock) return undefined;
    if (!hydratePromiseRef.current) {
      hydratePromiseRef.current = listAiConversations().then(async ({ items }) => (
        items.length > 0 ? items : [await createAiConversation()]
      ));
    }
    let cancelled = false;
    void hydratePromiseRef.current.then((items) => {
      if (cancelled) return;
      setConversations(items.map((conversation) => conversationFromApi(conversation)));
      setActiveConversationId((currentId) => (
        items.some((conversation) => conversation.id === currentId) ? currentId : items[0]?.id ?? ""
      ));
      setPersistenceError(null);
    }).catch((error: unknown) => {
      if (cancelled) return;
      setPersistenceError(persistenceErrorMessage(error, "AI 대화 목록을 불러오지 못했습니다."));
    }).finally(() => {
      if (!cancelled) setHydratePending(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeConversation?.id, activeConversation?.messages.length, isPending]);

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
    if (!activeConversation) return;
    setConversations((current) => current.map((conversation) => (
      conversation.id === activeConversation.id ? update(conversation) : conversation
    )));
  };

  const setConversationPending = (conversationId: string, pending: boolean) => {
    setConversations((current) => current.map((conversation) => (
      conversation.id === conversationId ? { ...conversation, pending } : conversation
    )));
  };

  const applyApiConversation = (persisted: AiConversation, clearDraft = false) => {
    setConversations((current) => current.map((conversation) => (
      conversation.id === persisted.id
        ? conversationFromApi(persisted, conversation, clearDraft)
        : conversation
    )));
  };

  const refreshLiveConversations = async (preferredConversationId: string) => {
    const { items } = await listAiConversations();
    setConversations((current) => items.map((conversation) => conversationFromApi(
      conversation,
      current.find((candidate) => candidate.id === conversation.id),
    )));
    setActiveConversationId(
      items.some((conversation) => conversation.id === preferredConversationId)
        ? preferredConversationId
        : items[0]?.id ?? "",
    );
  };

  const reconcileConflict = async (conversationId: string, error: unknown) => {
    if (!(error instanceof ApiError) || (error.code !== "CONFLICT" && error.status !== 409)) return;
    try {
      await refreshLiveConversations(conversationId);
    } catch {
      // Keep the original conflict message and the last successfully hydrated state.
    }
  };

  const startNewConversation = async () => {
    if (isPending) return;
    setContextOpen(false);
    setPersistenceError(null);
    if (apiConfig.useMock) {
      const nextConversation = createMockConversation();
      setConversations((current) => [nextConversation, ...current]);
      setActiveConversationId(nextConversation.id);
      onAction("ai.chat.new", "/api/ai/conversations", nextConversation.id);
      window.setTimeout(() => composerRef.current?.focus(), 0);
      return;
    }

    setPageMutationPending(true);
    try {
      const persisted = await createAiConversation();
      setConversations((current) => [conversationFromApi(persisted), ...current]);
      setActiveConversationId(persisted.id);
      onAction("ai.chat.new", "/api/ai/conversations", persisted.id);
      window.setTimeout(() => composerRef.current?.focus(), 0);
    } catch (error) {
      setPersistenceError(persistenceErrorMessage(error, "새 AI 대화를 만들지 못했습니다."));
      onAction("ai.chat.new_failed", "/api/ai/conversations", "new", "failed");
    } finally {
      if (mountedRef.current) setPageMutationPending(false);
    }
  };

  const selectConversation = (conversationId: string) => {
    setActiveConversationId(conversationId);
    setContextOpen(false);
    setPersistenceError(null);
    onAction("ai.chat.selected", "/api/ai/conversations", conversationId);
  };

  const deleteActiveConversation = async () => {
    if (!activeConversation || isPending) return;
    const deletedConversation = activeConversation;
    setContextOpen(false);
    setPersistenceError(null);
    if (apiConfig.useMock) {
      setConversations((current) => {
        const remaining = current.filter((conversation) => conversation.id !== deletedConversation.id);
        if (remaining.length > 0) {
          setActiveConversationId(remaining[0].id);
          return remaining;
        }
        const replacement = createMockConversation();
        setActiveConversationId(replacement.id);
        return [replacement];
      });
      onAction("ai.chat.deleted", "/api/ai/conversations", deletedConversation.id);
      return;
    }

    setConversationPending(deletedConversation.id, true);
    try {
      await deleteAiConversation(deletedConversation.id, deletedConversation.version);
      const remaining = conversations.filter((conversation) => conversation.id !== deletedConversation.id);
      setConversations(remaining);
      setActiveConversationId(remaining[0]?.id ?? "");
      retryMessageRequestRef.current.delete(deletedConversation.id);
      onAction("ai.chat.deleted", `/api/ai/conversations/${deletedConversation.id}`, deletedConversation.id);
      if (remaining.length > 0) {
        return;
      } else {
        try {
          const replacement = await createAiConversation();
          setConversations([conversationFromApi(replacement)]);
          setActiveConversationId(replacement.id);
        } catch (replacementError) {
          setPersistenceError(persistenceErrorMessage(replacementError, "삭제는 완료했지만 새 AI 대화를 만들지 못했습니다."));
        }
      }
    } catch (error) {
      setPersistenceError(persistenceErrorMessage(error, "AI 대화를 삭제하지 못했습니다."));
      await reconcileConflict(deletedConversation.id, error);
      onAction("ai.chat.delete_failed", `/api/ai/conversations/${deletedConversation.id}`, deletedConversation.id, "failed");
    } finally {
      if (mountedRef.current) setConversationPending(deletedConversation.id, false);
    }
  };

  const chooseSuggestedQuestion = (question: string) => {
    if (isPending || !activeConversation) return;
    updateActiveConversation((conversation) => ({ ...conversation, draftPrompt: question }));
    window.setTimeout(() => composerRef.current?.focus(), 0);
  };

  const toggleDataset = async (datasetId: string) => {
    if (!activeConversation || isPending) return;
    const conversation = activeConversation;
    const currentAvailableIds = conversation.selectedDatasetIds.filter((id) => availableDatasetIds.has(id));
    const nextDatasetIds = currentAvailableIds.includes(datasetId)
      ? currentAvailableIds.filter((id) => id !== datasetId)
      : [...currentAvailableIds, datasetId];
    setPersistenceError(null);
    if (apiConfig.useMock) {
      updateActiveConversation((current) => ({ ...current, selectedDatasetIds: nextDatasetIds }));
      onAction("ai.context.dataset_toggled", `/api/ai/conversations/${conversation.id}`, datasetId);
      return;
    }

    setConversationPending(conversation.id, true);
    try {
      const persisted = await updateAiConversation(conversation.id, {
        version: conversation.version,
        selectedDatasetIds: nextDatasetIds,
      });
      applyApiConversation(persisted);
      onAction("ai.context.dataset_toggled", `/api/ai/conversations/${conversation.id}`, datasetId);
    } catch (error) {
      setPersistenceError(persistenceErrorMessage(error, "대화 데이터셋을 저장하지 못했습니다."));
      await reconcileConflict(conversation.id, error);
      onAction("ai.context.dataset_toggle_failed", `/api/ai/conversations/${conversation.id}`, datasetId, "failed");
    } finally {
      if (mountedRef.current) setConversationPending(conversation.id, false);
    }
  };

  const clearSelectedDatasets = async () => {
    if (!activeConversation || isPending) return;
    const conversation = activeConversation;
    setPersistenceError(null);
    setContextOpen(false);
    if (apiConfig.useMock) {
      updateActiveConversation((current) => ({ ...current, selectedDatasetIds: [] }));
      onAction("ai.context.datasets_cleared", `/api/ai/conversations/${conversation.id}`, conversation.id);
      return;
    }

    setConversationPending(conversation.id, true);
    try {
      const persisted = await updateAiConversation(conversation.id, {
        version: conversation.version,
        selectedDatasetIds: [],
      });
      applyApiConversation(persisted);
      onAction("ai.context.datasets_cleared", `/api/ai/conversations/${conversation.id}`, conversation.id);
    } catch (error) {
      setPersistenceError(persistenceErrorMessage(error, "대화 데이터셋 선택을 초기화하지 못했습니다."));
      await reconcileConflict(conversation.id, error);
      onAction("ai.context.datasets_clear_failed", `/api/ai/conversations/${conversation.id}`, conversation.id, "failed");
    } finally {
      if (mountedRef.current) setConversationPending(conversation.id, false);
    }
  };

  const submitMockPrompt = async (
    conversation: Conversation,
    question: string,
    controller: AbortController,
    requestId: number,
  ) => {
    const conversationId = conversation.id;
    const contextNames = selectedDatasets.map((dataset) => dataset.name);
    const appendAssistantMessage = (message: Omit<ChatMessage, "id" | "kind">) => {
      setConversations((current) => current.map((candidate) => (
        candidate.id === conversationId
          ? {
            ...candidate,
            messages: [...candidate.messages, { ...message, id: `assistant-${Date.now()}`, kind: "assistant" }],
          }
          : candidate
      )));
    };

    setConversations((current) => current.map((candidate) => (
      candidate.id === conversationId
        ? {
          ...candidate,
          title: candidate.messages.length === 0 ? titleFromQuestion(question) : candidate.title,
          messages: [...candidate.messages, {
            id: `user-${Date.now()}`,
            kind: "user",
            content: question,
            contextNames,
          }],
          draftPrompt: "",
          pending: true,
          version: candidate.version + 1,
        }
        : candidate
    )));
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
    }
  };

  const submitLivePrompt = async (
    conversation: Conversation,
    question: string,
    controller: AbortController,
    requestId: number,
  ) => {
    const retryRequest = retryMessageRequestRef.current.get(conversation.id);
    const clientRequestId = retryRequest?.content === question
      ? retryRequest.id
      : createClientRequestId();
    retryMessageRequestRef.current.set(conversation.id, { content: question, id: clientRequestId });
    setPersistenceError(null);
    setConversationPending(conversation.id, true);
    try {
      const persisted = await createAiConversationMessage(conversation.id, {
        version: conversation.version,
        clientRequestId,
        content: question,
      }, {
        signal: controller.signal,
        timeoutMs: QUERY_AI_REQUEST_TIMEOUT_MS,
      });
      if (!mountedRef.current || queryAiRequestRef.current?.requestId !== requestId) return;
      applyApiConversation(persisted, true);
      retryMessageRequestRef.current.delete(conversation.id);
      onAction("ai.chat.suggestion_created", `/api/ai/conversations/${conversation.id}/messages`, conversation.id);
    } catch (error) {
      if (!mountedRef.current || queryAiRequestRef.current?.requestId !== requestId) return;
      setPersistenceError(error instanceof ApiError && [403, 404, 409, 422].includes(error.status)
        ? persistenceErrorMessage(error, "AI 메시지를 저장하지 못했습니다.")
        : getQueryAiErrorMessage(error));
      await reconcileConflict(conversation.id, error);
      onAction("ai.chat.suggestion_failed", `/api/ai/conversations/${conversation.id}/messages`, conversation.id, "failed");
    }
  };

  const submitPrompt = async () => {
    if (!activeConversation) return;
    const conversation = activeConversation;
    const question = conversation.draftPrompt.trim();
    if (!question || isPending || selectedDatasets.length === 0 || hasUnavailableSelectedDataset) return;

    const controller = new AbortController();
    const requestId = queryAiRequestIdRef.current + 1;
    queryAiRequestIdRef.current = requestId;
    const previousRequest = queryAiRequestRef.current;
    queryAiRequestRef.current = { controller, conversationId: conversation.id, requestId };
    previousRequest?.controller.abort();
    setContextOpen(false);
    try {
      if (apiConfig.useMock) {
        await submitMockPrompt(conversation, question, controller, requestId);
      } else {
        await submitLivePrompt(conversation, question, controller, requestId);
      }
    } finally {
      const activeRequest = queryAiRequestRef.current;
      const isCurrentRequest = activeRequest?.requestId === requestId;
      const hasReplacementForConversation = !isCurrentRequest && activeRequest?.conversationId === conversation.id;
      if (isCurrentRequest) queryAiRequestRef.current = null;
      if (mountedRef.current && !hasReplacementForConversation) {
        setConversationPending(conversation.id, false);
      }
    }
  };

  const messages = activeConversation?.messages ?? [];
  const draftPrompt = activeConversation?.draftPrompt ?? "";

  return (
    <section className="ai-chat-page" aria-label="AI 활용">
      <header className="ai-chat-header">
        <div className="ai-chat-title">
          <span><Sparkles size={15} /> AskLake AI</span>
          <h1>AI 활용</h1>
        </div>
        <div className="ai-chat-actions">
          <select
            aria-label="AI 대화 선택"
            className="secondary-button ai-conversation-select"
            disabled={!activeConversation || isPending}
            value={activeConversation?.id ?? ""}
            onChange={(event) => selectConversation(event.target.value)}
          >
            {!activeConversation ? <option value="">대화 없음</option> : null}
            {conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.title}</option>)}
          </select>
          <button aria-label="현재 대화 삭제" className="secondary-button ai-delete-conversation" disabled={!activeConversation || isPending} title="현재 대화 삭제" type="button" onClick={() => void deleteActiveConversation()}>
            <Trash2 size={15} />
          </button>
          <div className="ai-context-picker" ref={contextPickerRef}>
            <button aria-expanded={contextOpen} className="secondary-button ai-context-trigger" disabled={!activeConversation || isPending} type="button" onClick={() => setContextOpen((open) => !open)}>
              <Database size={15} />
              <span>{selectedDatasets.length > 0 ? `데이터셋 ${selectedDatasets.length}` : "데이터셋 선택"}</span>
              <ChevronDown size={14} />
            </button>
            {contextOpen && activeConversation ? (
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
                        <input checked={selected} type="checkbox" onChange={() => void toggleDataset(dataset.id)} />
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
          <button className="secondary-button ai-new-conversation" disabled={isPending} type="button" onClick={() => void startNewConversation()}>
            <Plus size={15} />
            새 대화
          </button>
        </div>
      </header>

      <div className="ai-chat-scroll">
        {persistenceError || hasUnavailableSelectedDataset ? (
          <div className="ai-persistence-status">
            {persistenceError ? <p className="ai-persistence-error" role="alert">{persistenceError}</p> : null}
            {hasUnavailableSelectedDataset ? (
              <div className="ai-persistence-warning" role="status">
                <span>선택했던 데이터셋 중 삭제되었거나 사용할 수 없는 항목이 있습니다. 데이터셋을 다시 선택해 주세요.</span>
                <button disabled={isPending} type="button" onClick={() => void clearSelectedDatasets()}>선택 초기화</button>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className={messages.length === 0 ? "ai-chat-thread empty" : "ai-chat-thread"}>
          {messages.length === 0 ? (
            <div className="ai-chat-empty">
              <span className="ai-chat-empty-mark"><Bot size={26} /></span>
              <div>
                <h2>{hydratePending ? "저장된 대화를 불러오는 중" : "읽기 전용 SQL 초안을 만드세요"}</h2>
                <p>{activeConversation ? "분석할 AskLake 데이터셋을 선택하면 질문을 바탕으로 SQL 초안을 만듭니다." : "새 대화를 만들어 분석을 시작하세요."}</p>
              </div>
            </div>
          ) : null}
          {messages.map((message) => (
            <article className={`ai-chat-message ${message.kind}`} key={message.id}>
              {message.kind === "assistant" && <span className="ai-chat-message-avatar"><Bot size={16} /></span>}
              <div>
                <p>{message.content}</p>
                {message.sql ? <pre className="ai-chat-sql"><code>{message.sql}</code></pre> : null}
                {message.notices?.length ? <ul className="ai-chat-notices">{message.notices.map((notice) => <li key={notice}>{notice}</li>)}</ul> : null}
                <span className="ai-message-context">{message.contextNames.join(" · ")}</span>
              </div>
              {message.kind === "user" && <span className="ai-chat-message-avatar"><CircleUser size={16} /></span>}
            </article>
          ))}
          {activeConversation?.pending ? (
            <div className="ai-runtime-pending" role="status">
              <Bot size={16} />
              <span>선택한 데이터셋 기준 SQL 초안을 생성하고 저장하는 중</span>
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
          {suggestedQuestions.map((question) => <button disabled={!activeConversation || isPending} key={question} type="button" onClick={() => chooseSuggestedQuestion(question)}>{question}</button>)}
        </div>
        <div className="ai-chat-composer" aria-label="AI 질문 입력">
          <textarea
            aria-label="AI 질문"
            disabled={!activeConversation || isPending}
            placeholder="선택한 데이터셋으로 만들 SQL 분석을 설명하세요"
            ref={composerRef}
            rows={2}
            value={draftPrompt}
            onChange={(event) => updateActiveConversation((conversation) => ({ ...conversation, draftPrompt: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submitPrompt();
              }
            }}
          />
          <button
            aria-label="AI 질문 전송"
            disabled={!draftPrompt.trim() || isPending || selectedDatasets.length === 0 || hasUnavailableSelectedDataset}
            title={selectedDatasets.length === 0 ? "질문에 사용할 데이터셋을 선택하세요." : undefined}
            type="button"
            onClick={() => void submitPrompt()}
          ><Send size={18} /></button>
        </div>
      </footer>
    </section>
  );
}
