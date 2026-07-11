import { Bot, Check, ChevronDown, CircleUser, Database, Plus, Send, Sparkles } from "lucide-react";
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

export function AiChatPage({
  datasets,
  onAction,
}: {
  datasets: CatalogDataset[];
  onAction: (action: string, apiPath: string, targetId: string) => void;
}) {
  const [messages, setMessages] = useState<UserMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [awaitingRuntime, setAwaitingRuntime] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [selectedDatasetIds, setSelectedDatasetIds] = useState<string[]>([]);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const availableDatasets = useMemo(
    () => datasets.filter((dataset) => dataset.status === "available" && dataset.permissions?.canQuery !== false),
    [datasets],
  );
  const selectedDatasets = availableDatasets.filter((dataset) => selectedDatasetIds.includes(dataset.id));

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, awaitingRuntime]);

  const startNewConversation = () => {
    setMessages([]);
    setPrompt("");
    setAwaitingRuntime(false);
    onAction("ai.chat.new", "/api/ai/conversations", "new");
    window.setTimeout(() => composerRef.current?.focus(), 0);
  };

  const chooseSuggestedQuestion = (question: string) => {
    if (awaitingRuntime) return;
    setPrompt(question);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  };

  const toggleDataset = (datasetId: string) => {
    if (awaitingRuntime) return;
    setSelectedDatasetIds((current) => current.includes(datasetId)
      ? current.filter((id) => id !== datasetId)
      : [...current, datasetId]);
    onAction("ai.context.dataset_toggled", "/api/ai/context", datasetId);
  };

  const submitPrompt = () => {
    const question = prompt.trim();
    if (!question || awaitingRuntime || selectedDatasets.length === 0) return;

    setMessages((current) => [...current, {
      id: `user-${Date.now()}`,
      content: question,
      contextNames: selectedDatasets.map((dataset) => dataset.name),
    }]);
    setPrompt("");
    setAwaitingRuntime(true);
    setContextOpen(false);
    onAction("ai.chat.prompt_drafted", "/api/ai/conversations", selectedDatasetIds.join(","));
  };

  return (
    <section className="ai-chat-page" aria-label="AI 활용">
      <header className="ai-chat-header">
        <div className="ai-chat-title">
          <span><Sparkles size={15} /> AskLake AI</span>
          <h1>AI 활용</h1>
        </div>
        <div className="ai-chat-actions">
          <div className="ai-context-picker">
            <button aria-expanded={contextOpen} className="secondary-button ai-context-trigger" disabled={awaitingRuntime} type="button" onClick={() => setContextOpen((open) => !open)}>
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
                    const selected = selectedDatasetIds.includes(dataset.id);
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
        <div className={messages.length === 0 ? "ai-chat-thread empty" : "ai-chat-thread"}>
          {messages.length === 0 ? (
            <div className="ai-chat-empty">
              <span className="ai-chat-empty-mark"><Bot size={26} /></span>
              <div>
                <h2>데이터에 대해 질문하세요</h2>
                <p>답변에 사용할 Lake 데이터셋을 선택한 뒤 질문을 시작할 수 있습니다.</p>
              </div>
            </div>
          ) : null}
          {messages.map((message) => (
            <article className="ai-chat-message user" key={message.id}>
              <div><p>{message.content}</p><span className="ai-message-context">{message.contextNames.join(" · ")}</span></div>
              <span className="ai-chat-message-avatar"><CircleUser size={16} /></span>
            </article>
          ))}
          {awaitingRuntime ? (
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
          {suggestedQuestions.map((question) => <button disabled={awaitingRuntime} key={question} type="button" onClick={() => chooseSuggestedQuestion(question)}>{question}</button>)}
        </div>
        <div className="ai-chat-composer" aria-label="AI 질문 입력">
          <textarea aria-label="AI 질문" disabled={awaitingRuntime} placeholder="Lake 데이터에 대해 질문하세요" ref={composerRef} rows={2} value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submitPrompt();
            }
          }} />
          <button aria-label="AI 질문 전송" disabled={!prompt.trim() || awaitingRuntime || selectedDatasets.length === 0} title={selectedDatasets.length === 0 ? "질문에 사용할 데이터셋을 선택하세요." : undefined} type="button" onClick={submitPrompt}><Send size={18} /></button>
        </div>
      </footer>
    </section>
  );
}
