import { Bot, Send, Sparkles } from "lucide-react";

const suggestedQuestions = [
  "이번 주 리뷰에서 반복되는 불만을 요약해줘",
  "평점이 낮은 상품군을 찾아줘",
  "최근 실행된 데이터셋의 품질을 비교해줘",
];

export function AiChatPage() {
  return (
    <section className="ai-chat-page" aria-label="AI 활용">
      <header className="ai-chat-header">
        <div className="ai-chat-title">
          <span><Sparkles size={15} /> AskLake AI</span>
          <h1>AI 활용</h1>
        </div>
      </header>

      <div className="ai-chat-scroll">
        <div className="ai-chat-thread empty">
          <div className="ai-chat-empty">
            <span className="ai-chat-empty-mark"><Bot size={26} /></span>
            <div>
              <h2>데이터에 대해 질문하세요</h2>
              <p>답변에 사용할 Lake 데이터셋을 선택한 뒤 질문을 시작할 수 있습니다.</p>
            </div>
          </div>
        </div>
      </div>

      <footer className="ai-chat-composer-shell">
        <div className="ai-chat-recommendations" aria-label="추천 질문">
          {suggestedQuestions.map((question) => <span key={question}>{question}</span>)}
        </div>
        <div className="ai-chat-composer" aria-label="AI 질문 입력">
          <textarea aria-label="AI 질문" placeholder="Lake 데이터에 대해 질문하세요" readOnly rows={2} />
          <button aria-label="AI 질문 전송" disabled title="다음 단계에서 활성화됩니다." type="button"><Send size={18} /></button>
        </div>
      </footer>
    </section>
  );
}
