# PR-07 — 통합 검증·E2E·재부팅 복구·성능·보안

## PR 경계

- 선행 PR: `PR-06`
- 다음 PR: `PR-08`
- 권장 branch: `codex/realtime-pr07-validation-recovery`
- 권장 PR 제목: `test: verify SSE and continuous SQL end to end`
- 통합된 기존 세부 단계: `30, 31, 32, 33, 34, 35`
- 작업 단위: **이 문서 전체 = PR 하나**

## 목표

백엔드·프런트·Kafka·Spark·Iceberg·Dashboard 전체 경로와 장애 복구를 자동 검증한다.

## 이번 PR에 포함

- backend envelope/event log/SSE/auth/multi-worker 계약 테스트
- frontend EventSource/cache/mode/offline/reconnect 테스트
- Kafka→Spark JOIN→Iceberg lineage harness
- continuous SQL 생성부터 Dashboard 무수동 새로고침 E2E
- process/listener/NGINX/Spark/Docker/EC2 reboot failure injection
- Spark UID 185 공유 경로 startup probe 재검증
- connection/event storm/slow client/static table 성능 검증
- tenant/cursor/ticket/CORS/CSRF/log leakage 보안 검증

## 이번 PR에서 제외

- 새 제품 기능 추가
- 테스트를 통과시키기 위한 의미 변경
- persistent volume 파괴
- production 부하 시험 실행

범위 밖 문제를 발견하면 수정하지 말라는 뜻은 아니다. 현재 PR의 테스트를 막는 직접 결함은 최소 수정할 수 있지만, 별도 기능 또는 다음 아키텍처 단계는 `WORK_STATUS.md`에 남기고 다음 PR로 미룬다.

## 시작 절차

1. `README.md`, `00_MASTER_CONTROL.md`, `WORK_STATUS.md`를 읽는다.
2. `WORK_STATUS.md`에서 이 PR이 `READY`인지 확인한다.
3. branch, HEAD, dirty tree, remote, 최근 commit을 기록한다.
4. 사용자의 미커밋 변경을 덮어쓰지 않는다.
5. 관련 baseline test와 실행 명령을 먼저 확인한다.
6. 상태를 `IN_PROGRESS`로 바꾸고 현재 PR만 수행한다.

## 공통 구현 원칙

- Big-bang rewrite를 하지 않는다.
- 감사 이후 최신 코드와 기존 리팩토링을 보존한다.
- 기존 API, Job, Dataset, checkpoint, manifest, 정적 SQL 실행을 깨지 않는다.
- 새 핵심 로직을 `etl_service.py`, `EtlPages.tsx`, `JobsPages.tsx`, `useAskLakeData.ts` 같은 God 파일에 다시 집중시키지 않는다.
- 실제 버전·auth·query cache·DB/Spark/Iceberg 경로를 저장소에서 확인한다.
- 변경 전 실패/기존 동작을 테스트로 고정한 뒤 구현한다.
- 관련 없는 formatter, lockfile, generated file 변경을 만들지 않는다.

## PR 완료 기준

- [ ] 정상·reconnect·duplicate·restart·static 변경 핵심 시나리오 자동화
- [ ] E2E에서 정상 SSE 중 polling 요청이 없음
- [ ] recovery 후 output/event/revision이 정확히 한 번 반영됨
- [ ] 미실행 검증과 환경 한계가 숨김없이 기록됨
- [ ] 현재 문서에 포함된 모든 원본 세부 작업의 필수 검증·완료 기준을 검토함
- [ ] 변경 전 baseline과 변경 후 test/build/lint/typecheck 결과를 기록함
- [ ] `git diff --stat`과 주요 diff를 검토함
- [ ] rollback/feature flag/호환성 영향을 기록함
- [ ] 결과 문서와 `WORK_STATUS.md`를 갱신함

## 종료·중단 절차

1. `docs/realtime-2026/phase-results/PR-07-validation-recovery-security.md`를 만든다.
2. `WORK_STATUS.md`에 완료 내용, 검증, blocker, 남은 세부 작업을 누적한다.
3. 완료면 이 PR을 `DONE`, 다음 PR을 `READY`로만 바꾼다.
4. 불완전하면 `PARTIAL/BLOCKED`로 두고 다음 PR은 `LOCKED` 상태를 유지한다.
5. 사용자에게 아래를 보고한다.

```text
- 이번에 완료한 작업
- 변경 파일과 계약 영향
- 실행한 테스트와 결과
- 실행하지 못한 테스트
- 롤백 방법
- 발견한 위험과 남은 세부 작업
- 전체 남은 PR 목록
- 다음 READY PR
```

6. **다음 PR 파일을 읽거나 구현하지 말고 즉시 멈춘다.**

---

# 상세 실행 체크리스트

아래는 기존 39단계 팩의 요구사항을 빠뜨리지 않고 현재 PR 범위로 합친 내용이다.

