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

