# 13 — 프런트엔드 상태 소유권 기반 정리 Codex 프롬프트

## 목표

ETL wizard와 Job 운영 화면을 분해하기 전에 server state, draft state, route state, mutation state, presentation state의 소유권을 명확히 하고 stale polling/optimistic rollback 문제를 차단한다.

## Codex에 전달할 프롬프트

현재 dependency와 패턴을 읽고, 새로운 상태 라이브러리를 자동 도입하지 말고 가장 작은 안전한 foundation을 구현하라.

### 먼저 조사할 것

- `useAskLakeData.ts`의 데이터와 mutation 목록
- `EtlPages.tsx`, `JobsPages.tsx`, `CatalogPage.tsx`의 hook 사용
- API client와 response normalization
- router와 URL parameter
- localStorage/sessionStorage fallback
- polling timer와 request cancellation
- 이미 TanStack Query/SWR/Redux/Zustand 등이 설치되어 있는지

### 구현 작업

1. route별 state ownership 표를 작성한다.
2. API DTO→domain model→view model 변환 경계를 만든다.
3. server state는 한 cache/query 계층이 소유하게 한다. 기존 dependency가 적합하면 사용하고, 없으면 작고 명시적인 cache layer를 만든다.
4. wizard draft는 reducer/form state로 분리하고 server polling이 덮지 못하게 한다.
5. mutation은 command pending/accepted/reconciled/failed를 구분한다.
6. polling은 한 owner만 가지며 AbortController 또는 request sequence로 stale response를 무시한다.
7. query key/cache key에 job/session/version을 포함한다.
8. 기존 `useAskLakeData`는 façade로 유지해 한 번에 모든 caller를 깨지 않는다.
9. error model은 backend의 단계별 error code를 보존한다.
10. behavior test와 hook test를 추가한다.

### 선택 기준

상태 라이브러리를 새로 도입하려면 다음을 비교해 decision note를 남긴다.

- 현재 dependency와 bundle 영향
- SSR 필요 여부
- polling/cancellation/mutation 지원
- migration 중 façade 유지 가능성
- team 학습 비용

### 완료 기준

- server response가 편집 중 draft를 덮지 않는다.
- stale polling response가 최신 상태를 덮지 않는다.
- command optimistic state와 최종 observed state가 구분된다.
- `useAskLakeData`를 단계적으로 줄일 수 있는 adapter가 생긴다.
- 기존 URL과 화면 결과는 변하지 않는다.