## 원본 세부 작업 — 30 — Backend 계약·통합 Test Codex 프롬프트

## 목표

event log, NOTIFY, SSE, auth, revision, continuous SQL API를 자동 회귀 시험으로 묶는다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- 현재 backend test container와 PostgreSQL fixture
- async streaming test client 지원
- migration test 방식
- multi-worker integration 실행 가능성

## 구현 작업

1. event envelope golden contract test를 만든다.
2. event log transaction/idempotency/replay/retention test를 만든다.
3. SSE chunk, heartbeat, Last-Event-ID, resync test를 만든다.
4. auth/ticket/tenant isolation test를 만든다.
5. Dashboard state+event atomic transaction test를 만든다.
6. continuous SQL create/validate/lifecycle API contract test를 만든다.
7. 두 worker 또는 동등한 multi-process test harness를 만든다.
8. 테스트가 timing flake를 만들지 않도록 virtual clock/event barrier를 사용한다.

## 필수 검증

- 전체 backend unit/contract/integration suite
- migration from pre-feature schema
- stream disconnect cleanup
- DB listener reconnect
- tenant leakage negative test

## 완료 기준

- [ ] 핵심 SSE failure mode가 자동화된다.
- [ ] DB와 stream integration이 실제 PostgreSQL로 검증된다.
- [ ] flaky sleep 기반 test가 최소화된다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 31 — Frontend Component·Transport Test Codex 프롬프트

## 목표

EventSource lifecycle, targeted invalidation, polling fallback, Dashboard revision을 자동 검증한다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- 현재 test runner, MSW/mock server, fake timer
- query cache test utility
- Dashboard component boundary
- network request assertion 방식

## 구현 작업

1. mock EventSource 또는 test SSE server adapter를 만든다.
2. connection state와 schema parsing test를 만든다.
3. event→query key invalidation mapping을 test한다.
4. duplicate/out-of-order revision과 coalescing을 test한다.
5. snapshot cursor race와 resync를 test한다.
6. polling/hybrid/sse mode별 request count를 test한다.
7. offline/reconnect/logout/tenant switch를 test한다.
8. 대형 `useAskLakeData`에 test용 분기가 추가되지 않게 한다.

## 필수 검증

- unit/component suite
- fake timer leak 없음
- SSE open 중 polling 0회
- fallback 후 polling 시작/복구 후 중단
- active Dashboard만 refetch

## 완료 기준

- [ ] 사용자 화면이 최신 revision으로 수렴한다.
- [ ] network 요청 폭주가 test로 검출된다.
- [ ] transport와 presentation test가 분리된다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 32 — Spark Continuous JOIN Test Harness Codex 프롬프트

## 목표

Kafka→Spark stream-static JOIN→Iceberg/보고서까지 production과 같은 최소 통합 환경을 만든다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- 기존 MinIO/Spark/Kafka harness와 fixture
- 실제 Spark/Iceberg image versions
- Kafka test topic 생성 도구
- checkpoint/report/output cleanup 방식

## 구현 작업

1. 작은 streaming orders와 static customers fixture를 만든다.
2. pinned snapshot, latest-per-batch, restart, duplicate batch 시나리오를 script화한다.
3. Kafka partition/offset과 output row를 자동 비교한다.
4. Iceberg snapshot/commit ID와 batch lineage를 검증한다.
5. static key duplicate, null key, schema change fixture를 추가한다.
6. harness가 기존 persistent volume을 삭제하지 않도록 isolated namespace를 사용한다.
7. CI에서 full harness가 무거우면 nightly와 PR smoke를 분리한다.

## 필수 검증

- INNER/LEFT JOIN
- static update between batches
- Spark kill/restart from checkpoint
- same batch retry
- output commit/report loss
- cleanup idempotency

## 완료 기준

- [ ] 실제 Spark Structured Streaming으로 지속 JOIN이 증명된다.
- [ ] input offset부터 output commit까지 추적된다.
- [ ] 재시작 후 duplicate가 없다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 33 — Full-stack Dashboard E2E Codex 프롬프트

## 목표

사용자 SQL 생성부터 Kafka input, JOIN output, Dashboard SSE 자동 갱신까지 한 흐름으로 검증한다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- 현재 E2E framework와 auth fixture
- dev/CI에서 Kafka record를 넣는 방법
- Dashboard tile가 SQL output Dataset을 참조하는 방법
- SSE network event를 E2E에서 관찰하는 방법

## 구현 작업

1. UI 또는 API로 continuous SQL Job을 생성한다.
2. static customer row를 준비하고 Job을 시작한다.
3. Dashboard가 초기 empty/old revision을 표시하는지 확인한다.
4. Kafka에 matching realtime record를 넣는다.
5. Spark batch와 Dataset/Dashboard revision을 기다린다.
6. SSE event 후 수동 reload 없이 tile이 최신 JOIN 결과를 표시하는지 확인한다.
7. 정상 SSE 동안 polling request가 없는지 network log로 검증한다.
8. Job stop 후 새 Kafka record가 Dashboard에 반영되지 않는지 확인한다.

