import { Bot, CircleUser, Plus, Send, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const suggestedQuestions = [
  "이번 주 리뷰에서 반복되는 불만을 요약해줘",
  "평점이 낮은 상품군을 찾아줘",
  "최근 실행된 데이터셋의 품질을 비교해줘",
];

type UserMessage = {
  id: string;
  content: string;
};

export function AiChatPage({
  onAction,
}: {
  onAction: (action: string, apiPath: string, targetId: string) => void;
}) {
  const [messages, setMessages] = useState<UserMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [awaitingRuntime, setAwaitingRuntime] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

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

  const submitPrompt = () => {
    const question = prompt.trim();
    if (!question || awaitingRuntime) return;

    setMessages((current) => [...current, { id: `user-${Date.now()}`, content: question }]);
    setPrompt("");
    setAwaitingRuntime(true);
    onAction("ai.chat.prompt_drafted", "/api/ai/conversations", "draft");
  };

  return (
    <section className="ai-chat-page" aria-label="AI 활용">
      <header className="ai-chat-header">
        <div className="ai-chat-title">
          <span><Sparkles size={15} /> AskLake AI</span>
          <h1>AI 활용</h1>
        </div>
        <button className="secondary-button ai-new-conversation" type="button" onClick={startNewConversation}>
          <Plus size={15} />
          새 대화
        </button>
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
              <p>{message.content}</p>
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
          <button aria-label="AI 질문 전송" disabled={!prompt.trim() || awaitingRuntime} type="button" onClick={submitPrompt}><Send size={18} /></button>
        </div>
      </footer>
    </section>
  );
}
