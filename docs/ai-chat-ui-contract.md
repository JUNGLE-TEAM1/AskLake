# AI Chat UI Contract

Issue: #471

## Purpose

`AI 활용` 메뉴는 AskLake의 독립 대화형 UI surface다. 나만무 프로젝트의 `AiQueryPage`에서 대화 thread와 composer의 정보 구조를 참고하지만, AskLake의 Catalog Dataset과 권한 모델에 맞게 다시 구현한다.

이 화면은 SQL 분석의 Query AI와 Dashboard Assistant를 대체하거나 감싸지 않는다. 각각의 기존 API와 동작 경계는 유지한다.

## Runtime boundary

기본 UI가 제공하는 것은 다음과 같다.

- Header, empty state, 추천 질문, 대화 thread, 고정 composer
- 여러 대화와 입력값의 in-memory 상태
- Catalog Dataset context 선택 및 선택 표시
- query 권한이 없는 Dataset 제외

현재도 제공하지 않는 것은 다음과 같다.

- 새로운 `POST /api/ai/*` API
- 임의 SQL 자동 실행, Dataset 생성, Dashboard 자동 변경
- mock 분석 결과, 가짜 근거, 가짜 SQL, 가짜 결과 테이블
- `localStorage` 또는 `sessionStorage` 대화 영속화

## UI Structure

화면은 아래 순서를 유지한다.

1. compact conversation sidebar: 새 대화 생성, 기존 대화 전환, 대화 삭제
2. 대화 header: 선택 Dataset context의 진입점
3. scrollable thread: empty state 또는 사용자 질문/assistant 응답 카드
4. composer: 추천 질문 chip, textarea, send icon button

Dataset context는 ChatGPT형 집중 레이아웃을 해치지 않도록 header 또는 composer 상단 chip으로 표현한다. Dataset 탐색은 필요할 때만 여는 compact selector로 제공하며 상시 넓은 우측 패널은 사용하지 않는다.

## Local State

```ts
type Conversation = {
  id: string;
  title: string;
  messages: Array<{ id: string; content: string; contextNames: string[] }>;
  draftPrompt: string;
  selectedDatasetIds: string[];
  submissionState: "idle" | "runtime_unavailable";
  createdAt: string;
  updatedAt: string;
};
```

- `Conversation[]`와 active conversation ID는 화면이 살아 있는 동안에만 유지한다.
- 새 대화는 빈 Conversation을 생성하고 active conversation으로 전환한다. 기존 대화는 sidebar 목록에 남는다.
- 대화 삭제는 해당 Conversation의 브라우저 메모리 상태만 제거한다. 마지막 대화를 삭제하면 빈 Conversation 하나를 즉시 생성해 active 상태를 유지한다.
- 대화 제목은 첫 사용자 질문을 잘라서 사용하며, 첫 질문 전에는 `새 대화`다.
- 질문 전송은 active conversation의 thread에 사용자 메시지를 추가하고 `runtime_unavailable` 상태를 표시할 수 있다.
- runtime이 연결되기 전에는 assistant message를 임의로 만들지 않는다.
- Dataset context와 runtime 상태는 Conversation별로 분리한다. 대화를 전환하면 해당 대화의 messages, draft prompt, Dataset context, 상태를 함께 복원한다.
- 새 대화는 선택 Dataset context를 복사하지 않는다. Dataset context는 새 대화에서 다시 선택한다.

## Dataset Eligibility

대화 context 후보는 현재 hydrate된 `CatalogDataset`만 사용한다.

```ts
dataset.status === "available" && dataset.permissions?.canQuery !== false
```

이 UI 필터는 사용성 보조다. 후속 AI API는 선택된 모든 Dataset에 대해 backend `query` permission check를 다시 수행해야 한다.

## Current Runtime Contract

`POST /api/query/ai-suggestions`는 선택 Dataset ID와 prompt를 전달받는다. assistant response는 답변 본문 외에 다음 정보를 포함할 수 있다.

- `retrieval`: published Semantic Model, serving RAG index, provenance, result count
- `sources`: 검색된 source body/title evidence
- `sql`: 검토 후 사용자가 적용·실행하는 read-only SQL 초안

각 block은 backend Semantic Model/RAG resolver와 Dataset permission check를 통과한 뒤에만 UI에서 활성화한다. 답변은 자동으로 SQL 실행, Dashboard 변경, Dataset 생성으로 이어지지 않는다.

## Verification

1. AI 활용 메뉴가 ChatGPT형 empty state와 composer를 보여준다.
2. 사용 가능한 Dataset만 context selector에 표시된다.
3. Dataset 선택/해제, Enter 전송, Shift+Enter 줄바꿈, 새 대화 생성/삭제와 대화 전환이 로컬 상태에서 동작한다.
4. backend가 없거나 Semantic Model/RAG 선행 조건이 없는 상태에서 가짜 분석 답변이나 근거를 렌더링하지 않는다.
5. keyboard focus, Escape/outside click context close, desktop/mobile에서 composer와 message thread가 겹치지 않는다.
