# AskLake Realtime 4-PR 작업 상태 원장

> 이 저장소에서는 원본 9개 PR 문서를 4개의 stacked PR로 실행한다. 상세 체크리스트는 원본 문서를 그대로 사용하고, 진행 상태는 이 파일만 권위로 사용한다.

## 현재 제어값

```yaml
current_pr: null
last_completed_pr: STACK-04
next_ready_pr: null
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
| STACK-02 | DONE | PR-02, PR-03, PR-04 | durable SSE backend·frontend·infra | #811 / `feat-#811` / #815 Draft |
| STACK-03 | DONE | PR-05, PR-06 | continuous SQL planner·runtime·publication | #816 / `feat-#816` / #822 Draft |
| STACK-04 | DONE | PR-07, PR-08 | E2E·복구·보안·CI·rollout·최종 감사 | #823 / `feat-#823` / #826 Draft |

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

### STACK-02

- Dataset revision·Dashboard publish와 같은 transaction에 versioned durable event를 기록한다.
- PostgreSQL cursor replay, process당 LISTEN listener, bounded hub, heartbeat·resync·ACL·connection limit이 있는 SSE endpoint를 추가했다.
- React Dashboard가 event를 Dataset별 coalesce해 affected widget만 REST refetch하고 publish/resync는 silent snapshot refresh한다.
- polling/hybrid/sse, offline, heartbeat watchdog과 fallback polling을 구현하고 현재 상태를 화면 badge로 표시한다.
- Caddy/NGINX streaming 설정, readiness/status, env·capacity guardrail과 contract 검증 스크립트를 추가했다.
- backend 80 tests, frontend UI 132 checks, realtime transport 5 tests, production build, Python compile, Compose config와 diff check가 통과했다.
- Docker daemon이 꺼져 Caddy container validate와 NGINX `-t`는 실행하지 못했으며 STACK-04 실제 proxy 통합 검증에 남겼다.

### STACK-03

- 시작 기준: `feat-#811`의 `72a4dffe`, `origin/dev`의 `b93ae273`이 조상임을 확인했다.
- 기준선: SQL route/auth 및 Kafka Continuous runtime/publication 회귀 39개 테스트가 통과했다.
- Issue/branch: #816 / `feat-#816`.
- Draft PR: #822 (`feat-#816 -> dev`), 선행 #815 merge 후 review-ready 전환.
- SQL AST planner, persisted Job/Run/Batch/command, generation/fencing lifecycle을 구현했다.
- PINNED/LATEST batch-local static binding과 Spark JOIN adapter, exact Iceberg 검증 및 3단계 publication을 구현했다.
- API는 fencing token 원문을 숨기고 start/resume/recover 때 입력 권한·governance를 다시 검사한다.
- Continuous SQL contract 17개와 기존 경로를 포함한 focused 56개 테스트, Kafka contract/REST manager, compile/Compose 검증이 통과했다.
- 전체 backend discovery의 기존 3개 drift는 결과 문서에 별도로 기록했고 이번 branch에서 범위를 넓혀 수정하지 않았다.
- 실제 Spark/Iceberg/Trino fault·restart·soak는 STACK-04 opt-in gate로 이관했다.

### STACK-04

- 시작 기준: `feat-#816`의 `243b70a5`, `origin/dev`의 `b93ae273`이 조상임을 확인했다.
- Issue/branch: #823 / `feat-#823`.
- Draft PR: #826 (`feat-#823 -> dev`), 선행 #822 merge 후 review-ready 전환.
- backend recovery/security/Continuous SQL focused 63 tests, frontend UI 132 checks, realtime transport 7 tests, Dashboard refresh 6 tests와 production build가 통과했다.
- production Compose render, proxy/architecture static gate, Continuous SQL 17 tests와 Kafka contract/REST가 통과했다.
- PR용 disposable PostgreSQL·Caddy/NGINX parser gate와 scheduled/manual Kafka/Spark/Iceberg fault harness를 추가했다.
- canary/rollback/production runbook, handover와 항목별 final audit를 작성했다.
- Docker client는 설치되어 있으나 Docker Desktop daemon이 꺼져 실제 container/proxy/Spark E2E는 local에서 실행하지 못했다. production 활성화는 CI와 operator evidence 전까지 No-Go다.
- 전체 backend discovery의 기존 3개 drift는 결과 문서에 기록했으며 이번 branch에서 범위를 넓혀 수정하지 않았다.
