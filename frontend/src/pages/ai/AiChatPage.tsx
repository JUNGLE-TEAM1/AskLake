import { Bot, Check, ChevronDown, CircleUser, Database, Plus, Send, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CatalogDataset } from "../../types";

const suggestedQuestions = [
  "이번 주 리뷰에서 반복되는 불만을 요약해줘",
  "평점이 낮은 상품군을 찾아줘",
  "최근 실행된 데이터셋의 품질을 비교해줘",
];

type UserMessage = {
  id: string;
  content: string;
  contextNames: string[];
};

type Conversation = {
  id: string;
  title: string;
  messages: UserMessage[];
  draftPrompt: string;
  selectedDatasetIds: string[];
  runtimeUnavailable: boolean;
};

function createConversation(): Conversation {
  return {
    id: `conversation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: "새 대화",
    messages: [],
    draftPrompt: "",
    selectedDatasetIds: [],
    runtimeUnavailable: false,
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
  onAction: (action: string, apiPath: string, targetId: string) => void;
}) {
  const initialConversationRef = useRef<Conversation>(createConversation());
  const [conversations, setConversations] = useState<Conversation[]>(() => [initialConversationRef.current]);
  const [activeConversationId, setActiveConversationId] = useState(initialConversationRef.current.id);
  const [contextOpen, setContextOpen] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const contextPickerRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const availableDatasets = useMemo(
    () => datasets.filter((dataset) => dataset.status === "available" && dataset.permissions?.canQuery !== false),
    [datasets],
  );
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId) ?? conversations[0];
  const selectedDatasets = availableDatasets.filter((dataset) => activeConversation.selectedDatasetIds.includes(dataset.id));
  const runtimeUnavailable = activeConversation.runtimeUnavailable;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeConversation.id, activeConversation.messages.length, runtimeUnavailable]);

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
    if (runtimeUnavailable) return;
    updateActiveConversation((conversation) => ({ ...conversation, draftPrompt: question }));
    window.setTimeout(() => composerRef.current?.focus(), 0);
  };

  const toggleDataset = (datasetId: string) => {
    if (runtimeUnavailable) return;
    updateActiveConversation((conversation) => ({
      ...conversation,
      selectedDatasetIds: conversation.selectedDatasetIds.includes(datasetId)
        ? conversation.selectedDatasetIds.filter((id) => id !== datasetId)
        : [...conversation.selectedDatasetIds, datasetId],
    }));
    onAction("ai.context.dataset_toggled", "/api/ai/context", datasetId);
  };

  const submitPrompt = () => {
    const question = activeConversation.draftPrompt.trim();
    if (!question || runtimeUnavailable || selectedDatasets.length === 0) return;

    updateActiveConversation((conversation) => ({
      ...conversation,
      title: conversation.messages.length === 0 ? titleFromQuestion(question) : conversation.title,
      messages: [...conversation.messages, {
        id: `user-${Date.now()}`,
        content: question,
        contextNames: selectedDatasets.map((dataset) => dataset.name),
      }],
      draftPrompt: "",
      runtimeUnavailable: true,
    }));
    setContextOpen(false);
    onAction("ai.chat.prompt_drafted", "/api/ai/conversations", activeConversation.selectedDatasetIds.join(","));
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
          <button aria-label="현재 대화 삭제" className="secondary-button ai-delete-conversation" title="현재 대화 삭제" type="button" onClick={deleteActiveConversation}>
            <Trash2 size={15} />
          </button>
          <div className="ai-context-picker" ref={contextPickerRef}>
            <button aria-expanded={contextOpen} className="secondary-button ai-context-trigger" disabled={runtimeUnavailable} type="button" onClick={() => setContextOpen((open) => !open)}>
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
          <button className="secondary-button ai-new-conversation" type="button" onClick={startNewConversation}>
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
                <h2>데이터에 대해 질문하세요</h2>
                <p>답변에 사용할 Lake 데이터셋을 선택한 뒤 질문을 시작할 수 있습니다.</p>
              </div>
            </div>
          ) : null}
          {activeConversation.messages.map((message) => (
            <article className="ai-chat-message user" key={message.id}>
              <div><p>{message.content}</p><span className="ai-message-context">{message.contextNames.join(" · ")}</span></div>
              <span className="ai-chat-message-avatar"><CircleUser size={16} /></span>
            </article>
          ))}
          {runtimeUnavailable ? (
            <div className="ai-runtime-pending" role="status">
              <Bot size={16} />
              <span>AI runtime 연결 대기</span>
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
          {suggestedQuestions.map((question) => <button disabled={runtimeUnavailable} key={question} type="button" onClick={() => chooseSuggestedQuestion(question)}>{question}</button>)}
        </div>
        <div className="ai-chat-composer" aria-label="AI 질문 입력">
          <textarea aria-label="AI 질문" disabled={runtimeUnavailable} placeholder="Lake 데이터에 대해 질문하세요" ref={composerRef} rows={2} value={activeConversation.draftPrompt} onChange={(event) => updateActiveConversation((conversation) => ({ ...conversation, draftPrompt: event.target.value }))} onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submitPrompt();
            }
          }} />
          <button aria-label="AI 질문 전송" disabled={!activeConversation.draftPrompt.trim() || runtimeUnavailable || selectedDatasets.length === 0} title={selectedDatasets.length === 0 ? "질문에 사용할 데이터셋을 선택하세요." : undefined} type="button" onClick={submitPrompt}><Send size={18} /></button>
        </div>
      </footer>
    </section>
  );
}
