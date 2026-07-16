# 15 — `JobsPages.tsx` 목록·상세·Runtime·History·DAG 분해 Codex 프롬프트

## 목표

`JobsPages.tsx`에 섞인 탐색, 상세 표현, runtime 관찰, command mutation, session/history, DAG를 feature별로 분리하고 상태 표시를 backend contract에 맞춘다.

## Codex에 전달할 프롬프트

frontend state foundation과 runtime error contract를 사용해 Job 운영 화면을 단계적으로 분해하라.

### feature 경계

- Job list/search/filter/sort
- Job detail summary/source/target
- command actions와 confirmation
- Continuous runtime/session/lag/checkpoint
- Run/session history
- DAG visualization/modal
- snapshot 실행 정보
- stage-specific error/status presentation

### 구현 작업

1. 현재 route와 component tree, data dependency를 그린다.
2. 각 feature가 필요한 query와 mutation만 소유하게 한다.
3. active Continuous polling은 한 hook/service가 소유하고 화면들은 cache를 구독한다.
4. command click 즉시의 optimistic 상태와 server accepted, runtime observed 상태를 구분한다.
5. duplicate click, 두 browser tab, stale response를 처리한다.
6. list와 detail이 서로 다른 shape를 임의 조립하지 않게 domain/view model mapper를 공유한다.
7. runtime error는 backend의 stage/error code를 사용자 문구와 운영 detail로 매핑한다.
8. DAG modal이 전체 page state를 소유하지 않게 한다.
9. extraction 순서는 list → detail → runtime → history → DAG → actions로 하되 실제 의존성에 따라 조정하고 기록한다.
10. 기존 route, filter query param, selection, scroll/focus 동작을 유지한다.

### 필수 테스트

- filter/sort/search와 URL 상태
- list에서 detail 이동
- start/pause/resume/stop optimistic→reconciled
- 실패 rollback이 최신 다른 변경을 되돌리지 않음
- 두 탭에서 stale response
- active session 전환 시 polling key 변경
- history pagination/ordering
- DAG open/close/accessibility
- stage-specific failure 표시

### 완료 기준

- `JobsPages.tsx`는 기본 목표 600줄 이하의 route composition 계층이다.
- 목록과 runtime이 같은 global hook의 implicit side effect에 의존하지 않는다.
- polling source가 중복되지 않는다.
- command와 observation이 UI에서도 구분된다.
- 기존 UX와 접근성 회귀가 없다.
