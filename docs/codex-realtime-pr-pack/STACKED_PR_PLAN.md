# AskLake Realtime 4-PR 실행 매핑

원본 실행 팩은 9개 PR로 구성되어 있으나 AskLake 저장소의 이번 작업은 4개의 stacked PR로 병합한다. 원본 문서의 요구사항과 완료 기준은 삭제하지 않고 아래처럼 묶는다.

| Stack PR | 원본 문서 | 주요 산출물 | 다음 단계 조건 |
|---|---|---|---|
| STACK-01 | `01_PR00_DISCOVERY_AND_ADR.md`, `02_PR01_BASELINE_TESTS_AND_FLAGS.md` | 현재 흐름, ADR, baseline, 안전한 flag | 계약·rollback 기준과 baseline PASS |
| STACK-02 | `03_PR02_SSE_BACKEND_CORE.md`, `04_PR03_DASHBOARD_EVENTS_AND_FRONTEND.md`, `05_PR04_INFRA_AND_OBSERVABILITY.md` | durable event log, SSE, React sync, proxy/metric | polling rollback을 유지한 SSE E2E PASS |
| STACK-03 | `06_PR05_CONTINUOUS_SQL_CONTRACT_AND_PLANNER.md`, `07_PR06_CONTINUOUS_SQL_RUNTIME_AND_PUBLICATION.md` | planner, Job/Run/Batch, Spark JOIN, publication | pinned 기본 흐름과 idempotency PASS |
| STACK-04 | `08_PR07_VALIDATION_RECOVERY_SECURITY.md`, `09_PR08_CI_ROLLOUT_AND_FINAL_AUDIT.md` | 전체 검증, CI, canary, rollback, handover | 최종 Go/No-Go와 잔여 위험 기록 |

## Stacked branch 규칙

1. STACK-01은 최신 `dev`에서 시작한다.
2. STACK-02~04 branch는 직전 branch의 커밋을 포함한 상태에서 만든다.
3. 모든 GitHub PR base는 보호 브랜치 정책에 맞춰 `dev`를 사용한다.
4. 앞 PR이 merge되기 전 후속 PR은 Draft로 유지한다.
5. 앞 PR merge 후 다음 PR diff와 CI를 다시 확인하고 Ready로 전환한다.

## 범위 경계

- STACK-01에서 제품 코어 SSE나 Spark executor를 구현하지 않는다.
- STACK-02에서 continuous SQL planner/runtime을 구현하지 않는다.
- STACK-03에서 production rollout을 실행하지 않는다.
- STACK-04에서 승인 없는 production deploy나 destructive DB contract migration을 실행하지 않는다.
