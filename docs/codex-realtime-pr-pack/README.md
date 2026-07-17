# AskLake SSE·지속 SQL JOIN — PR 단위 Codex 실행 팩

> **AskLake 저장소 로컬 실행 규칙:** 이 복사본은 원본 9개 PR을 4개의 stacked PR로 실행한다. `STACKED_PR_PLAN.md`와 `WORK_STATUS.md`가 PR 묶음과 현재 상태의 권위이며, `01_...`부터 `09_...`까지의 문서는 각 Stack PR의 상세 체크리스트로 사용한다.

기준일 `2026-07-16`. 기존 **39개 세부 단계·55개 Markdown 파일**의 요구사항을 빼지 않고, 실제 작업 흐름을 **9개 PR 단계·총 12개 Markdown 파일**로 합친 버전이다.

목표는 두 가지다.

1. Dashboard의 짧은 주기 polling을 durable SSE 알림 + 필요한 REST 재조회 방식으로 전환한다.
2. 실시간 relation과 정적 relation의 SQL JOIN을 Spark Structured Streaming 장기 실행 Job으로 만들고 Dashboard까지 안전하게 동기화한다.

## 가장 중요한 실행 규칙

- **한 번에 PR 하나만 수행한다.**
- 현재 PR이 끝나면 결과와 남은 작업을 기록하고 **반드시 멈춘다.**
- 사용자가 **`다음 단계 진행해`**라고 말했을 때만 `WORK_STATUS.md`에서 다음 `READY` PR을 찾아 실행한다.
- 다음 PR을 미리 구현하거나, 관련 있다는 이유로 범위를 넓히지 않는다.
- 각 PR은 독립적으로 검토·커밋·롤백 가능한 범위를 가진다.
- `No-Go` 또는 blocker가 있으면 다음 PR을 열지 않고 현재 PR을 `PARTIAL` 또는 `BLOCKED`로 남긴다.

## 사용 방법

이 폴더를 저장소의 다음 위치에 복사한다.

```text
docs/codex-realtime-pr-pack/
```

첫 작업에서는 Codex에 아래처럼 지시한다.

```text
README대로 시작해.
00_MASTER_CONTROL.md와 WORK_STATUS.md를 읽고,
현재 READY 상태인 PR 하나만 수행해.
작업이 끝나면 WORK_STATUS.md와 PR 결과 문서를 갱신하고,
이번에 한 일·검증 결과·남은 작업·다음 PR을 알려준 뒤 멈춰.
```

그다음부터는 같은 저장소에서 아래 한 문장만 사용한다.

```text
다음 단계 진행해
```

Codex는 다음 순서를 따라야 한다.

1. `README.md`를 읽는다.
2. `00_MASTER_CONTROL.md`를 읽는다.
3. `WORK_STATUS.md`에서 `READY`인 가장 낮은 PR을 찾는다.
4. 해당 PR 문서 **하나만** 읽고 실행한다.
5. 테스트와 diff를 확인한다.
6. `docs/realtime-2026/phase-results/PR-XX-*.md`를 작성한다.
7. `WORK_STATUS.md`를 갱신한다.
8. 사용자에게 완료 내용과 남은 작업을 보고한다.
9. **다음 PR을 시작하지 않고 종료한다.**

## 단계와 PR 범위

| PR | 실행 파일 | 범위 | 시작 조건 |
|---|---|---|---|
| PR-00 | `01_PR00_DISCOVERY_AND_ADR.md` | 현재 흐름·Drift 조사와 의미 확정 | 없음 — 최초 READY |
| PR-01 | `02_PR01_BASELINE_TESTS_AND_FLAGS.md` | 회귀 기준선·Characterization Test·Feature Flag | 이전 PR DONE |
| PR-02 | `03_PR02_SSE_BACKEND_CORE.md` | SSE 백엔드 코어·Durable Event Log·Replay | 이전 PR DONE |
| PR-03 | `04_PR03_DASHBOARD_EVENTS_AND_FRONTEND.md` | 도메인 이벤트 생산·React SSE 동기화·Polling 전환 | 이전 PR DONE |
| PR-04 | `05_PR04_INFRA_AND_OBSERVABILITY.md` | NGINX·ALB·Compose 스트리밍과 관측성 | 이전 PR DONE |
| PR-05 | `06_PR05_CONTINUOUS_SQL_CONTRACT_AND_PLANNER.md` | 지속 SQL 계약·Relation 분류·실행 계획 검증 | 이전 PR DONE |
| PR-06 | `07_PR06_CONTINUOUS_SQL_RUNTIME_AND_PUBLICATION.md` | Spark 지속 JOIN 실행·중복 방지·Lifecycle·Dashboard Publication | 이전 PR DONE |
| PR-07 | `08_PR07_VALIDATION_RECOVERY_SECURITY.md` | 통합 검증·E2E·재부팅 복구·성능·보안 | 이전 PR DONE |
| PR-08 | `09_PR08_CI_ROLLOUT_AND_FINAL_AUDIT.md` | CI 품질 게이트·Canary·Rollback·최종 감사 | 이전 PR DONE |

