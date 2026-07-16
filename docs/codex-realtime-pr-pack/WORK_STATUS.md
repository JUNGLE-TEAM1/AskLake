# AskLake Realtime 4-PR 작업 상태 원장

> 이 저장소에서는 원본 9개 PR 문서를 4개의 stacked PR로 실행한다. 상세 체크리스트는 원본 문서를 그대로 사용하고, 진행 상태는 이 파일만 권위로 사용한다.

## 현재 제어값

```yaml
current_pr: null
last_completed_pr: STACK-01
next_ready_pr: STACK-02
last_result: DONE
updated_at: 2026-07-16
base_branch: dev
merge_order:
  - STACK-01
  - STACK-02
  - STACK-03
  - STACK-04
```

## PR 진행표

| Stack PR | 상태 | 포함 원본 단계 | 목표 | Issue / branch / PR |
|---|---|---|---|---|
| STACK-01 | DONE | PR-00, PR-01 | 계약·ADR·baseline test·feature flag | #803 / `feat-#803` / #808 |
| STACK-02 | READY | PR-02, PR-03, PR-04 | durable SSE backend·frontend·infra | 생성 예정 |
| STACK-03 | LOCKED | PR-05, PR-06 | continuous SQL planner·runtime·publication | 생성 예정 |
| STACK-04 | LOCKED | PR-07, PR-08 | E2E·복구·보안·CI·rollout·최종 감사 | 생성 예정 |

## 상태 변경 규칙

1. `LOCKED | READY | IN_PROGRESS | DONE | PARTIAL | BLOCKED`만 사용한다.
2. 현재 Stack PR이 `DONE`일 때만 다음 Stack PR을 `READY`로 바꾼다.
3. 각 branch는 직전 Stack PR branch에서 생성하되 모든 GitHub PR의 base는 `dev`다.
4. GitHub merge 순서는 `STACK-01 -> STACK-02 -> STACK-03 -> STACK-04`다.
5. 사용자 소유 미추적 파일은 Stack PR에 포함하지 않는다.
6. 각 결과는 `docs/realtime-2026/phase-results/STACK-XX-*.md`에 누적한다.

## 변경 전 기준선

| 검증 | 결과 | 기준 |
|---|---|---|
| backend Dashboard/Kafka characterization | PASS, 58 tests | `feat-#803` 작업 전 |
| frontend Dashboard live refresh | PASS, 5 tests | `feat-#803` 작업 전 |
| frontend production build | PASS | `feat-#803` 작업 전, chunk-size warning만 존재 |

## 완료 기록

### STACK-01

- 현재 Dashboard/Kafka publication·polling 흐름과 gap을 코드 기준으로 문서화했다.
- SSE change notification + REST refetch, race-free cursor, Continuous SQL V1 의미를 ADR로 확정했다.
- 5개 deployment flag와 인증된 runtime config endpoint를 추가했다.
- backend 67 tests, frontend live refresh 5 tests, frontend build, Python compile, production Compose config, diff check가 통과했다.
- 운영 기본값과 rollback은 polling/disabled다.
