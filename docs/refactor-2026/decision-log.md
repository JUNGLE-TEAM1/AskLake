# 리팩토링 결정 로그

## D-001 — 26단계를 15개 PR로 축약

- 상태: Accepted
- 결정: 원본 Stage의 선행 관계와 rollback 경계를 유지하면서 인접 작업을 15개 PR로 묶는다.
- 이유: 34개 이상 PR의 운영 부담을 줄이되 big-bang PR은 피한다.
- 제약: 한 PR에서 독립 rollback이 불가능해지면 구현을 중단하고 사용자에게 재분할을 보고한다.

## D-002 — 3개 PR 단위 승인 gate

- 상태: Accepted
- 결정: 한 번에 3개 PR까지만 구현·생성하고 다음 배치 전에 사용자 승인을 받는다.
- 이유: 장기 작업의 context drift와 대규모 미검토 변경 누적을 막는다.

## D-003 — 모든 PR은 `dev` 대상 stacked branch

- 상태: Accepted
- 결정: PR 02는 PR 01 branch HEAD, PR 03은 PR 02 branch HEAD에서 시작하지만 GitHub base는 모두 `dev`로 둔다.
- 이유: 사용자가 모든 PR을 `dev`로 요청했고 순서대로 merge할 수 있어야 한다.
- 운영: 반드시 PR 01 → 02 → 03 순으로 merge하고, 앞 PR merge 뒤 다음 PR diff와 CI를 다시 확인한다.

## D-004 — 최신 HEAD 우선

- 상태: Accepted
- 결정: 감사 커밋은 비교 기준으로만 사용하고 최신 `dev@b93ae273`를 변경 기준으로 사용한다.
- 이유: PR #793의 최신 UI 계약을 덮어쓰지 않기 위해서다.

## D-005 — PR 01은 동작 변경 금지

- 상태: Accepted
- 결정: 기준선 수집기, deterministic artifact, 문서만 추가한다.
- 이유: 변경 전 실패와 이후 regression을 구분하려면 기준선 PR 자체가 제품 동작을 바꾸면 안 된다.

## D-006 — Python 3.10+ 기준

- 상태: Accepted
- 결정: backend baseline 검증은 Python 3.10 이상 가상환경을 사용한다.
- 이유: `mcp==1.28.1`이 Python 3.10 이상을 요구하며 macOS 기본 Python 3.9에서는 dependency install이 실패한다.

## D-007 — DB·API 호환은 expand-first

- 상태: Accepted
- 결정: 이후 상태 계약 변경은 additive field/table을 먼저 도입하고 기존 persisted Job/Run/checkpoint/manifest를 유지한다.
- 이유: 운영 데이터와 구버전 worker의 동시 호환을 보장하기 위해서다.

## D-008 — Continuous 상태 계약은 기존 metrics JSON에 확장

- 상태: Accepted
- 결정: desired/observed state, command revision, active worker fencing과 structured error를 기존 `kafka_continuous_runtimes.metrics.runtimeContract`에 저장한다.
- 이유: destructive migration 없이 기존 Job/session/checkpoint/report와 이전 backend rollback을 모두 유지하기 위해서다.
- 제약: 기존 `status`, `lastError`, `currentWorkerAttemptId`는 제거하지 않고 호환 projection/mirror로 유지한다.

## D-009 — 기준선 3개 실패는 제품 변경 없이 test drift로 정리

- 상태: Accepted
- 결정: Data Lake review의 현재 label과 Spark source identity 실행 seam을 source of truth로 보고 stale assertion/fixture만 수정한다.
- 이유: 제품 동작을 되돌리면 현재 UI/API 계약이 회귀하고, 실패 원인은 테스트가 이름과 함수 경계 변경을 따라가지 못한 것이기 때문이다.

## D-010 — Legacy adapter는 관측 후 제거하고 production mock은 차단

- 상태: Accepted
- 결정: 기존 Job·session·checkpoint·draft reader는 migration window 동안 유지하되 production 도달 시 안정적인 path ID의 구조화 warning과 counter를 남긴다.
- 이유: 문자열 검색 결과를 일괄 삭제하면 운영 데이터를 깨뜨리고, 무음 fallback을 유지하면 실제 경로와 제거 시점을 판단할 수 없기 때문이다.
- 제약: 운영 빌드에서 `VITE_USE_MOCK_API=true`는 fail closed 한다. adapter 제거는 등록부의 owner·제거 조건과 30일 0-call 근거를 충족한 별도 PR에서 수행한다.

## D-011 — 최종 판정은 guarded GO, production은 fail-closed

- 상태: Accepted
- 결정: deterministic CI와 canary 준비는 허용하되 격리 nightly fault, production clean reboot, backup/restore drill이 없으면 production 실행 사전점검을 exit 2로 차단한다.
- 이유: P0는 해소됐지만 `etl_service.py`, global CSS, Node connector, compatibility cleanup P1이 남았고 production host 증거를 로컬 contract test로 대체할 수 없기 때문이다.
- 제약: production 배포, EC2 reboot, traffic 전환은 별도 명시적 승인 없이 실행하지 않는다.

## D-012 — 리팩토링 완료 선언과 release readiness를 분리

- 상태: Accepted
- 결정: 현재 release는 하위 호환 구조 개선 release로 취급하고 “전체 아키텍처 리팩토링 완료”로 선언하지 않는다.
- 이유: 5,000줄 이상 파일은 3→1로 줄었지만 `etl_service.py`가 8,822줄이며 END_STATE 1,200줄 목표와 얇은 façade 조건을 충족하지 못한다.

## D-013 — 배포 UI를 유지하고 compatibility façade를 활성 composition에서 제외

- 상태: Accepted
- 결정: 최신 `dev`와 현재 배포 UI의 route·DOM·CSS·API 동작을 유지하면서 `App.tsx`는 Job과 workspace canonical module을 직접 import한다.
- 이유: 후속 backend/runtime 모듈화가 과거 façade 구현을 다시 활성화하거나 UI 변경과 섞이지 않도록 하기 위해서다.
- 제약: `EtlPages.tsx`, `JobsPages.tsx`, `useAskLakeData.ts`는 이전 import reader로만 보존하며 신규 source import를 CI에서 차단한다. production mock과 legacy demo UI 기본값은 계속 `false`다.