## 필수 검증

- pinned static 기본 흐름
- latest-per-batch flag가 켜진 canary 흐름
- SSE disconnect/reconnect replay
- Catalog delay와 eventual Dashboard update

## 완료 기준

- [ ] 핵심 사용자 가치가 브라우저 수준에서 증명된다.
- [ ] SSE event와 REST refetch의 역할이 확인된다.
- [ ] 수동 refresh 없이 최신 JOIN 결과가 보인다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 34 — Failure·Reboot·Recovery Test Codex 프롬프트

## 목표

부분 장애와 EC2/Docker/Spark 재시작에서도 SSE와 continuous SQL이 자동 복구되는지 검증한다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- 기존 reboot smoke script와 Spark UID 185 P0 해결 상태
- Compose restart policy와 persistent volume
- checkpoint/report/event log retention
- rolling deploy 절차

## 구현 작업

1. backend process kill 중 event 생성 후 reconnect replay를 시험한다.
2. PostgreSQL NOTIFY listener connection을 끊고 catch-up을 시험한다.
3. NGINX reload와 ALB connection drain을 시험한다.
4. Spark driver kill 후 checkpoint recovery와 duplicate output을 확인한다.
5. report write 실패, Catalog timeout, Dashboard update 실패를 각각 주입한다.
6. Docker daemon restart와 가능하면 clean EC2 reboot를 자동 smoke에 포함한다.
7. Spark shared directory 존재/UID 185 쓰기 가능 여부를 startup probe로 재검증한다.
8. recovery 후 event/Dashboard revision이 정확히 한 번 증가하는지 확인한다.

## 필수 검증

- API restart
- DB listener reconnect
- Spark restart
- Docker daemon restart
- EC2 reboot 또는 동등 clean host
- partial publication failure

## 완료 기준

- [ ] 수동 SSH/chown 없이 복구된다.
- [ ] 브라우저는 reconnect 또는 fallback으로 최신 상태를 회복한다.
- [ ] output duplicate와 event duplicate가 없다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 원본 세부 작업 — 35 — Performance·Security Verification Codex 프롬프트

## 목표

SSE connection과 continuous JOIN이 요청·메모리·query 비용을 폭증시키지 않고 보안 경계를 지키는지 확인한다.

## Codex에 전달할 지시

반드시 이 팩의 `00_MASTER_CONTROL.md`, `WORK_STATUS.md`, 현재 PR 문서와 저장소의 제품·아키텍처·API·배포 문서를 먼저 읽어라. 경로와 기술 선택을 추측하지 말고 현재 코드에서 확인한다. 이 원본 세부 작업은 현재 PR 안에서 이어서 수행하며, 다른 PR 문서로 넘어가지 않는다.

## 먼저 조사할 것

- 예상 동시 사용자와 tab 수
- API worker memory/FD limit
- event rate와 Dashboard query cost
- static Dataset size distribution
- security scanner와 threat model 문서

## 구현 작업

1. 현실적인 synthetic SSE connection 수로 memory/FD/CPU baseline을 측정한다.
2. event storm에서 coalescing과 Dashboard refetch rate를 측정한다.
3. slow client와 replay abuse에 rate/limit가 적용되는지 확인한다.
4. 큰 static table에서 broadcast가 강제되지 않고 join strategy가 안전한지 확인한다.
5. batch trigger와 Iceberg commit 빈도가 metadata/small-file 문제를 만들지 평가한다.
6. tenant enumeration, cursor guessing, ticket replay, event injection, log leakage를 threat test한다.
7. SSE endpoint의 CSRF/CORS/cookie 정책과 REST mutation CSRF를 구분한다.
8. 부하 목표를 baseline과 실제 instance size에 맞게 문서화한다.

## 필수 검증

- connection ramp-up/ramp-down
- 1 client event burst와 N client fan-out
- replay page limit
- tenant isolation 공격
- large static join sample
- Dashboard query throttle

## 완료 기준

- [ ] 설정된 한도에서 process가 안정적이다.
- [ ] 요청 폭주와 메모리 무한 증가가 없다.
- [ ] 장기 credential과 tenant data leakage가 없다.

이 세부 작업의 완료 여부와 검증 증거를 현재 PR 결과 문서에 누적한다. 같은 PR 파일의 다음 세부 작업은 계속 수행하되, 다른 PR로 넘어가지 않는다.


---

## 최종 확인

현재 PR의 모든 세부 체크리스트를 확인한 뒤 결과를 남긴다. 다음 단계는 사용자가 `다음 단계 진행해`라고 말할 때만 시작한다.
