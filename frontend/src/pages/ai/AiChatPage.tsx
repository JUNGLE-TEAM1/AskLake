import { Braces, Check, ChevronDown, CircleUser, Database, FileText, LayoutGrid, PanelLeftClose, PanelLeftOpen, Plus, Send, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import askLakeNessiIconUrl from "../../assets/asklake-nessi-icon.png";
import type { CatalogDataset } from "../../types";

const suggestedQuestions = [
  "이번 주 리뷰에서 반복되는 불만을 요약해줘",
  "평점이 낮은 상품군을 찾아줘",
  "최근 실행된 데이터셋의 품질을 비교해줘",
];

type SubmissionState = "idle" | "runtime_unavailable";

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
  submissionState: SubmissionState;
  createdAt: string;
  updatedAt: string;
};

function createConversation(): Conversation {
  const now = new Date().toISOString();
  return {
    id: `conversation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: "새 대화",
    messages: [],
    draftPrompt: "",
    selectedDatasetIds: [],
    submissionState: "idle",
    createdAt: now,
    updatedAt: now,
  };
}

function titleFromQuestion(question: string) {
  const normalized = question.replace(/\s+/g, " ").trim();
  return normalized.length > 30 ? `${normalized.slice(0, 30)}...` : normalized || "새 대화";
}

function NessiMark({ className = "" }: { className?: string }) {
  return <img alt="" aria-hidden="true" className={`ai-nessi-mark ${className}`.trim()} src={askLakeNessiIconUrl} />;
}

function AiResponsePendingCard() {
  return (
    <article className="ai-assistant-message" aria-label="AI runtime 미연결">
      <span className="ai-assistant-avatar"><NessiMark /></span>
      <div className="ai-response-pending-card">
        <div className="ai-response-pending-heading">
          <strong>Nessie runtime 미연결</strong>
          <span>실제 응답을 생성하지 않았습니다.</span>
        </div>
        <div className="ai-response-blocks" aria-label="응답 구성">
          <button disabled type="button"><FileText size={15} /><span>근거</span><small>미연결</small></button>
          <button disabled type="button"><Braces size={15} /><span>SQL</span><small>미연결</small></button>
          <button disabled type="button"><Database size={15} /><span>결과</span><small>미연결</small></button>
          <button disabled type="button"><LayoutGrid size={15} /><span>대시보드</span><small>미연결</small></button>
        </div>
      </div>
    </article>
  );
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
  const [conversationDrawerOpen, setConversationDrawerOpen] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const contextPickerRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const availableDatasets = useMemo(
    () => datasets.filter((dataset) => dataset.status === "available" && dataset.permissions?.canQuery !== false),
    [datasets],
  );
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId) ?? conversations[0];
  const selectedDatasets = availableDatasets.filter((dataset) => activeConversation.selectedDatasetIds.includes(dataset.id));
  const runtimeUnavailable = activeConversation.submissionState === "runtime_unavailable";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeConversation.id, activeConversation.messages.length, activeConversation.submissionState]);

  useEffect(() => {
    if (!contextOpen) return undefined;
    const closeContextOnEscapeOrOutsideClick = (event: KeyboardEvent | MouseEvent) => {
      if (event instanceof KeyboardEvent && event.key === "Escape") {
        setContextOpen(false);
      }
      if (event instanceof MouseEvent && !contextPickerRef.current?.contains(event.target as Node)) {
        setContextOpen(false);
      }
    };
    document.addEventListener("keydown", closeContextOnEscapeOrOutsideClick);
    document.addEventListener("mousedown", closeContextOnEscapeOrOutsideClick);
    return () => {
      document.removeEventListener("keydown", closeContextOnEscapeOrOutsideClick);
      document.removeEventListener("mousedown", closeContextOnEscapeOrOutsideClick);
    };
  }, [contextOpen]);

  const updateActiveConversation = (update: (conversation: Conversation) => Conversation) => {
    setConversations((current) => current.map((conversation) => conversation.id === activeConversation.id ? update(conversation) : conversation));
  };

  const startNewConversation = () => {
    const nextConversation = createConversation();
    setConversations((current) => [nextConversation, ...current]);
    setActiveConversationId(nextConversation.id);
    setContextOpen(false);
    setConversationDrawerOpen(false);
    onAction("ai.chat.new", "/api/ai/conversations", nextConversation.id);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  };

  const selectConversation = (conversationId: string) => {
    setActiveConversationId(conversationId);
    setContextOpen(false);
    setConversationDrawerOpen(false);
    onAction("ai.chat.selected", "/api/ai/conversations", conversationId);
  };

  const deleteConversation = (conversationId: string) => {
    setConversations((current) => {
      const remaining = current.filter((conversation) => conversation.id !== conversationId);
      if (remaining.length === 0) {
        const replacement = createConversation();
        setActiveConversationId(replacement.id);
        return [replacement];
      }
      if (conversationId === activeConversationId) {
        setActiveConversationId(remaining[0].id);
      }
      return remaining;
    });
    setContextOpen(false);
    onAction("ai.chat.deleted", "/api/ai/conversations", conversationId);
  };

  const chooseSuggestedQuestion = (question: string) => {
    if (runtimeUnavailable) return;
    updateActiveConversation((conversation) => ({ ...conversation, draftPrompt: question, updatedAt: new Date().toISOString() }));
    window.setTimeout(() => composerRef.current?.focus(), 0);
  };

  const toggleDataset = (datasetId: string) => {
    if (runtimeUnavailable) return;
    updateActiveConversation((conversation) => ({
      ...conversation,
      selectedDatasetIds: conversation.selectedDatasetIds.includes(datasetId)
        ? conversation.selectedDatasetIds.filter((id) => id !== datasetId)
        : [...conversation.selectedDatasetIds, datasetId],
      updatedAt: new Date().toISOString(),
    }));
    onAction("ai.context.dataset_toggled", "/api/ai/context", datasetId);
  };

  const submitPrompt = () => {
    const question = activeConversation.draftPrompt.trim();
    if (!question || runtimeUnavailable || selectedDatasets.length === 0) return;

    const contextNames = selectedDatasets.map((dataset) => dataset.name);
    updateActiveConversation((conversation) => ({
      ...conversation,
      title: conversation.messages.length === 0 ? titleFromQuestion(question) : conversation.title,
      messages: [...conversation.messages, { id: `user-${Date.now()}`, content: question, contextNames }],
      draftPrompt: "",
      submissionState: "runtime_unavailable",
      updatedAt: new Date().toISOString(),
    }));
    setContextOpen(false);
    onAction("ai.chat.prompt_drafted", "/api/ai/conversations", activeConversation.selectedDatasetIds.join(","));
  };

  return (
    <section className="ai-chat-page" aria-label="AI 활용">
      {conversationDrawerOpen ? <button aria-label="대화 목록 닫기" className="ai-conversation-backdrop" type="button" onClick={() => setConversationDrawerOpen(false)} /> : null}
      <aside className={conversationDrawerOpen ? "ai-conversation-sidebar open" : "ai-conversation-sidebar"} aria-label="대화 목록">
        <div className="ai-conversation-sidebar-header">
          <strong><NessiMark /> Nessie</strong>
          <button aria-label="대화 목록 닫기" className="icon-button ai-conversation-close" type="button" onClick={() => setConversationDrawerOpen(false)}><PanelLeftClose size={17} /></button>
        </div>
        <button className="ai-sidebar-new-conversation" type="button" onClick={startNewConversation}><Plus size={15} /> 새 대화</button>
        <div className="ai-conversation-list">
          {conversations.map((conversation) => (
            <div className={conversation.id === activeConversation.id ? "ai-conversation-row active" : "ai-conversation-row"} key={conversation.id}>
              <button aria-current={conversation.id === activeConversation.id ? "page" : undefined} className="ai-conversation-item" type="button" onClick={() => selectConversation(conversation.id)}>
                <span>{conversation.title}</span>
                <small>{conversation.messages.length > 0 ? `${conversation.messages.length}개 질문` : "빈 대화"}</small>
              </button>
              <button aria-label={`대화 삭제: ${conversation.title}`} className="ai-conversation-delete" title="대화 삭제" type="button" onClick={() => deleteConversation(conversation.id)}><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
      </aside>

      <main className="ai-chat-workspace">
        <header className="ai-chat-header">
          <div className="ai-chat-title">
            <span><NessiMark /> Nessie</span>
            <h1>AI 활용</h1>
          </div>
          <div className="ai-chat-actions">
            <button aria-expanded={conversationDrawerOpen} aria-label="대화 목록 열기" className="icon-button ai-conversation-toggle" type="button" onClick={() => setConversationDrawerOpen(true)}><PanelLeftOpen size={18} /></button>
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
          </div>
        </header>

        <div className="ai-chat-scroll">
          <div className={activeConversation.messages.length === 0 ? "ai-chat-thread empty" : "ai-chat-thread"}>
            {activeConversation.messages.length === 0 ? (
              <div className="ai-chat-empty">
                <span className="ai-chat-empty-mark"><NessiMark /></span>
                <div>
                  <h2>Nessie에게 무엇이든 물어보세요</h2>
                  <p>Lake 데이터셋을 선택하고 질문을 시작하세요.</p>
                </div>
                <div className="ai-empty-suggestions" aria-label="추천 질문">
                  {suggestedQuestions.map((question) => <button disabled={runtimeUnavailable} key={question} type="button" onClick={() => chooseSuggestedQuestion(question)}>{question}</button>)}
                </div>
              </div>
            ) : null}
            {activeConversation.messages.map((message) => (
              <article className="ai-chat-message user" key={message.id}>
                <div><p>{message.content}</p><span className="ai-message-context">{message.contextNames.join(" · ")}</span></div>
                <span className="ai-chat-message-avatar"><CircleUser size={16} /></span>
              </article>
            ))}
            {runtimeUnavailable ? <AiResponsePendingCard /> : null}
            <div ref={messagesEndRef} />
          </div>
        </div>

        <footer className="ai-chat-composer-shell">
          {selectedDatasets.length > 0 ? (
            <div className="ai-selected-context" aria-label="선택된 대화 데이터셋">
              {selectedDatasets.map((dataset) => <span key={dataset.id}><Database size={13} />{dataset.name}</span>)}
            </div>
          ) : null}
          <div className="ai-chat-composer" aria-label="AI 질문 입력">
            <textarea aria-label="AI 질문" disabled={runtimeUnavailable} placeholder="Lake 데이터에 대해 질문하세요" ref={composerRef} rows={2} value={activeConversation.draftPrompt} onChange={(event) => updateActiveConversation((conversation) => ({ ...conversation, draftPrompt: event.target.value, updatedAt: new Date().toISOString() }))} onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submitPrompt();
              }
            }} />
            <button aria-label="AI 질문 전송" disabled={!activeConversation.draftPrompt.trim() || runtimeUnavailable || selectedDatasets.length === 0} title={selectedDatasets.length === 0 ? "질문에 사용할 데이터셋을 선택하세요." : undefined} type="button" onClick={submitPrompt}><Send size={18} /></button>
          </div>
        </footer>
      </main>
    </section>
  );
}
