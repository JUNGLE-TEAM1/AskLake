# AI Chat UI Contract

Issues: #471, #716

## Purpose

`AI 활용` 메뉴는 AskLake의 독립 대화형 UI surface다. 나만무 프로젝트의 `AiQueryPage`에서 대화 thread와 composer의 정보 구조를 참고하지만, AskLake의 Catalog Dataset과 권한 모델에 맞게 다시 구현한다.

이 화면은 SQL 분석의 Query AI와 Dashboard Assistant를 대체하거나 감싸지 않는다. 각각의 기존 API와 동작 경계는 유지한다.

## Live Persistence Boundary

live mode에서 제공하는 것은 다음과 같다.

- Header, empty state, 추천 질문, 대화 thread, 고정 composer
- 인증 사용자 소유의 여러 대화, 제목과 메시지 영속화
- Catalog Dataset context 선택 및 선택 표시
- query 권한이 없는 Dataset 제외
- 기존 Query AI 경계를 통한 선택 Dataset 범위의 assistant 응답 생성
- conversation `version` 기반 동시 수정 감지와 `clientRequestId` 기반 메시지 재요청 멱등성

이 범위에서 제공하지 않는 것은 다음과 같다.

- embedding, chunking, RAG index, vector DB
- mock 분석 결과, 가짜 근거, 가짜 SQL, 가짜 결과 테이블
- `localStorage` 또는 `sessionStorage`를 live mode 대화의 source of truth로 사용하는 동작

## UI Structure

화면은 아래 순서를 유지한다.

1. compact conversation sidebar: 새 대화 생성, 기존 대화 전환, 대화 삭제
2. 대화 header: 선택 Dataset context의 진입점
3. scrollable thread: empty state 또는 사용자 질문/향후 assistant 응답 카드
4. composer: 추천 질문 chip, textarea, send icon button

Dataset context는 ChatGPT형 집중 레이아웃을 해치지 않도록 header 또는 composer 상단 chip으로 표현한다. Dataset 탐색은 필요할 때만 여는 compact selector로 제공하며 상시 넓은 우측 패널은 사용하지 않는다.

## Conversation Resource

```ts
type Conversation = {
  id: string;
  title: string;
  selectedDatasetIds: string[];
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    contextNames: string[];
    notices: string[];
    sql?: string;
    createdAt: string;
  }>;
  version: number;
  createdAt: string;
  updatedAt: string;
};
```

- `GET /api/ai/conversations`는 현재 actor가 소유한 대화만 `updatedAt` 최신순으로 반환한다.
- `POST /api/ai/conversations`는 빈 대화를 만들고, `PATCH /api/ai/conversations/{conversationId}`는 `version`과 함께 제목 또는 선택 Dataset을 갱신한다.
- `GET /api/ai/conversations/{conversationId}`는 소유 대화를 단건 조회하고, `DELETE /api/ai/conversations/{conversationId}?version=`는 version 확인 뒤 소유 대화와 하위 메시지를 삭제한다.
- `POST /api/ai/conversations/{conversationId}/messages`는 `version`, 고유 `clientRequestId`, 사용자 `content`를 받는다. backend가 선택 Dataset과 권한을 재검증하고 Query AI 응답이 성공한 경우 user/assistant 메시지를 한 transaction으로 저장한다.
- 성공한 수정·메시지 응답은 증가한 `version`의 전체 Conversation을 반환하며 frontend는 이 응답으로 local cache를 교체한다.
- 같은 `version`에 대한 경쟁 수정은 `409 CONFLICT`다. 같은 대화에서 같은 `clientRequestId`를 재전송하면 이미 저장된 결과를 반환하고 메시지를 중복 생성하지 않는다.
- 다른 actor가 소유한 conversation ID는 조회·수정·삭제·메시지 추가에서 `404 NOT_FOUND`로 처리한다.
- 대화 제목은 첫 사용자 질문을 잘라 자동 설정할 수 있으며, 첫 질문 전에는 `새 대화`다.
- Dataset context는 Conversation별로 분리한다. 대화를 전환하면 저장된 messages와 Dataset context를 함께 복원한다.
- 새 대화는 선택 Dataset context를 복사하지 않는다. Dataset context는 새 대화에서 다시 선택한다.
- composer draft, active conversation ID와 pending request 표시는 화면 로컬 상태일 수 있지만 영속 데이터의 source of truth는 아니다.

## Dataset Eligibility

대화 context 후보는 현재 hydrate된 `CatalogDataset`만 사용한다.

```ts
dataset.status === "available" && dataset.permissions?.canQuery !== false
```

이 UI 필터는 사용성 보조다. conversation 생성·수정과 메시지 생성 API는 선택된 모든 Dataset의 존재와 backend `query` permission을 다시 확인한다. 삭제되었거나 권한을 잃은 Dataset이 저장된 과거 대화는 조회할 수 있지만, 해당 선택을 유지한 새 메시지 생성은 안전한 `404` 또는 `403`으로 실패하며 저장 성공으로 표시하지 않는다.

## Runtime Response Contract

assistant message는 답변 본문 외에 현재 Query AI 계약의 `notices`와 검토용 `sql`을 포함할 수 있다. 향후 다음 block을 추가할 수 있다.

- evidence: Dataset, run, lineage 근거
- sqlDraft: 검토 후 실행하는 read-only SQL 초안
- resultPreview: 행/컬럼 미리보기
- dashboardAction: 사용자가 확인 후 적용하는 dashboard 제안

각 block은 backend guard와 Dataset permission check를 통과한 뒤에만 UI에서 활성화한다. 답변은 자동으로 SQL 실행, Dashboard 변경, Dataset 생성으로 이어지지 않는다.

## Live And Mock Mode

- `VITE_USE_MOCK_API=false`에서는 `AiChatPage`가 AI conversation API adapter로 목록을 hydrate하고 모든 생성·수정·삭제·메시지 동작을 수행한다.
- 네트워크 또는 backend 오류가 발생하면 성공 상태를 만들지 않고 오류를 표시한다. optimistic UI를 사용한 경우 마지막 서버 응답으로 rollback한다.
- `VITE_USE_MOCK_API=true`에서만 브라우저 생명주기의 fixture Conversation을 사용할 수 있다. mock fixture는 live 영속화 완료의 근거가 아니다.

## Verification

1. AI 활용 메뉴가 ChatGPT형 empty state와 composer를 보여준다.
2. 사용 가능한 Dataset만 context selector에 표시된다.
3. live mode에서 Dataset 선택/해제, Enter 전송, 새 대화 생성/삭제와 대화 전환이 API 응답으로 반영되고 새로고침 뒤 복원된다.
4. 다른 actor의 대화를 읽거나 바꿀 수 없고 경쟁 수정은 `409`, 같은 메시지 재시도는 중복 없이 복구된다.
5. 삭제되었거나 권한을 잃은 Dataset context로 메시지를 전송해도 성공 메시지를 만들지 않는다.
6. backend가 없는 상태에서 가짜 분석 답변이나 근거를 렌더링하지 않는다.
7. Shift+Enter 줄바꿈, keyboard focus, Escape/outside click context close, desktop/mobile에서 composer와 message thread가 겹치지 않는다.