## 파일 구성

- `README.md` — 실행 방법과 `다음 단계 진행해` 프로토콜
- `00_MASTER_CONTROL.md` — 공통 규칙, 목표 아키텍처, 완료 기준, 감사 근거, 계약 예시
- `WORK_STATUS.md` — 현재 PR, 완료 내역, blocker, 남은 작업을 저장하는 단일 원장
- `01_PR00_DISCOVERY_AND_ADR.md` — 현재 흐름·Drift 조사와 의미 확정
- `02_PR01_BASELINE_TESTS_AND_FLAGS.md` — 회귀 기준선·Characterization Test·Feature Flag
- `03_PR02_SSE_BACKEND_CORE.md` — SSE 백엔드 코어·Durable Event Log·Replay
- `04_PR03_DASHBOARD_EVENTS_AND_FRONTEND.md` — 도메인 이벤트 생산·React SSE 동기화·Polling 전환
- `05_PR04_INFRA_AND_OBSERVABILITY.md` — NGINX·ALB·Compose 스트리밍과 관측성
- `06_PR05_CONTINUOUS_SQL_CONTRACT_AND_PLANNER.md` — 지속 SQL 계약·Relation 분류·실행 계획 검증
- `07_PR06_CONTINUOUS_SQL_RUNTIME_AND_PUBLICATION.md` — Spark 지속 JOIN 실행·중복 방지·Lifecycle·Dashboard Publication
- `08_PR07_VALIDATION_RECOVERY_SECURITY.md` — 통합 검증·E2E·재부팅 복구·성능·보안
- `09_PR08_CI_ROLLOUT_AND_FINAL_AUDIT.md` — CI 품질 게이트·Canary·Rollback·최종 감사

## 매 PR 종료 시 반드시 보여줄 보고

```text
[PR 단계 종료]
- 단계/판정: PR-XX / DONE | PARTIAL | BLOCKED
- 이번에 한 일:
- 유지한 기존 동작:
- 변경 파일:
- 실행한 검증과 결과:
- 실행하지 못한 검증:
- 롤백 방법:
- 발견된 위험 또는 blocker:
- 전체 남은 PR:
- 다음 READY PR:
- 중단: 다음 단계는 사용자가 “다음 단계 진행해”라고 말할 때만 시작
```

## PR 생성 원칙

- 권장 branch와 PR 제목은 각 단계 문서에 적혀 있다.
- 현재 저장소의 branch 정책이 있으면 그것을 우선한다.
- 사용자 미커밋 변경은 reset, checkout, stash, 삭제하지 않는다.
- push, merge, production deploy는 사용자가 명시했거나 저장소 자동화 정책상 허용된 경우만 수행한다.
- 권한이 없으면 변경·테스트·PR 설명까지 준비하고 `ready-to-commit` 상태로 멈춘다.

## 최종 설계 한 줄

```text
REST snapshot(revision+cursor)
  + PostgreSQL durable event log
  + LISTEN/NOTIFY wake-up
  + FastAPI SSE
  + React targeted invalidation/refetch
  + Spark stream-static JOIN
  + idempotent batch publication
```

SSE는 데이터 원본이 아니다. DB·Catalog·Iceberg·Dashboard API가 원본이고, SSE는 **무엇이 바뀌었는지 알리는 수단**이다.
