# AI Chat UI Contract

Issue: #471

## Purpose

`AI 활용` 메뉴는 AskLake의 독립 대화형 UI surface다. 나만무 프로젝트의 `AiQueryPage`에서 대화 thread와 composer의 정보 구조를 참고하지만, AskLake의 Catalog Dataset과 권한 모델에 맞게 다시 구현한다.

이 화면은 SQL 분석의 Query AI와 Dashboard Assistant를 대체하거나 감싸지 않는다. 각각의 기존 API와 동작 경계는 유지한다.

## Phase 0 Boundary

UI-only 단계에서 제공하는 것은 다음과 같다.

- Header, empty state, 추천 질문, 대화 thread, 고정 composer
- 새 대화와 입력값의 in-memory 상태
- Catalog Dataset context 선택 및 선택 표시
- query 권한이 없는 Dataset 제외

이 단계에서 제공하지 않는 것은 다음과 같다.

- `POST /api/ai/*` 또는 새로운 AI backend API
- OpenAI 호출, embedding, chunking, RAG index, vector DB
- mock 분석 결과, 가짜 근거, 가짜 SQL, 가짜 결과 테이블
- `localStorage` 또는 `sessionStorage` 대화 영속화

## UI Structure

화면은 아래 순서를 유지한다.

1. 대화 header: 새 대화와 선택 Dataset context의 진입점
2. scrollable thread: empty state 또는 사용자 질문/향후 assistant 응답 카드
3. composer: 추천 질문 chip, textarea, send icon button

Dataset context는 ChatGPT형 집중 레이아웃을 해치지 않도록 header 또는 composer 상단 chip으로 표현한다. Dataset 탐색은 필요할 때만 여는 compact selector로 제공하며 상시 넓은 우측 패널은 사용하지 않는다.

## Local State

```ts
type AiChatDraft = {
  messages: Array<{ id: string; role: "user" | "assistant"; content: string }>;
  prompt: string;
  selectedDatasetIds: string[];
  submissionState: "idle" | "awaiting_runtime";
};
```

- `messages`, `prompt`, `selectedDatasetIds`는 화면이 살아 있는 동안에만 유지한다.
- 질문 전송은 사용자 메시지를 thread에 추가하고 `awaiting_runtime` 상태를 표시할 수 있다.
- runtime이 연결되기 전에는 assistant message를 임의로 만들지 않는다.
- 새 대화는 `messages`, `prompt`, `submissionState`만 초기화하고, 사용자가 고른 Dataset context는 유지한다.

## Dataset Eligibility

대화 context 후보는 현재 hydrate된 `CatalogDataset`만 사용한다.

```ts
dataset.status === "available" && dataset.permissions?.canQuery !== false
```

이 UI 필터는 사용성 보조다. 후속 AI API는 선택된 모든 Dataset에 대해 backend `query` permission check를 다시 수행해야 한다.

## Future Runtime Contract

후속 backend 연결은 선택 Dataset ID와 prompt를 함께 전달한다. assistant response는 답변 본문 외에 선택적으로 다음 block을 포함할 수 있다.

- evidence: Dataset, run, lineage 근거
- sqlDraft: 검토 후 실행하는 read-only SQL 초안
- resultPreview: 행/컬럼 미리보기
- dashboardAction: 사용자가 확인 후 적용하는 dashboard 제안

각 block은 backend guard와 Dataset permission check를 통과한 뒤에만 UI에서 활성화한다. 답변은 자동으로 SQL 실행, Dashboard 변경, Dataset 생성으로 이어지지 않는다.

## Verification

1. AI 활용 메뉴가 ChatGPT형 empty state와 composer를 보여준다.
2. 사용 가능한 Dataset만 context selector에 표시된다.
3. Dataset 선택/해제, Enter 전송, Shift+Enter 줄바꿈, 새 대화가 로컬 상태에서 동작한다.
4. backend가 없는 상태에서 가짜 분석 답변이나 근거를 렌더링하지 않는다.
5. desktop/mobile에서 composer와 message thread가 겹치지 않는다.
